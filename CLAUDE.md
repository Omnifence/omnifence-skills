# omnifence-skills

This repository is a Claude Code plugin marketplace. It publishes the
`omnifence-integration` skill.

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
