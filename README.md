# /prompt — Copilot CLI prompt rewriter

A Copilot CLI extension that rewrites your rough request into a
structured prompt **in a context-isolated side conversation**, so the
rewriter's noise never enters your main agent's context.

## Why

Before `/prompt`, every "rewrite this more carefully" and every prompt-
engineering aside leaked into the parent agent's working memory. Now the
rewriting happens inside a task-local conversation: the parent only ever
sees the final polished prompt.

## Install

Prerequisite: 
- GitHub Copilot CLI - https://github.com/features/copilot/cli
- Expermimental mode turned on
   - <img width="1740" height="347" alt="image" src="https://github.com/user-attachments/assets/ec3e5fc5-a226-434b-b559-3c386015d4ad" />

PowerShell:
```pwsh
# Remove any prior install first to avoid stale files
Remove-Item -Recurse -Force ~/.copilot/extensions/prompt -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force ~/.copilot/extensions | Out-Null
git clone https://github.com/KalebCole/copilot-prompt ~/.copilot/extensions/prompt
```

macOS / Linux:
```sh
rm -rf ~/.copilot/extensions/prompt
mkdir -p ~/.copilot/extensions
git clone https://github.com/KalebCole/copilot-prompt ~/.copilot/extensions/prompt
```

The repo clones directly into the extensions slot — no copy step needed.

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


## Uninstall

```pwsh
Remove-Item -Recurse ~/.copilot/extensions/prompt
```

## License

MIT — see `LICENSE`.
