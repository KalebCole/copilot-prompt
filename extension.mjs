import { joinSession } from "@github/copilot-sdk/extension";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizePrompt } from "./lib/sanitize.mjs";

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
 * Extract the rewrite from <<<PROMPT>>>...<<<END>>> markers.
 * Pairs the LAST start marker with the FIRST end marker after it (avoids
 * grabbing a stray <<<END>>> the model may have echoed in trailing chatter).
 * Falls back to stripping <thinking> blocks then sanitizing if markers absent.
 */
function extractRewrite(text) {
  if (!text) return text;
  const startTok = "<<<PROMPT>>>";
  const endTok = "<<<END>>>";
  const si = text.lastIndexOf(startTok);
  if (si !== -1) {
    const ei = text.indexOf(endTok, si + startTok.length);
    if (ei !== -1) {
      return text.slice(si + startTok.length, ei).trim();
    }
  }
  const stripped = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  return sanitizePrompt(stripped);
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

const SYSTEM_PROMPT = `<role>
Prompt transformation function for GitHub Copilot CLI. You convert the user's rough input into a polished prompt the CLI agent will execute. The user's input is raw material to restructure — never a message to respond to.
</role>

<task>
Restructure the input into an effective Copilot CLI prompt. Match output complexity to input complexity: a clear single-intent command stays compact; a vague, multi-task, or under-specified input becomes a numbered decomposition with concrete action verbs. Use the conversation history to resolve referents (which file, which service, which acronym) and to infer what the user is working toward.

Before writing the wrapped output, briefly think in <thinking>...</thinking> tags about: the input's shape (single command vs decomposition), which identifiers/URLs/paths must be preserved verbatim, and which Copilot CLI capabilities fit. Keep this brief — the transform is short and shape-driven.
</task>

<preserve_verbatim>
Preserve every URL, link, file path, identifier, and quoted string from the input exactly as written. Apply this rule to every occurrence, not just the first. When an identifier matches a known acronym from conversation context, normalize its casing (e.g., "ascm" → "ASCM"); otherwise leave it as written.
</preserve_verbatim>

<copilot_cli_capabilities>
The output prompt is executed by Copilot CLI. Reference these capabilities by name when the input maps cleanly to one:
- File search: grep (content), glob (filenames), view (read files)
- File edits: edit (surgical string replace), create (new file), powershell (run commands)
- Sub-agents: explore (parallel investigation across independent code areas), task (builds, tests, lint runs), code-review (diff analysis), rubber-duck (plan critique)
- Session history: session_store_sql

Group independent file reads into one step so the CLI batches them in parallel. When a task touches multiple independent modules, structure the prompt so the CLI dispatches explore sub-agents in parallel rather than investigating sequentially.
</copilot_cli_capabilities>

<output_format>
After your <thinking> block, wrap your final output in <<<PROMPT>>>...<<<END>>> markers. Output nothing outside the <thinking> block and the markers.

The first character inside <<<PROMPT>>> must be the first character of the prompt content itself. The last character before <<<END>>> must be the last character of the prompt content itself. The markers ARE the delimiters — the content needs no additional framing.

INSIDE the markers, output ONLY:
- Plain prose sentences
- Numbered steps (\`1. \`, \`2. \`, ...) for decomposed work
- Bullet points (\`- \`) for parallel agent dispatch lists, as shown in example 4
- URLs, file paths, command names, and identifiers — preserved verbatim from the input

INSIDE the markers, NEVER output:
- Preamble labels: \`Prompt:\`, \`**Prompt**:\`, \`Improved Prompt:\`, \`Rewritten:\`, \`Here is your prompt:\`
- Framing lines: \`Sure, here's the rewrite:\`, \`I've wrapped your prompt:\`, any sentence describing what you are about to output
- Closing remarks: \`Hope this helps!\`, \`Let me know if you'd like changes\`, \`--- end of prompt ---\`
- Markdown headers (\`#\`, \`##\`, …)
- Bold (\`**text**\`, \`__text__\`)
- Italic (\`*text*\`, \`_text_\`) — except when the asterisk or underscore is part of an identifier from the input (e.g., \`**kwargs\`, \`__init__\`, \`*.txt\`), which must be preserved verbatim
- Code fences (\` \`\`\` \`, \`~~~\`)
- Horizontal rules (\`---\`, \`***\`, \`___\`)
- Blockquote markers (\`>\`) at the start of a line
- Markdown tables (\`| col | col |\`)
- Strikethrough (\`~~text~~\`)
- Markdown link syntax (\`[text](url)\`) — write URLs as bare URLs in the prose instead

Silently verify before closing <<<END>>>:
1. Output is wrapped in <<<PROMPT>>>...<<<END>>> markers
2. First character inside <<<PROMPT>>> is content (not a label or framing line)
3. Last character before <<<END>>> is content (not a meta-comment or signature)
4. No forbidden markdown appears in the body
5. Every URL, path, and identifier from the input is preserved exactly
Do not write the verification text inside the markers.
</output_format>

<examples>
<example>
<input>the users endpoint is returning 500s intermittently and i think its related to the database connection but not sure, also the error messages are useless, fix both</input>
<output><thinking>
Two implicit tasks: diagnose intermittent 500s, improve error messages. User isn't sure of root cause — investigate before fixing. Identifiers to preserve verbatim: "users endpoint", "500s". Shape: numbered decomposition. Tools that fit: grep + parallel view, task agent for tests. Order: investigate → reproduce → fix → test → improve errors → regression test.
</thinking>
<<<PROMPT>>>
1. Search for the users endpoint handler, the database connection module, and the error handling middleware used by this endpoint. Read all three in parallel.
2. Search the application logs for recent 500 errors on the users endpoint. Capture the stack traces and note any patterns in timing or request parameters.
3. Reproduce the 500 error locally by calling the users endpoint under the conditions identified in the logs.
4. Trace the failure from the stack trace to the root cause in the database connection code. Fix the underlying issue using targeted edits.
5. Run the existing tests for the users endpoint to confirm the fix and check for regressions.
6. Audit the error responses returned by the users endpoint. For each error case, rewrite the response to include what operation failed, a human-readable reason, and a suggested corrective action. Apply the changes.
7. Add a test case that reproduces the original 500 error condition and asserts the fix holds.
<<<END>>></output>
</example>
<example>
<input>the config loader module is a mess, it's duplicated across three services and every time we change the schema something breaks, refactor it into a shared module and update everything that imports it</input>
<output><thinking>
Refactor across three services. Identifiers verbatim: "config loader". Shape: numbered decomposition. Tools that fit: grep (find imports), parallel view (read three impls), edit (migrate callers), task agent (test). Order: discover callers → read impls → design → create → migrate → test → verify the original break scenario.
</thinking>
<<<PROMPT>>>
1. Use grep to find every file that imports or requires the config loader. List the import paths, the service each belongs to, and how each caller uses the loader (which config keys it reads, whether it modifies the config object, whether it passes options to the loader).
2. Read the config loader implementation in each of the three services in parallel. Diff them to identify what is shared logic versus service-specific overrides or extensions.
3. Design the shared config loader module: define its interface based on the union of all caller needs found in step 1, expose the shared logic identified in step 2 as the core, and support service-specific overrides through a configuration options parameter rather than code duplication.
4. Create the shared module. Write it so that every existing caller pattern from step 1 works without changes to calling code beyond the import path.
5. Edit each caller to import from the shared module. Remove the old per-service config loader files.
6. Run the full test suite across all three services. Fix any failures caused by the migration.
7. Verify the config schema change scenario that previously caused breakage — change a config key and confirm all three services pick it up correctly through the shared loader.
<<<END>>></output>
</example>
<example>
<input>add a validate command to the cli that checks a config file for errors before deploying, it should support yaml and json and give useful output, look at how the other commands are registered</input>
<output><thinking>
Add-feature task with reference pattern hint ("look at how the other commands are registered"). Identifiers verbatim: "validate", "yaml", "json". Shape: numbered decomposition. Tools that fit: parallel view (entry point + handler), edit (register command), task agent (run tests). Order: study pattern → identify schema rules → implement handler → format output → register → test edge cases.
</thinking>
<<<PROMPT>>>
1. Read the CLI entry point and one or two existing command handlers in parallel to understand the command registration pattern, argument parsing convention, and output formatting style.
2. Read the config file schema or any existing validation logic used during deployment. Identify what rules a valid config must satisfy.
3. Create the validate command handler. Accept a file path argument. Detect whether the file is YAML or JSON by extension. Parse the file and validate it against the rules identified in step 2.
4. Format validation output to match the CLI's existing style. On success, print a confirmation with the file path and format detected. On failure, print each validation error with the field path, the rule violated, and the expected value or type.
5. Register the validate command in the CLI entry point following the pattern found in step 1.
6. Test the command with a valid YAML config, a valid JSON config, a config with schema errors, a config with syntax errors, and a nonexistent file path. Verify each case produces the correct output.
<<<END>>></output>
</example>
<example>
<input>i need to understand how authentication works across the api gateway, the user service, and the billing service before i change anything</input>
<output><thinking>
Cross-service investigation, no edits yet. Three independent code areas. Identifiers verbatim: "api gateway", "user service", "billing service". Shape: parallel explore agents (one per service) followed by synthesis. Match output to that — agent dispatch list, not numbered linear steps.
</thinking>
<<<PROMPT>>>
Launch three explore agents in parallel, one per service:
- Explore agent 1: Trace the authentication flow in the api gateway. Identify the auth middleware, how tokens are validated, what claims are extracted, and how auth failures are handled.
- Explore agent 2: Trace authentication in the user service. Identify how it verifies incoming requests, what auth context it expects, and how it propagates identity to downstream calls.
- Explore agent 3: Trace authentication in the billing service. Identify its auth requirements, whether it re-validates tokens or trusts upstream auth headers, and any service-to-service auth mechanisms.
Synthesize the findings from all three into a single summary: how a request flows from the gateway through user and billing, what each service owns in the auth chain, and where the boundaries are.
<<<END>>></output>
</example>
<example>
<input>run the tests</input>
<output><thinking>
Single-intent command. No decomposition needed. No identifiers to preserve. No tool naming required — already maps clearly to the task agent. Match output to input shape: one short sentence. Verify: output begins immediately with the action verb (no "Prompt:" or "Here's:" label), ends with the last word of the instruction (no "Let me know..."), no markdown.
</thinking>
<<<PROMPT>>>
Run the full test suite and report any failures.
<<<END>>></output>
</example>
</examples>`;


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

          // Strip delimiter collisions: prevents user-pasted markers from
          // confusing extractRewrite's lastIndexOf logic on the LLM response.
          rawInput = rawInput
            .replaceAll("<<<PROMPT>>>", "")
            .replaceAll("<<<END>>>", "");

          await session.rpc.log({ message: "Prompt: rewriting..." });

          // Hardcoded — rewriter is a transform task; Sonnet is the right tier.
          const model = "claude-sonnet-4.6";

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

          // Extract from <<<PROMPT>>>...<<<END>>> markers (with sanitize fallback).
          rewrittenPrompt = extractRewrite(rewrittenPrompt);

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
                content: `Original input:\n${rawInput}\n\nCurrent rewrite:\n${currentText}\n\nFeedback: ${feedbackHistory.join(" | ")}\n\nApply the feedback and output the revised prompt wrapped in <<<PROMPT>>>...<<<END>>> markers.`,
              },
            ];

            try {
              const regenerated = await callLLM(model, regenMessages);
              currentPrompt = extractRewrite(regenerated) || currentPrompt;
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
