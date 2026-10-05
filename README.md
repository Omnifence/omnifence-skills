# Omnifence agent skills

AI agent skills for integrating [Omnifence](https://docs.omnifence.ai). The repository
publishes two independent plugins. Install only the ones you use:

| Plugin                  | Use it for                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `omnifence-integration` | Content moderation of prompts, chat, images, video, and audio. Most customers need only this. |
| `omnifence-registry`    | The [Shared Registry](https://docs.omnifence.ai/registry/overview) banned-user list. Members only. |

## Install

As a Claude Code plugin:

```
/plugin marketplace add Omnifence/omnifence-skills
/plugin install omnifence-integration@omnifence-skills
```

Shared Registry members also install:

```
/plugin install omnifence-registry@omnifence-skills
```

Or with the [skills CLI](https://skills.sh) (works with Claude Code, Cursor, Codex, and
other agents). Run it without `--skill` to choose from a list:

```
npx skills add Omnifence/omnifence-skills --skill omnifence-integration
npx skills add Omnifence/omnifence-skills --skill omnifence-registry
```

Then ask your agent:

```
Add Omnifence moderation to this app.
```

or, for members:

```
Check new sign-ups against the Omnifence Shared Registry.
```

## What the moderation skill does

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

## What the registry skill does

`omnifence-registry` is for organisations with an active Shared Registry membership and a
registry key. It never runs for a moderation request. It:

1. **Confirms membership and key scopes** before it writes any code.
2. **Adds one hashing module** that implements the published email normalisation spec,
   with a unit test over the published test vectors.
3. **Checks sign-ups** with `POST /api/v1/registry/check`, fails open when the registry
   cannot answer, and refuses automatically only on a signal that permits it.
4. **Reports human-reviewed bans** and **revokes overturned bans**, with a retrying job and
   the `entry_id` stored against each case.

## Repository layout

- `.claude-plugin/marketplace.json` — the two plugin entries; each lists only its own skill folder.
- `skills/omnifence-integration/SKILL.md` — the moderation integration procedure.
- `skills/omnifence-integration/references/` — per-endpoint request/response examples,
  a shared submit helper with the full error table, a signature-verifying webhook handler
  (completed and failed callbacks), a polling loop, and the account configuration
  (custom and default categories, check toggles, API key attribution) that changes what
  a decision means.
- `skills/omnifence-registry/SKILL.md` — the Shared Registry procedure, with
  `references/` for email hashing, the sign-up check, and report and revoke.
- `scripts/check-drift.mjs` — CI guard, run on every push and weekly. Against the
  published OpenAPI spec at `https://docs.omnifence.ai/api-reference/openapi.json`: every
  endpoint path, method, response field, response status, enum value, and query parameter
  the skill relies on must exist, retired endpoints must not appear, and the size limits
  the skill states must match. Against the published docs pages: error codes, failed-job
  `error_code` values, webhook payload fields, and scopes must match the skill in both
  directions. For the registry skill: the registry paths, response fields, request
  enums (categories and check contexts), and categories must match, and the hashing
  implementation in `references/hashing.md` must reproduce every published test vector.
  Run locally with `node scripts/check-drift.mjs`. `SPEC_URL=` and
  `DOCS_URL=` override the sources; `DOCS_DIR=<API repo>/docs` checks against unpublished
  `.mdx` sources.

## Docs

- API reference: https://docs.omnifence.ai/api-reference/introduction
- Quickstart: https://docs.omnifence.ai/quickstart
