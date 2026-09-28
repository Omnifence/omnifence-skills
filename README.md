# Omnifence agent skills

Claude Code skills for integrating the [Omnifence](https://docs.omnifence.ai) content
moderation API.

## Install

As a Claude Code plugin:

```
/plugin marketplace add Omnifence/omnifence-skills
/plugin install omnifence-integration@omnifence-skills
```

Or with the [skills CLI](https://skills.sh) (works with Claude Code, Cursor, Codex, and
other agents):

```
npx skills add Omnifence/omnifence-skills
```

Then ask your agent to integrate:

```
Add Omnifence moderation to this app.
```

## What the skill does

`omnifence-integration` walks a coding agent through a complete integration:

1. **Finds generation call sites** — third-party APIs (OpenAI-compatible, Replicate,
   fal.ai, ComfyUI, ElevenLabs, …) and in-house generation platforms, found by
   behavioural signals rather than SDK names.
2. **Confirms the list with you** before writing any code. A missed call site is
   unmoderated content, so the agent must show you what it found and let you correct it.
3. **Wires the right endpoint per site** — `POST /api/v1/moderate/text` for prompts and
   AI-character chat turns, `/moderate/image`, `/moderate/video`, and `/moderate/audio`
   for generated media.
4. **Handles the async job contract** — webhook or polling, rate-limit aware, and
   fail-closed: content stays held until a pass decision.
5. **Verifies signed webhooks** — every callback is signed with
   [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks), and the
   handler the agent writes verifies the signature over the raw body before it releases
   anything.

## Repository layout

- `skills/omnifence-integration/SKILL.md` — the integration procedure.
- `skills/omnifence-integration/references/` — per-endpoint request/response examples,
  a shared submit helper with the full error table, a signature-verifying webhook handler
  (completed and failed callbacks), a polling loop, and the account configuration
  (custom and default categories, check toggles, API key attribution) that changes what
  a decision means.
- `scripts/check-drift.mjs` — CI guard, run on every push and weekly. Against the
  published OpenAPI spec at `https://docs.omnifence.ai/api-reference/openapi.json`: every
  endpoint path, method, response field, response status, enum value, and query parameter
  the skill relies on must exist, retired endpoints must not appear, and the size limits
  the skill states must match. Against the published docs pages: error codes, failed-job
  `error_code` values, webhook payload fields, and scopes must match the skill in both
  directions. Run locally with `node scripts/check-drift.mjs`. `SPEC_URL=` and
  `DOCS_URL=` override the sources; `DOCS_DIR=<API repo>/docs` checks against unpublished
  `.mdx` sources.

## Docs

- API reference: https://docs.omnifence.ai/api-reference/introduction
- Quickstart: https://docs.omnifence.ai/quickstart
