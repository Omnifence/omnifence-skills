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

## Repository layout

- `skills/omnifence-integration/SKILL.md` — the integration procedure.
- `skills/omnifence-integration/references/` — per-endpoint request/response examples,
  a webhook handler, and a polling loop.
- `scripts/check-drift.mjs` — CI guard: every endpoint path, method, and response field
  named in the skill must exist in the published OpenAPI spec at
  `https://docs.omnifence.ai/api-reference/openapi.json`, and retired endpoints must not
  appear. Run locally with `node scripts/check-drift.mjs` (`SPEC_URL=` overrides the
  spec source).

## Docs

- API reference: https://docs.omnifence.ai/api-reference/introduction
- Quickstart: https://docs.omnifence.ai/quickstart
