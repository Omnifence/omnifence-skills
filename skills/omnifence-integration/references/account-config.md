# Account configuration that changes an integration

What a moderation job checks, and what a rejection `reason` says, depends on the account's
own configuration. Read this before you write code that branches on a decision.

**Do not change an account's configuration on the user's behalf.** These are live
production settings for every job the account submits, not integration scaffolding.
Read them to understand the decisions the integration will receive, and report what you
find. Change one only when the user explicitly asks.

## Custom categories

A custom category is the account's own prohibited-content rule, written in plain language.
Every **enabled** category runs on **every endpoint** — text, image, video and audio — and
a match rejects the job exactly as a built-in policy breach does.

This matters to an integration for one reason: `reason` is not a fixed enum. It can name a
category the account invented, by the category's `slug`. Code that maps a rejection to
internal handling must treat `reason` as free text and must not switch on a closed set of
values.

| Method   | Endpoint                                              | Purpose                                    |
| -------- | ----------------------------------------------------- | ------------------------------------------ |
| `GET`    | `/api/v1/me/custom-categories`                        | List the categories and the account limit  |
| `POST`   | `/api/v1/me/custom-categories`                        | Create a category                          |
| `POST`   | `/api/v1/me/custom-categories/generate-prompt`        | Draft a system prompt from a description   |
| `PUT`    | `/api/v1/me/custom-categories/{id}`                   | Update a category, or enable/disable it    |
| `DELETE` | `/api/v1/me/custom-categories/{id}`                   | Delete a category                          |

```bash
curl https://api.omnifence.ai/api/v1/me/custom-categories \
  -H "Authorization: Bearer $OMNIFENCE_API_KEY"
```

```json
{
  "categories": [
    {
      "category_id": "9f1c2d3e-4b5a-6789-abcd-ef0123456789",
      "name": "Coffee",
      "slug": "coffee",
      "description": "References to coffee, coffee beans, drinking coffee",
      "system_prompt": "Set is_prohibited to true if the content shows coffee, coffee beans, or a person drinking coffee.",
      "enabled": true,
      "created_at": "2026-08-01T09:12:00.000Z",
      "updated_at": "2026-08-01T09:12:00.000Z"
    }
  ],
  "count": 1,
  "limit": 10
}
```

A job rejected by that category carries the slug in the `reason`:

```json
{ "is_prohibited": true, "reason": "The image contains references to coffee and coffee beans (coffee)." }
```

The `slug` is derived from the `name`, is immutable, and is the stable identifier. Match on
the slug, not on the sentence around it, if the integration needs to route a rejection by
category. Audio is judged on its transcript, so a custom category fires there only when the
speech matches it.

## Per-account check toggles

`GET /api/v1/me/moderation-config` returns the toggles and a catalogue of the available
categories with display metadata.

```json
{
  "enabled_categories": { "nsfw": true, "text": true },
  "catalogue": { "nsfw": { "label": "…", "description": "…", "icon": "…" }, "text": { "…": "…" } }
}
```

A category is enabled unless its key is explicitly `false`.

| Check                       | Toggleable | Effect on the integration                                              |
| --------------------------- | ---------- | ---------------------------------------------------------------------- |
| AI Adult General            | No         | Always runs on every job. Cannot be disabled.                          |
| NSFW label                  | Yes        | Off: the check does not run and `nsfw` is absent from the result.      |
| Text moderation             | Yes        | Off: text jobs pass unchecked.                                         |

Check these before you promise the user a behaviour:

- **`nsfw: false`** — do not write code that reads `result.nsfw` as a required field. It is
  absent, not `false`.
- **`text: false`** — every layer 1 text check becomes a **silent pass**. Enabled custom
  categories do **not** override the toggle; they are skipped with the rest of the text
  check. Image, video and audio are unaffected. If the plan includes a text layer and the
  account has text moderation off, say so at the step 4 checkpoint. The integration is not
  fail-closed in any useful sense until the user turns it on.

`PUT /api/v1/me/moderation-config` writes the toggles. The body is the complete new state,
so an omitted category is treated as enabled — a partial PUT silently re-enables anything
it leaves out.

## API key attribution

A job records the API key it was submitted with. `GET /api/v1/job/{id}` and
`GET /api/v1/jobs` return `api_key_id` and `api_key_name` (both `null` for a job submitted
from a dashboard session, and for jobs created before attribution shipped).

**Recommend one API key per approved call site**, named after the site. It costs nothing,
and it turns the job list and the CSV export into a per-site audit trail: which call site
produced which decisions, and which one started failing. A single shared key throws that
away permanently — attribution is stamped at submission time and cannot be reconstructed
afterwards. It also means a leaked or rotated key takes down one call site, not all of
them.

## Exporting decisions for operators

`GET /api/v1/jobs/export?from=<ISO 8601>&to=<ISO 8601>` streams a CSV of the jobs created in
the window. Both bounds are required; `from` is inclusive and `to` is exclusive, so use the
start of the day after the last day wanted.

Columns include `job_id`, `type`, `status`, `is_prohibited`, `created_at`, `completed_at`,
`api_key_id`, `api_key_name`, `prompt`, `reason`, and one column per moderation category.

This is the operator surface for the rejection reasons the integration logs but never shows
to end users. Name it when the user asks where rejections can be reviewed.
