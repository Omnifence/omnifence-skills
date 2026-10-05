# omnifence-skills

This repository is a Claude Code plugin marketplace. It publishes two plugins from one
repository, one skill each:

| Plugin                  | Skill folder                    | Who installs it                    |
| ----------------------- | ------------------------------- | ---------------------------------- |
| `omnifence-integration` | `skills/omnifence-integration/` | Every content moderation customer. |
| `omnifence-registry`    | `skills/omnifence-registry/`    | Shared Registry members only.      |

The two products are separate. The moderation skill must never add Shared Registry calls,
and the registry skill must never add moderation calls. Each skill says so, and each
`description` keeps the other's requests out.

Both plugin entries use `"source": "./"`, `"strict": false` and their own `skills` list,
so each install carries only its own skill. There is no `plugin.json`: the marketplace
entry is the whole manifest. A new skill goes in its own folder under `skills/` and is
listed in exactly one plugin entry.

## Version rule

Users install a snapshot of one commit. They only get new content after they run
`/plugin marketplace update omnifence-skills` and `/plugin update <plugin>`. A clear
version number tells them what they have.

Each plugin entry in `.claude-plugin/marketplace.json` has its own `version`. Increase it
in every commit that changes that plugin's skill, its references, or its entry. Use
semantic versioning:

- Patch (0.1.1 -> 0.1.2): text edits, fixes, small reference changes.
- Minor (0.1.2 -> 0.2.0): new instructions, new reference files, new behavior.
- Major (0.2.0 -> 1.0.0): a change that breaks an existing integration flow.

Do not increase a version for a commit that changes only CI, the README, or other files
outside `skills/` and `.claude-plugin/`. Increase `metadata.version` when the set of
plugins changes.

## Descriptions

- Each plugin entry's `description` is the install screen text. Keep it high level and
  short.
- `description` in each `SKILL.md` controls when the skill triggers. Keep the trigger
  words in it. Do not shorten it for style.
