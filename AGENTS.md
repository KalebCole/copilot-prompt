# AGENTS.md — /prompt extension

This file is for agents (and the human maintainer) opening this folder cold.
Read it before editing anything. The README.md next to it is for end users.

## 30-second orientation

`/prompt` is a Copilot CLI slash command that rewrites a user's rough input
into a polished prompt **in a context-isolated side conversation**, then
sends the final rewrite to the parent agent via `session.send({prompt})`.
The rewriter's internal back-and-forth never enters the parent context.

Mechanism: a `customAgent` named `prompt-rewriter` is registered at
`joinSession` (see the `customAgents` array in `extension.mjs`'s
`joinSession({ ... })` call). Each invocation calls
`session.rpc.tasks.startAgent` with that `agentType`, polls until
idle, harvests the rewrite, and discards the task. Look for the
`runRewriterAgent` function in `extension.mjs`.

## Repo layout

- `extension.mjs` — entry point. Registers the customAgent + `/prompt`
  command, builds task-local prompts, drives the elicitation review loop.
- `lib/sanitize.mjs` — pure, no SDK imports. Conservative 5-rule markdown
  safety net used as the fallback in `extractRewrite` when the model
  omits the `<<<PROMPT>>>...<<<END>>>` markers.
- `test/sanitize.test.mjs` — 55 cases for the sanitizer. Run with
  `npm test` from this dir, or `node --test test/sanitize.test.mjs`.
- `package.json` — metadata only; `@github/copilot-sdk` is auto-resolved
  by the Copilot CLI and is NOT a dependency here.

## Invariants — do not break these

1. **Rewriter system prompt is immutable per session.** It's set ONCE at
   `joinSession` via the `prompt-rewriter` customAgent registration —
   the `prompt: SYSTEM_PROMPT` field inside the `customAgents` array.
   Per-call modifications must ride in the task-local prompt argument to
   `tasks.startAgent`, never in the customAgent registration.
2. **Only the final rewrite touches the parent context.** Everything
   inside `runRewriterAgent` is task-local. The single gateway to the
   parent is `await session.send({ prompt: finalPrompt })` at the end
   of the slash-command handler. If you add new orchestration, preserve
   this boundary.
3. **`lib/` modules stay pure.** No `@github/copilot-sdk` imports in
   anything under `lib/`. This lets `node --test` run them without
   pulling the SDK runtime. `lib/sanitize.mjs` is the reference shape.
4. **No `console.log()`.** stdout is reserved for JSON-RPC. Log via
   `session.rpc.log({ message, level? })`. (SDK docs:
   `pkg/.../copilot-sdk/docs/agent-author.md`, "stdout is reserved" section.)
5. **CustomAgentConfig has no `model` field.** Model selection is
   per-call on `tasks.startAgent.model` (currently hard-coded to
   `claude-sonnet-4.6` inside `runRewriterAgent`).
6. **`UIElicitationSchemaPropertyString` has no multiline/rows hint.**
   The `format` enum is only `email | uri | date | date-time`. Don't
   add a `multiline: true` field hoping it'll render — it won't.

## Architecture flow

```
ctx.args
   │
   ▼
parseArgs (trim)
   │
   ▼
empty? ──► log usage and return
   │
   ▼
strip <<<PROMPT>>>/<<<END>>> collisions in user input
   │
   ▼
gather conversation context (extractMessages, capped 40 msgs / 120k chars)
   │
   ▼
buildInitialPrompt ──► runRewriterAgent ──► extractRewrite
                          │                       │
                          │                       ▼
                          │                  sanitizePrompt (fallback)
                          ▼
                  task-local; never enters parent context
   │
   ▼
elicitation review loop
   ├── feedback empty? ──► accept, sanitizePrompt, session.send(prompt)
   └── feedback present? ──► buildRegenPrompt ──► runRewriterAgent ──► loop
```

## How to test

From the repo root:
```
npm test
```
Or:
```
node --test test/sanitize.test.mjs
```
Expected: 55 tests pass. There are no integration tests of the live
slash command yet — exercise it manually inside Copilot CLI when
changing the handler.

## Where new features should go

- **Pure logic** (text transformations, parsers, validators) → new file
  under `lib/` + parallel test file under `test/`. Stay SDK-free.
- **New invocation modes** that need a richer rewriter framing (e.g.
  named transforms, ad-hoc instructions, template presets) → augment
  the task-local prompt in `buildInitialPrompt` / `buildRegenPrompt`.
  Do NOT change the customAgent registration. See in-flight design
  notes below.
- **New imports of `node:fs`** are fine for user-scoped state (e.g.
  `~/.copilot/transforms/`). `session.fs` is session-scoped and is
  the wrong tool for state that must persist across sessions.

## Open TODOs that are NOT bugs

- The `TODO` comment near the `SYSTEM_PROMPT` `<copilot_cli_capabilities>`
  section — "modular system prompt / harness-specific capabilities" idea.
  Parked. Don't auto-refactor.
- The `TODO` comment at the bottom of the `<examples>` block — "add an
  anti-pattern example" to the SYSTEM_PROMPT. Parked. Don't auto-add —
  picking a good anti-example is a design decision, not a chore.

## In-flight design work

Mid-flight design notes for MVP-1 (named "transforms" invoked as
`/prompt <name> <text>`) live in the author's private source-of-truth
repo on the `feat/prompt-transforms` branch — `CONTEXT.md` (domain
language) and `docs/adr/0001-transforms-are-not-skills.md` (ADR).
This standalone repo will absorb that work after MVP-1 lands.

## Troubleshooting (implementation-side)

Error messages below are paraphrased; the runtime versions interpolate
agent ids, latency, and similar context.

- **Rewriter task missing from `tasks.list`** — the `agentId` returned
  by `tasks.startAgent` wasn't observable in the next `tasks.list()`
  call. The thrown error includes the visible agent set for diagnosis.
  Cause is usually an SDK version skew.
- **Rewriter task timed out** — exceeded `REWRITER_TIMEOUT_MS` (120s).
  Likely model latency or a model string the CLI session doesn't support.
- **Empty after sanitization** — the model returned only markdown that
  the sanitizer stripped. Inspect with the "Original: …" log line
  emitted just before the elicitation form opens to see what was
  actually sent.
- **Elicitation UI not available** — the CLI is running without the
  elicitation transport. The handler falls back to logging the rewrite
  for manual copy-paste.
