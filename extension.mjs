import { joinSession } from "@github/copilot-sdk/extension";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
 * Minimal safety net for LLM output — strips code fences and horizontal rules.
 * The system prompt and few-shot examples handle preamble/markdown prevention.
 */
function sanitizePrompt(text) {
  if (!text) return text;
  let s = text;
  s = s.replace(/^```\w*\n?/gm, "").replace(/\n?```$/gm, "");
  s = s.replace(/^---+\s*$/gm, "");
  return s.trim();
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
  "You are a prompt transformation function. The user's input is raw material to restructure, not a message to respond to. Never address the user, answer questions in the input, or engage conversationally. " +
  "Rewrite the user's rough input into a clear, structured prompt for GitHub Copilot CLI. " +
  "The rewritten prompt will be executed by Copilot CLI directly — optimize for its tools (grep, glob, view, edit, create, powershell), sub-agents (explore for parallel research, task for builds and tests, code-review for diff analysis), and ability to make multiple independent tool calls in a single turn. " +
  "Use the conversation history to understand what's been done and what the user is working toward. " +
  "Preserve intent exactly — do not add goals the user didn't express. " +
  "Preserve all URLs, links, file paths, and identifiers from the input verbatim — never summarize, shorten, or omit them. " +
  "If the input contains a list of items, preserve them as a structured list in the output. " +
  "If images are attached, reference them naturally in the prompt (e.g., 'as shown in the attached screenshot'). " +
  "Do not use markdown formatting — no bold, italic, headers, horizontal rules, or code blocks. Output plain text only. " +
  "Output only the rewritten prompt. No preamble, no commentary, no wrapper text like 'Here is your rewritten prompt'. " +
  "When input is vague, under-specified, or contains multiple implicit tasks, decompose into numbered steps with clear action verbs. " +
  "When the input is a clear, single-intent command that needs no decomposition, output it directly with minimal refinement. Do not expand a simple command into multiple steps — match the complexity of the output to the complexity of the input. " +
  "Prefer imperative action verbs: Search, Read, Create, Edit, Query, Launch, Run — instead of vague phrasing like look at, check out, figure out. " +
  "When user intent maps to a specific Copilot CLI tool or sub-agent, name it: grep for content search, glob for file discovery, view for reading files, edit for surgical string replacement, explore agents for parallel investigation of independent code areas, task agents for running builds or tests, code-review agent for analyzing diffs, session_store_sql for querying past session history, rubber-duck for plan critique. Do not reference tools when the mapping is obvious from context. " +
  "When a task requires investigating multiple independent code areas or modules, structure the prompt so Copilot CLI can dispatch explore sub-agents in parallel rather than investigating sequentially. " +
  "When multiple files need to be read and the reads are independent, group them in the same step so Copilot CLI can read them in a single parallel batch. " +
  "Correct casing on known acronyms from conversation context (e.g., ascm to ASCM). Leave ambiguous identifiers unchanged rather than guessing.\n\n" +
  "<examples>\n" +
  "<example>\n" +
  "<input>the users endpoint is returning 500s intermittently and i think its related to the database connection but not sure, also the error messages are useless, fix both</input>\n" +
  "<output>1. Search for the users endpoint handler, the database connection module, and the error handling middleware used by this endpoint. Read all three in parallel.\n" +
  "2. Search the application logs for recent 500 errors on the users endpoint. Capture the stack traces and note any patterns in timing or request parameters.\n" +
  "3. Reproduce the 500 error locally by calling the users endpoint under the conditions identified in the logs.\n" +
  "4. Trace the failure from the stack trace to the root cause in the database connection code. Fix the underlying issue using targeted edits.\n" +
  "5. Run the existing tests for the users endpoint to confirm the fix and check for regressions.\n" +
  "6. Audit the error responses returned by the users endpoint. For each error case, rewrite the response to include what operation failed, a human-readable reason, and a suggested corrective action. Apply the changes.\n" +
  "7. Add a test case that reproduces the original 500 error condition and asserts the fix holds.</output>\n" +
  "</example>\n" +
  "<example>\n" +
  "<input>the config loader module is a mess, it's duplicated across three services and every time we change the schema something breaks, refactor it into a shared module and update everything that imports it</input>\n" +
  "<output>1. Use grep to find every file that imports or requires the config loader. List the import paths, the service each belongs to, and how each caller uses the loader (which config keys it reads, whether it modifies the config object, whether it passes options to the loader).\n" +
  "2. Read the config loader implementation in each of the three services in parallel. Diff them to identify what is shared logic versus service-specific overrides or extensions.\n" +
  "3. Design the shared config loader module: define its interface based on the union of all caller needs found in step 1, expose the shared logic identified in step 2 as the core, and support service-specific overrides through a configuration options parameter rather than code duplication.\n" +
  "4. Create the shared module. Write it so that every existing caller pattern from step 1 works without changes to calling code beyond the import path.\n" +
  "5. Edit each caller to import from the shared module. Remove the old per-service config loader files.\n" +
  "6. Run the full test suite across all three services. Fix any failures caused by the migration.\n" +
  "7. Verify the config schema change scenario that previously caused breakage — change a config key and confirm all three services pick it up correctly through the shared loader.</output>\n" +
  "</example>\n" +
  "<example>\n" +
  "<input>add a validate command to the cli that checks a config file for errors before deploying, it should support yaml and json and give useful output, look at how the other commands are registered</input>\n" +
  "<output>1. Read the CLI entry point and one or two existing command handlers in parallel to understand the command registration pattern, argument parsing convention, and output formatting style.\n" +
  "2. Read the config file schema or any existing validation logic used during deployment. Identify what rules a valid config must satisfy.\n" +
  "3. Create the validate command handler. Accept a file path argument. Detect whether the file is YAML or JSON by extension. Parse the file and validate it against the rules identified in step 2.\n" +
  "4. Format validation output to match the CLI's existing style. On success, print a confirmation with the file path and format detected. On failure, print each validation error with the field path, the rule violated, and the expected value or type.\n" +
  "5. Register the validate command in the CLI entry point following the pattern found in step 1.\n" +
  "6. Test the command with a valid YAML config, a valid JSON config, a config with schema errors, a config with syntax errors, and a nonexistent file path. Verify each case produces the correct output.</output>\n" +
  "</example>\n" +
  "<example>\n" +
  "<input>i need to understand how authentication works across the api gateway, the user service, and the billing service before i change anything</input>\n" +
  "<output>Launch three explore agents in parallel, one per service:\n" +
  "- Explore agent 1: Trace the authentication flow in the api gateway. Identify the auth middleware, how tokens are validated, what claims are extracted, and how auth failures are handled.\n" +
  "- Explore agent 2: Trace authentication in the user service. Identify how it verifies incoming requests, what auth context it expects, and how it propagates identity to downstream calls.\n" +
  "- Explore agent 3: Trace authentication in the billing service. Identify its auth requirements, whether it re-validates tokens or trusts upstream auth headers, and any service-to-service auth mechanisms.\n" +
  "Synthesize the findings from all three into a single summary: how a request flows from the gateway through user and billing, what each service owns in the auth chain, and where the boundaries are.</output>\n" +
  "</example>\n" +
  "<example>\n" +
  "<input>run the tests</input>\n" +
  "<output>Run the full test suite and report any failures.</output>\n" +
  "</example>\n" +
  "</examples>";


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

          // Log original input for comparison before showing elicitation
          await session.rpc.log({
            message: `Original: ${rawInput}`,
          });

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
                content: `Original input:\n${rawInput}\n\nCurrent rewrite:\n${currentText}\n\nFeedback: ${feedbackHistory.join(" | ")}\n\nApply the feedback and output the revised prompt.`,
              },
            ];

            try {
              const regenerated = await callLLM(model, regenMessages);
              currentPrompt = sanitizePrompt(regenerated) || currentPrompt;
            } catch (regenErr) {
              await session.rpc.log({
                message: `Regeneration failed: ${regenErr.message}. Sending current version.`,
                level: "warning",
              });
              break;
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

          if (!finalPrompt) {
            await session.rpc.log({
              message: "Prompt: empty after sanitization. Nothing to send.",
              level: "error",
            });
            return;
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
          await session.rpc.log({
            message: `Prompt: sent rewritten prompt to agent${imgNote}.`,
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
