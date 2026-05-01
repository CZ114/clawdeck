# Documentation Framework

This project should keep repo documentation as the source of truth. Personal notes can mirror or expand the thinking, but implementation-facing decisions should land in the repo.

## Documentation Goals

- Make the next engineering step obvious.
- Keep MVP boundaries visible.
- Record security decisions before they become implicit behavior.
- Keep protocol changes versioned.
- Let new testers set up the project without private context.

## Proposed Docs Tree

```text
docs/
  stages.md                  # staged roadmap and stage gates
  documentation-framework.md # this file
  user-guide.md              # practical commands for current users
  desktop-companion.md       # floating window and desktop pet notes
  architecture.md            # system components and data flow
  protocol.md                # HTTP/WebSocket/hook event schemas
  security.md                # approval safety, risk rules, token model
  dev-setup.md               # Windows daemon + iOS development setup
  troubleshooting.md         # known setup, network, hook, and iOS issues
  user-testing.md            # tester scripts and feedback questions
  release-checklist.md       # repeatable release steps
  decisions/
    ADR-YYYYMMDD-title.md    # architectural decision records
```

Create a document when there is a durable topic that will be referenced more than once. Avoid creating docs that only repeat README content.

## Source Of Truth Rules

- `README.md`: product entry, current milestone, quick start when available.
- `docs/stages.md`: what the product is allowed to become and when.
- `docs/protocol.md`: exact event shapes and compatibility rules.
- `docs/security.md`: every security-sensitive behavior and tradeoff.
- ADRs: decisions that explain why a path was chosen.

If code behavior and docs disagree, treat it as a bug. Either update the code or update the docs in the same change.

## Stage Document Template

Use this structure when adding detailed stage specs:

```markdown
# Stage N: Name

## Goal

## Scope

## Non-goals

## User Flow

## Technical Requirements

## Security Requirements

## Exit Criteria

## Open Questions
```

## ADR Template

Use ADRs for choices that will affect future implementation. Keep them short.

```markdown
# ADR-YYYYMMDD Title

## Status

Proposed | Accepted | Superseded

## Context

## Decision

## Consequences

## Alternatives Considered
```

Examples that deserve ADRs:

- Choosing Node.js/Bun for the Windows daemon.
- Choosing `PreToolUse` as the first approval interception point.
- Choosing WebSocket over polling for phone updates.
- Choosing local-network-only MVP before cloud relay.
- Deciding what command details can appear on the phone.

## Protocol Change Rules

Every event schema should include:

- `type`
- `protocolVersion`
- `requestId` or `eventId` where applicable
- `sessionId` where applicable
- `createdAt`

When changing protocol fields:

1. Update `docs/protocol.md`.
2. Add validation changes in shared schema code.
3. Add migration notes if older clients may connect.
4. Include one example payload.

## Security Documentation Rules

Update `docs/security.md` whenever any of these change:

- Claude Code hook behavior.
- Command approval logic.
- Risk classification.
- Pairing or auth token format.
- Local storage location.
- Phone-visible data.
- Network exposure.
- Remote relay behavior.

Security notes should answer:

- What can this component access?
- What data leaves the Windows machine?
- What happens on timeout or disconnect?
- What is denied by default?
- How can the user revoke trust?

## Development Log

For early development, keep a short development log inside `docs/user-testing.md` or a dated note when a demo meaningfully changes behavior:

```markdown
## YYYY-MM-DD Demo

- Build:
- What worked:
- What failed:
- Setup friction:
- Security concern:
- Next fix:
```

Do not turn the log into a diary. Keep only entries that help future debugging or product decisions.

## Review Checklist For Doc Changes

Before merging a doc or code change:

- Does the README still describe the current milestone?
- Does the relevant stage still have accurate exit criteria?
- Are new protocol fields documented with examples?
- Are security-sensitive changes reflected in `docs/security.md`?
- Does a durable decision need an ADR?
- Can a new tester follow the setup docs without private chat context?

## Writing Style

- Prefer concrete behavior over vague intent.
- Use short examples.
- Mark non-goals clearly.
- Keep risk and security language direct.
- Do not document speculative features as committed work.
