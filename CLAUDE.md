# omnifence-skills

This repository is a Claude Code plugin marketplace. It publishes the
`omnifence-integration` skill.

## Source of truth

Production customers install this skill and build on what it says. It must describe the
API exactly as it is live: the public spec and docs in `Omnifence/omnifence-monorepo`
(`docs/`, `docs/api-reference/openapi.json`). The skill follows the API. It never leads it.

- Update the skill in the same round of work as any change to the public contract: a
  path, a field, a status or error code, an `error_code` value, a scope, a limit, or the
  webhook payload. Name the branch the same as the monorepo branch. The monorepo's
  **Skill drift** PR check then tests the two together.
- Before you push, run the drift check against the unpublished monorepo docs:
  `SPEC_URL=<monorepo>/docs/api-reference/openapi.json DOCS_DIR=<monorepo>/docs node scripts/check-drift.mjs`.
  CI here checks the published docs, so it fails until the monorepo change deploys. Merge
  this PR after that deploy.
- When the drift check misses a fact the skill depends on, extend `scripts/check-drift.mjs`
  in the same change. A green check that did not test the contract is how the skill drifted
  for a month in 2026-09.
- A contract change that breaks an existing customer integration is a **major** version
  bump here, and it needs customer notice on the API side first.

## Version rule

Users install a snapshot of one commit. They only get new content after they run
`/plugin marketplace update omnifence-skills` and `/plugin update omnifence-integration`.
A clear version number tells them what they have.

Increase `plugins[0].version` in `.claude-plugin/marketplace.json` in every commit that
changes the skill, its references, or the plugin metadata. Use semantic versioning:

- Patch (0.1.1 -> 0.1.2): text edits, fixes, small reference changes.
- Minor (0.1.2 -> 0.2.0): new instructions, new reference files, new behavior.
- Major (0.2.0 -> 1.0.0): a change that breaks an existing integration flow.

Do not increase the version for a commit that changes only CI, the README, or other files
outside `skills/` and `.claude-plugin/`.

## Descriptions

- `plugins[0].description` in `.claude-plugin/marketplace.json` is the install screen text.
  Keep it high level and short.
- `description` in `skills/omnifence-integration/SKILL.md` controls when the skill triggers.
  Keep the trigger words in it. Do not shorten it for style.
