# /prompt — Copilot CLI prompt rewriter

A Copilot CLI slash command that rewrites your rough request into a
structured prompt **in a context-isolated side conversation**, so the
rewriter's noise never enters your main agent's context.

## Why

Before `/prompt`, every "rewrite this more carefully" and every prompt-
engineering aside leaked into the parent agent's working memory. Now the
rewriting happens inside a task-local conversation: the parent only ever
sees the final polished prompt.

## Install

Prerequisite: GitHub Copilot CLI installed and signed in.

PowerShell:
```pwsh
# Remove any prior install first to avoid stale files
Remove-Item -Recurse -Force ~/.copilot/extensions/prompt -ErrorAction SilentlyContinue

git clone https://github.com/<owner>/<this-repo>
New-Item -ItemType Directory -Force ~/.copilot/extensions | Out-Null
Copy-Item -Recurse <this-repo>/extensions/prompt ~/.copilot/extensions/prompt
```

Or, if you already have the repo cloned somewhere:
```pwsh
Remove-Item -Recurse -Force ~/.copilot/extensions/prompt -ErrorAction SilentlyContinue
Copy-Item -Recurse <local-clone>/extensions/prompt ~/.copilot/extensions/prompt
```

Restart Copilot CLI, or run `/clear` in an existing session, to pick up
the extension. Verify:
```
/prompt run the tests
```
A review form should appear with a rewritten prompt.

## Use

```
/prompt <your rough request>
```

The extension:
1. Sends your input to a task-local rewriter agent (Claude Sonnet 4.6).
2. The rewriter restructures it into a polished Copilot CLI prompt,
   preserving every URL / file path / identifier verbatim.
3. A review form pops up. Edit the rewrite if you want, then **Accept**
   to send it to your main agent, or type into the **Refinement Feedback**
   field and **Accept** again to regenerate with that feedback.
4. Cancel the form to abort entirely.

## Examples

**Input:**
```
/prompt the users endpoint is returning 500s intermittently and i think
its related to the database connection but not sure, also the error
messages are useless, fix both
```

**Rewritten:**
```
1. Search for the users endpoint handler, the database connection module,
   and the error handling middleware used by this endpoint. Read all
   three in parallel.
2. Search the application logs for recent 500 errors on the users endpoint.
   Capture the stack traces and note any patterns.
3. Reproduce the 500 error locally under the conditions identified in
   the logs.
4. Trace the failure from the stack trace to the root cause in the
   database connection code. Fix the underlying issue.
5. Run the existing tests for the users endpoint to confirm the fix
   and check for regressions.
6. Audit the error responses returned by the users endpoint. For each
   error case, rewrite the response to include what operation failed,
   a human-readable reason, and a suggested corrective action.
7. Add a test case that reproduces the original 500 error condition
   and asserts the fix holds.
```

**Single-intent commands stay compact:**
```
/prompt run the tests
```
→
```
Run the full test suite and report any failures.
```

## What v0 does NOT do

- **No file or clipboard ingestion.** Paste your input directly. Earlier
  drafts had `--file` and `--clipboard` flags; they were half-finished
  and removed for v0.
- **No named transforms / templates / personas.** Coming in MVP-1 on the
  in-flight `feat/prompt-transforms` branch.
- **No model configuration.** Hardcoded to `claude-sonnet-4.6`.
- **No batch mode.** One invocation = one rewrite cycle.

## Troubleshooting

- **"Elicitation UI not available"** — your CLI version doesn't ship the
  elicitation transport. The extension falls back to logging the rewrite
  so you can copy-paste it manually.
- **"Rewriter task timed out"** — the rewriter took longer than 120s.
  Usually model latency. Re-run.
- **"Prompt: empty after sanitization. Nothing to send."** — the model
  returned only markdown that the sanitizer stripped. Try rephrasing or
  shortening your input.

## Uninstall

```pwsh
Remove-Item -Recurse ~/.copilot/extensions/prompt
```

## License

MIT (see `LICENSE` if present; otherwise this folder inherits the parent
repo's license).
