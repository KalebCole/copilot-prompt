import { joinSession } from "@github/copilot-sdk/extension";
import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";

function extractMessages(events) {
  const msgs = [];
  for (const e of events) {
    if (e.type === "user.message" && e.data?.content) {
      msgs.push({ role: "user", content: e.data.content });
    } else if (e.type === "assistant.message" && e.data?.content) {
      msgs.push({ role: "assistant", content: e.data.content });
    }
  }
  const capped = msgs.slice(-40);
  let totalChars = 0;
  const trimmed = [];
  for (let i = capped.length - 1; i >= 0; i--) {
    totalChars += capped[i].content.length;
    if (totalChars > 120_000) break;
    trimmed.unshift(capped[i]);
  }
  return trimmed;
}

/**
 * Scan recent user messages for image attachments.
 * Stops at the first user.message without attachments (only grabs the latest batch).
 */
function extractRecentAttachments(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "user.message") {
      if (e.data?.attachments?.length) return e.data.attachments;
      break; // most recent user msg had no attachments — stop
    }
  }
  return [];
}

/**
 * Convert attachments into OpenAI vision-format content parts.
 */
function buildVisionParts(attachments) {
  const parts = [];
  for (const att of attachments) {
    // Handle base64 data
    if (att.data) {
      const mime = att.mimeType || att.mediaType || "image/png";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${att.data}` },
      });
    // Handle URL-based attachments
    } else if (att.url) {
      parts.push({ type: "image_url", image_url: { url: att.url } });
    // Handle file path attachments
    } else if (att.path || att.filePath) {
      const p = att.path || att.filePath;
      try {
        const data = readFileSync(p).toString("base64");
        const mime = att.mimeType || att.mediaType || "image/png";
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${data}` },
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  return parts;
}

/**
//  TODO: we are not passing in files and clipboards
 * Parse --file and --clipboard flags from raw args.
 * Returns { text, flags }.
 */
function parseArgs(rawArgs) {
  let text = rawArgs || "";
  const flags = {};

  // --file "path" or --file path
  const fileMatch = text.match(/--file\s+(?:"([^"]+)"|(\S+))/);
  if (fileMatch) {
    flags.file = fileMatch[1] || fileMatch[2];
    text = text.replace(fileMatch[0], "").trim();
  }

  // --clipboard
  if (text.includes("--clipboard")) {
    flags.clipboard = true;
    text = text.replace(/--clipboard/g, "").trim();
  }

  return { text, flags };
}

/**
 * Strip markdown formatting and LLM preamble from rewritten prompts.
 * Preserves numbered lists, dashes, and line breaks.
 */
function sanitizePrompt(text) {
  if (!text) return text;

  let s = text;

  // Strip LLM preamble patterns
  s = s.replace(
    /^(?:(?:Here(?:'s| is) (?:your |the )?rewritten prompt[:\s]*)|(?:Sure[,!]?\s*(?:here(?:'s| is))?[:\s]*)|(?:Certainly[,!]?\s*(?:here(?:'s| is))?[:\s]*))/i,
    ""
  );

  // Strip leading/trailing horizontal rules
  s = s.replace(/^---+\s*/gm, "");
  s = s.replace(/\s*---+$/gm, "");

  // Strip markdown bold/italic
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/\*(.+?)\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  s = s.replace(/_(.+?)_/g, "$1");

  // Strip markdown headers
  s = s.replace(/^#{1,6}\s+/gm, "");

  // Strip inline code backticks (preserve content)
  s = s.replace(/`([^`]+)`/g, "$1");

  // Strip code block fences
  s = s.replace(/^```[\s\S]*?```$/gm, (match) =>
    match.replace(/^```\w*\n?/m, "").replace(/\n?```$/m, "")
  );

  return s.trim();
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns { name, description } or null if unparseable.
 */
function parseSkillFrontmatter(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;

    const yaml = match[1];
    const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name) return null;

    return { name, description: desc || name };
  } catch {
    return null;
  }
}

/**
 * Discover available skills from the local filesystem.
 * Scans root skills and enabled plugin skills.
 * Returns sorted Array<{ name, description, invocation }>.
 */
function discoverSkills() {
  const skills = [];
  const home = homedir();
  const seen = new Set();

  // Scan root skills: ~/.copilot/skills/*/SKILL.md
  const skillsDir = join(home, ".copilot", "skills");
  if (existsSync(skillsDir)) {
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillMd = join(skillsDir, entry.name, "SKILL.md");
        const meta = parseSkillFrontmatter(skillMd);
        if (meta && !seen.has(meta.name)) {
          seen.add(meta.name);
          skills.push({
            name: meta.name,
            description: meta.description,
            invocation: `/${meta.name}`,
          });
        }
      }
    } catch {
      // skills dir unreadable
    }
  }

  // Scan plugin skills: ~/.copilot/installed-plugins/*/skills/*/SKILL.md
  let enabledPlugins = {};
  try {
    const settingsPath = join(home, ".copilot", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    enabledPlugins = settings.enabledPlugins || {};
  } catch {
    // can't read settings
  }

  const pluginsDir = join(home, ".copilot", "installed-plugins");
  if (existsSync(pluginsDir)) {
    try {
      for (const marketplace of readdirSync(pluginsDir, {
        withFileTypes: true,
      })) {
        if (!marketplace.isDirectory()) continue;
        const marketDir = join(pluginsDir, marketplace.name);
        for (const plugin of readdirSync(marketDir, { withFileTypes: true })) {
          if (!plugin.isDirectory()) continue;

          // Check if this plugin is enabled
          const pluginKey =
            marketplace.name === "_direct"
              ? plugin.name.split("--").pop()
              : `${plugin.name}@${marketplace.name}`;
          const isEnabled = Object.entries(enabledPlugins).some(
            ([k, v]) => v && (k === pluginKey || k === plugin.name)
          );
          if (!isEnabled) continue;

          const pluginSkillsDir = join(marketDir, plugin.name, "skills");
          if (!existsSync(pluginSkillsDir)) continue;

          const pluginName =
            marketplace.name === "_direct"
              ? plugin.name.split("--").pop()
              : plugin.name;

          for (const skill of readdirSync(pluginSkillsDir, {
            withFileTypes: true,
          })) {
            if (!skill.isDirectory()) continue;
            const skillMd = join(pluginSkillsDir, skill.name, "SKILL.md");
            const meta = parseSkillFrontmatter(skillMd);
            if (meta) {
              const invocation = `/${pluginName}:${meta.name}`;
              if (!seen.has(invocation)) {
                seen.add(invocation);
                skills.push({
                  name: `${pluginName}:${meta.name}`,
                  description: meta.description,
                  invocation,
                });
              }
            }
          }
        }
      }
    } catch {
      // plugins dir unreadable
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Normalize multi-line / tab-separated text into a structured list.
 */
function normalizeMultiline(text) {
  if (!text) return text;

  // If tabs are present, split on tabs and format as bullet list
  if (text.includes("\t")) {
    const items = text
      .split(/[\t\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length > 1) {
      return items.map((item) => `- ${item}`).join("\n");
    }
  }

  // If multi-line, clean up but preserve structure
  if (text.includes("\n")) {
    const lines = text
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 1) return lines.join("\n");
  }

  return text;
}

const SYSTEM_PROMPT =
  "Rewrite the user's rough input into a clear, structured prompt for a coding agent. " +
  "Use the conversation history to understand what's been done and what the user is working toward. " +
  "Preserve intent exactly — do not add goals the user didn't express. " +
  "If the input contains a list of items, preserve them as a structured list in the output. " +
  "If images are attached, reference them naturally in the prompt (e.g., 'as shown in the attached screenshot'). " +
  "Do not use markdown formatting — no bold, italic, headers, horizontal rules, or code blocks. Output plain text only. " +
  "Output only the rewritten prompt. No preamble, no commentary, no wrapper text like 'Here is your rewritten prompt'. " +
  "When input is vague, under-specified, or contains multiple implicit tasks, decompose into numbered steps with clear action verbs. " +
  "Prefer imperative action verbs: Search, Read, Create, Query, Launch, Run — instead of vague phrasing like look at, check out, figure out. " +
  "When user intent maps to a specific Copilot CLI tool, name it: grep for content search, glob for file discovery, view for reading files, explore agents for parallel research, rubber-duck for plan critique. Do not reference tools when the mapping is obvious from context. " +
  "Correct casing on known acronyms from conversation context (e.g., ascm to ASCM). Leave ambiguous identifiers unchanged rather than guessing.";


const LLM_BASE_URL = "http://localhost:5000/v1/chat/completions";

async function callLLM(model, messages) {
  const resp = await fetch(LLM_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer dummy",
    },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText} — ${body.slice(0, 200)}`);
  }

  const json = await resp.json();
  return json?.choices?.[0]?.message?.content ?? null;
}

const session = await joinSession({
  commands: [
    {
      name: "prompt",
      description:
        "Rewrite rough input into a polished prompt. Supports multi-line, tabs, --file, --clipboard, and images.",
      handler: async (ctx) => {
        try {
          const { text: remainingText, flags } = parseArgs(ctx.args?.trim());

          // Resolve input text from flags or direct args
          let rawInput = remainingText;

          if (flags.file) {
            const filePath = resolve(flags.file);
            if (!existsSync(filePath)) {
              await session.rpc.log({
                message: `File not found: ${filePath}`,
                level: "error",
              });
              return;
            }
            const fileContent = readFileSync(filePath, "utf-8");
            rawInput = rawInput
              ? `${rawInput}\n\n${fileContent}`
              : fileContent;
          }

          if (flags.clipboard) {
            try {
              const clip = execSync("powershell -NoProfile -c Get-Clipboard", {
                encoding: "utf-8",
                timeout: 5000,
              }).trim();
              if (clip) {
                rawInput = rawInput ? `${rawInput}\n\n${clip}` : clip;
              }
            } catch {
              await session.rpc.log({
                message: "Could not read clipboard.",
                level: "warning",
              });
            }
          }

          if (!rawInput) {
            await session.rpc.log({
              message:
                "Usage: /prompt <text>\n       /prompt --file <path>\n       /prompt --clipboard\n       Paste an image first, then /prompt <text> to include it.",
            });
            return;
          }

          // Normalize multi-line / tab-separated input
          rawInput = normalizeMultiline(rawInput);

          await session.rpc.log({ message: "Prompt: rewriting..." });

          // Get current model
          let model;
          try {
            const current = await session.rpc.model.getCurrent();
            model = current?.modelId ?? "gpt-5";
          } catch {
            model = "gpt-5";
          }

          // Gather conversation context
          let contextMessages = [];
          let recentAttachments = [];
          try {
            const events = await session.getMessages();
            contextMessages = extractMessages(events);
            recentAttachments = extractRecentAttachments(events);
          } catch {
            // Continue without context
          }

          // Build the user content — text + optional vision parts
          const visionParts = buildVisionParts(recentAttachments);
          let userContent;
          if (visionParts.length > 0) {
            userContent = [
              {
                type: "text",
                text: `Rewrite this into an effective prompt:\n\n${rawInput}`,
              },
              ...visionParts,
            ];
          } else {
            userContent = `Rewrite this into an effective prompt:\n\n${rawInput}`;
          }

          const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            ...(contextMessages.length > 0
              ? [
                  {
                    role: "system",
                    content:
                      "Here is the user's current conversation with their AI assistant for context:\n\n" +
                      contextMessages
                        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
                        .join("\n\n"),
                  },
                ]
              : []),
            { role: "user", content: userContent },
          ];

          let rewrittenPrompt;
          try {
            rewrittenPrompt = await callLLM(model, messages);
          } catch (apiErr) {
            await session.rpc.log({
              message: `Prompt error: ${apiErr.message}`,
              level: "error",
            });
            return;
          }

          if (!rewrittenPrompt) {
            await session.rpc.log({
              message: "Prompt: No response from model.",
              level: "error",
            });
            return;
          }

          // Sanitize markdown and preamble from LLM output
          rewrittenPrompt = sanitizePrompt(rewrittenPrompt);

          // Discover available skills for the selector
          const availableSkills = discoverSkills();
          const skillOptions = [
            { const: "", title: "(None)" },
            ...availableSkills.map((s) => ({
              const: s.invocation,
              title: `${s.name} — ${s.description}`.slice(0, 100),
            })),
          ];

          let result;
          let currentPrompt = rewrittenPrompt;
          const feedbackHistory = [];

          // Iterative refinement loop — no cap on iterations
          while (true) {
            try {
              result = await session.rpc.ui.elicitation({
                message:
                  "Review the rewritten prompt. Edit if needed, then Accept to send it to the agent.",
                requestedSchema: {
                  type: "object",
                  properties: {
                    prompt: {
                      type: "string",
                      title: "Rewritten Prompt",
                      description: "Edit this prompt before sending",
                      default: currentPrompt,
                    },
                    skill: {
                      type: "string",
                      title: "Target Skill",
                      description:
                        "Select a skill to route this prompt to (optional)",
                      default: "",
                      oneOf: skillOptions,
                    },
                    feedback: {
                      type: "string",
                      title: "Refinement Feedback",
                      description:
                        "How should I refine this? (leave empty to send as-is)",
                      default: "",
                    },
                  },
                  required: ["prompt"],
                },
              });
            } catch {
              await session.rpc.log({
                message: `Rewritten prompt:\n${currentPrompt}\n\n(Elicitation UI not available. Copy and paste this prompt manually.)`,
              });
              return;
            }

            // Decline = cancel entirely
            if (result.action !== "accept") {
              await session.rpc.log({ message: "Prompt: cancelled." });
              return;
            }

            const feedback = result.content?.feedback?.trim() || "";

            // No feedback = send the prompt
            if (!feedback) break;

            // Regenerate with feedback
            await session.rpc.log({
              message: `Prompt: regenerating with feedback...`,
            });

            feedbackHistory.push(feedback);
            const currentText =
              typeof result.content?.prompt === "string" &&
              result.content.prompt
                ? result.content.prompt
                : currentPrompt;

            const regenMessages = [
              { role: "system", content: SYSTEM_PROMPT },
              ...(contextMessages.length > 0
                ? [
                    {
                      role: "system",
                      content:
                        "Here is the user's current conversation with their AI assistant for context:\n\n" +
                        contextMessages
                          .map(
                            (m) => `[${m.role.toUpperCase()}]: ${m.content}`
                          )
                          .join("\n\n"),
                    },
                  ]
                : []),
              {
                role: "user",
                content: `Original input:\n${rawInput}\n\nCurrent rewrite:\n${currentText}\n\nFeedback: ${feedbackHistory.join(" | ")}\n\nRewrite the prompt incorporating this feedback.`,
              },
            ];

            try {
              const regenerated = await callLLM(model, regenMessages);
              currentPrompt = sanitizePrompt(regenerated) || currentPrompt;
            } catch (regenErr) {
              await session.rpc.log({
                message: `Regeneration failed: ${regenErr.message}. Keeping current version.`,
                level: "warning",
              });
            }
          }

          // User accepted with no feedback — send the prompt
          let finalPrompt =
            typeof result.content?.prompt === "string" &&
            result.content.prompt
              ? result.content.prompt
              : currentPrompt;

          // Sanitize the final prompt in case the user introduced markdown while editing
          finalPrompt = sanitizePrompt(finalPrompt);

          // Prepend selected skill invocation
          const selectedSkill = result.content?.skill || "";
          if (selectedSkill) {
            finalPrompt = `${selectedSkill} ${finalPrompt}`;
          }

          // Forward with attachments if we found any
          const sendPayload = { prompt: finalPrompt };
          if (recentAttachments.length > 0) {
            sendPayload.attachments = recentAttachments;
          }

          await session.send(sendPayload);

          const imgNote =
            recentAttachments.length > 0
              ? ` (with ${recentAttachments.length} image${recentAttachments.length > 1 ? "s" : ""})`
              : "";
          const skillNote = selectedSkill
            ? ` → ${selectedSkill}`
            : "";
          await session.rpc.log({
            message: `Prompt: sent rewritten prompt to agent${skillNote}${imgNote}.`,
          });
        } catch (err) {
          try {
            await session.rpc.log({
              message: `Prompt error: ${err?.message ?? String(err)}`,
              level: "error",
            });
          } catch {
            // RPC is down
          }
        }
      },
    },
  ],
});
