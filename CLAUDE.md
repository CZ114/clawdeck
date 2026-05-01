# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Scope

Claude Code Companion is an approval-loop layer for Claude Code on Windows. The eventual product is an iPhone companion, but the repo currently sits at **Stage 0**: a Windows-only Node.js daemon plus a `PreToolUse` hook script, with a manual CLI standing in for the phone.

There is no iOS app, no WebSocket, no pairing, and no cloud relay yet. Do not add those layers without first updating `docs/stages.md` — stages are gated and the staged plan is intentional (see `docs/stages.md` "Stage Gate Rule").

## Common Commands

Stage 0 has no external npm dependencies — `node_modules/` is intentionally empty. Requires Node.js 20+.

```powershell
npm run smoke              # End-to-end test: spawns daemon on port 54317, runs hook, approves, asserts allow
npm run daemon             # Start the daemon (default 127.0.0.1:4317)
npm run approve -- <reqId> # Approve a pending request via /permission-decisions
npm run deny -- <reqId> "Reason"
npm run hook:pre-tool-use  # Manually run the hook (reads JSON from stdin, writes Claude hook decision to stdout)
```

There is no test framework, no linter, and no build step. `npm run smoke` is the only automated check — run it after changes to anything in `packages/` or `scripts/`.

## Architecture

Three pieces, all local:

1. **`packages/hooks/pre-tool-use.js`** — invoked by Claude Code as a `PreToolUse` command hook. Reads hook JSON from stdin, POSTs it to the daemon, writes the daemon's response (a Claude Code hook decision object) back to stdout.
2. **`packages/daemon/src/index.js`** — Node `http` server. Receives hook payloads on `POST /hook/pre-tool-use`, builds a permission request, parks it in an in-memory `pendingRequests` Map, and resolves the awaiting hook response when a decision arrives via `POST /permission-decisions` (or on timeout). Also exposes `GET /health`, `GET /pending-requests`, `GET /events`.
3. **`packages/shared/`** — `protocol.js` (id/JSON helpers, `claudePreToolUseDecision`, `normalizeDecision`, `PROTOCOL_VERSION`) and `risk.js` (regex-based `low`/`medium`/`high` classifier for Bash commands).

The decision channel is purely in-memory: a `Promise` returned by `waitForDecision` is held by the open HTTP request and resolved by either `/permission-decisions` or the timeout. **Do not add disk persistence in Stage 0** (`docs/security.md` explicitly rules this out).

Manual approval CLI (`scripts/decide.js`) and the smoke test (`scripts/smoke-test.js`) are stand-ins for the future iOS app — they exercise the same `/permission-decisions` endpoint that the phone will use later.

## Critical Behaviors To Preserve

- **Fail-closed.** If the daemon is unreachable, the hook returns `deny`, not `ask`. Only `CCC_FAIL_OPEN=true` switches to `ask`. Do not flip the default.
- **Timeout asymmetry.** Hook timeout (`CCC_HOOK_TIMEOUT_MS`, default 58000) must stay **longer** than daemon approval timeout (`CCC_APPROVAL_TIMEOUT_MS`, default 55000). The daemon needs to return a clean `deny` before Claude Code's hook timeout fires.
- **127.0.0.1 binding.** The daemon binds loopback by default. Stage 1 will introduce LAN binding with pairing — until then, do not bind to `0.0.0.0`.
- **Protocol versioning.** Every durable event includes `protocolVersion` (currently `1`), `type`, `createdAt`, and `requestId`/`sessionId` where applicable. When you change event shapes, bump or document compatibility per `docs/documentation-framework.md` "Protocol Change Rules".
- **Decision normalization.** Use `normalizeDecision` from `packages/shared/protocol.js` rather than comparing strings directly — it maps `approve`/`allow`/`deny`/`block`/`ask` to Claude Code's canonical values.
- **Phone-visible data policy** (`docs/security.md`): full command output, source files, transcripts, and env vars are never sent through the protocol. The pending-request shape is the one that will reach the phone — keep it minimal.

## Documentation Source Of Truth

Per `docs/documentation-framework.md`, repo docs are the source of truth and code/doc disagreement is a bug. Check or update the relevant doc in the same change:

- `docs/stages.md` — what is in-scope for the current stage
- `docs/protocol.md` — every event/endpoint shape
- `docs/security.md` — any change to hook behavior, risk rules, timeouts, or phone-visible data
- `docs/dev-setup.md` — environment vars, hook registration, troubleshooting

## Environment Variables

```text
CCC_PORT=4317                  # daemon port
CCC_HOST=127.0.0.1             # daemon bind host
CCC_APPROVAL_TIMEOUT_MS=55000  # daemon waits this long for a decision
CCC_HOOK_TIMEOUT_MS=58000      # hook waits this long for daemon response (must be > APPROVAL_TIMEOUT)
CCC_FAIL_OPEN=false            # if true, hook returns "ask" instead of "deny" when daemon is down
```

## Platform Notes

This is a Windows-targeted project (the eventual desktop companion is Windows-only). Hook examples use PowerShell. Paths in this workspace contain a space and non-ASCII characters (`C:\Users\陈哲\Documents\New project`) — quote paths in shell commands and prefer `$env:CLAUDE_PROJECT_DIR` over hardcoded paths in `.claude/settings.local.json`.
