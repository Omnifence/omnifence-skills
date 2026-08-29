---
name: omnifence-integration
description: >-
  Integrate the Omnifence content moderation API into a codebase. Use whenever the user asks
  to "add moderation", "integrate Omnifence", "add content moderation", or "moderate
  generated content" — and also whenever they want AI-generated prompts, images, video,
  audio, or AI-character chat screened, filtered, blocked, made safe, or checked for policy
  or NSFW violations before it reaches end users, even if they never say "Omnifence" or
  "moderation". Finds generation call sites (third-party APIs or in-house platforms),
  confirms them with the user, then wires POST /api/v1/moderate/{text,image,video,audio}
  with async job handling.
---

# Omnifence integration

Omnifence is a content moderation API for AI-generated media. A client submits text, an
image URL, a video URL, or an audio URL; a moderation pipeline classifies it; the client
receives a pass/reject decision as an asynchronous job result.

Your task: find every place this codebase generates content, confirm the list with the
user, and insert a moderation step at each confirmed site.

Base URL: `https://api.omnifence.ai`. Auth: `Authorization: Bearer <API key>` on every
request. There is no SDK — use plain HTTP (`fetch` examples in `references/`).

## Step 1 — Find the generation call sites

Scan the codebase for every place content is generated, of any provenance. Do not stop at
known SDKs.

**Known external providers.** Search for clients, SDK imports, and REST calls to:
OpenAI-compatible image/chat APIs, OpenRouter, Replicate, fal.ai, RunPod, ComfyUI,
Stability AI, ElevenLabs — and any generic chat-completion loop that powers an AI
character.

**In-house generation platforms.** The customer may run their own inference services,
self-hosted model servers, or internal microservices. These have no recognisable SDK, so
search for behavioural signals instead:

- Request payloads that carry a prompt, negative prompt, seed, or model/checkpoint name.
- Queue or job submissions whose results are images, video, or audio.
- GPU-worker callbacks or polling loops that collect a generated file.
- Uploads of freshly generated files to object storage (S3, GCS, R2).
- Streaming chat loops that produce assistant/character replies.

Classify each site by what it **consumes** (a user-written prompt, a chat turn) and what
it **produces** (image, video, audio, text reply).

## Step 2 — Plan the moderation layers at each site

Most sites need more than one moderation call. Treat each site as an ordered chain of
layers, not as a single check.

An image endpoint that accepts a user-written prompt carries two layers:

1. The user prompt → `POST /api/v1/moderate/text`, **before** the generation call.
2. The generated image → `POST /api/v1/moderate/image`, **after** generation and before
   the image reaches an end user.

Rules for a chain:

- Moderate an input before you spend money on generation. A rejection at layer 1 stops
  the chain — the generation call does not run.
- A later layer starts only after the earlier layer returns `pass`. Never submit layer 2
  while layer 1 is `queued` or `processing`.
- A rejection at any layer rejects the whole request. Record which layer rejected it and
  why; the operator needs both.
- Each layer is a separate job with its own `job_id`. Store every job ID against the
  request so each decision matches back to its layer.
- A site can carry three layers. An AI character turn that replies with an image needs
  the user message (text), the model reply (text), and the generated image (image).
- A site with no user-supplied input carries one layer. Do not add a text call that has
  nothing to moderate.
- When one generated file holds two modalities — a video with a speech track — ask the
  user whether the video job must also cover the audio. Do not assume one endpoint
  covers both.

## Step 3 — Find the failure surface before you build one

A moderation layer adds three outcomes the application probably cannot express today:
content held while a job runs, content rejected, and moderation unavailable (error or
timeout). Fail-closed behaviour is impossible without a surface for these outcomes.

Search the codebase for the failure handling that already exists:

- An error or exception type, or a result envelope such as `{ ok, error }`.
- A status enum on the request, job, or media record that already carries states such as
  `pending`, `failed`, or `blocked`.
- A user-facing error path: an error response body, an error component, a toast, a
  notification.
- An existing retry queue, dead-letter queue, or alerting and logging path.

Then act on what you find:

- **A surface exists — reuse it.** Add the new states to the existing enum, raise the
  existing error type, and report through the existing path. Never add a second, parallel
  error system beside the one the codebase already uses.
- **No surface exists — report it, do not invent one.** This is feedback for the user,
  and it belongs in the step 4 checkpoint. Name the gap precisely. Example: "`generateImage()`
  returns a URL or throws. The route has no pending state and no way to tell the caller
  that generation was blocked. Moderation needs one." Offer options — extend the response
  shape, add a status field and a poll route, or wait synchronously with a timeout — give
  your recommendation, and let the user choose. Write the surface only after the user picks.
- **Generation itself can already fail.** If the site ignores a generation failure today,
  say so. That gap blocks the moderation integration too, because a held item and a failed
  item need the same reporting path.

## Step 4 — Discovery checkpoint (required)

**Hard rule: write no integration code until the user approves the call-site list.**

The scan is heuristic. In-house platforms are easy to miss, and a missed call site is
unmoderated content reaching end users. Before any edit, present the discovered sites,
one block per site:

```
file.ts:123 — <what it generates or consumes>
  layer 1 — <what is moderated> → <endpoint>, before generation
  layer 2 — <what is moderated> → <endpoint>, after generation
  failure surface — <the existing type, enum, or path you will hook into>  | MISSING: <the gap and your options>
```

Ask the user to:

- confirm the list, remove wrong entries, and add sites the scan missed;
- confirm the layers at each site;
- say whether any in-house generation path exists that the scan did not find;
- choose a failure surface at every site marked `MISSING`;
- confirm the account's moderation configuration matches the plan — a text layer is a
  silent pass if the account has text moderation switched off
  (`references/account-config.md`);
- confirm whether to mint one API key per call site, and how decisions will be received
  (a signed webhook endpoint, or polling).

Only after the user approves do you write code, and only for the approved sites and layers.

## Step 5 — Map each layer to an endpoint

| Layer | Endpoint | Field |
| --- | --- | --- |
| User-written generation prompt (moderate **before** the generation call) | `POST /api/v1/moderate/text` | `text` |
| AI-character chat turn — the user message, and optionally the model reply | `POST /api/v1/moderate/text` | `text` |
| Generated image | `POST /api/v1/moderate/image` | `image` (publicly reachable HTTPS URL, ≤ 10 MB) |
| Generated video | `POST /api/v1/moderate/video` | `video` (publicly reachable HTTPS URL, ≤ 300 MB) |
| Generated audio | `POST /api/v1/moderate/audio` | `audio` (publicly reachable HTTPS URL, ≤ 100 MB, ≤ 30 minutes) |

There is **no dedicated chat endpoint**: moderate each chat turn as plain text through
`/api/v1/moderate/text`. Media endpoints take a URL, not a file body — the media must be
at a URL the Omnifence classifiers can fetch (a public bucket URL or a presigned URL
works; a private or internal network address is rejected with `400 INVALID_REQUEST`).
Direct file parts (`image_file`, `video_file`, `audio_file`) exist but are disabled by
default per deployment; build on the URL contract unless the user confirms uploads are
enabled for their account.

All submissions are `multipart/form-data`. Every submission accepts an optional
`webhook_url` field that overrides the account's global webhook for that job.

What a job actually checks, and what a rejection names, depend on the account's own
configuration — custom categories, the NSFW and text toggles, and API key attribution.
Read `references/account-config.md` before writing code that branches on a decision.

Per-endpoint request/response examples: `references/moderate-text.md`,
`references/moderate-image.md`, `references/moderate-video.md`,
`references/moderate-audio.md`.

## Step 6 — Handle the async contract

Every submission returns `202` with a job ID, not a decision:

```json
{ "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "status": "queued" }
```

The decision arrives later, one of two ways:

1. **Webhook (preferred).** Register a global URL via `POST /api/v1/webhook/register`, or
   pass `webhook_url` per request. Omnifence POSTs the result to it on completion and
   retries failed deliveries for hours. **Every callback is signed, and the handler must
   verify the signature before it acts on the payload** — the webhook URL is not a secret,
   and an unverified endpoint releases content on a forged `is_prohibited: false`. Use a
   [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) library and
   read the **raw body bytes**: JSON middleware destroys the bytes the signature covers.
   See `references/webhook-handler.md`.
2. **Polling.** Poll `GET /api/v1/jobs?status=queued,processing` (one request covers all
   outstanding jobs) or `GET /api/v1/job/{id}`. Pace polling on the `x-ratelimit-limit`,
   `x-ratelimit-remaining`, and `x-ratelimit-reset` response headers, and honour
   `retry-after` on a `429` — never guess the limit. See `references/polling.md`.

A chain crosses this boundary once per layer. A webhook for layer 1 is what starts
generation and layer 2; the request stays held between the two.

**Fail closed.** Hold the prompt, chat turn, or generated media in a pending state until
a `pass` decision arrives. Do not show content to end users while its job is `queued` or
`processing`, and do not treat a failed job, a timeout, or an API error as a pass. Store
the `job_id` next to the content so the decision can be matched back to it.

## Step 7 — Handle the decision

A completed job carries:

- `is_prohibited` — `true` = rejected, `false` = passed, `null` while still pending.
- `reason` — present only on a rejection; names the policy or custom category that
  tripped. It is **free text, not a closed enum**: an account defines its own custom
  categories, and a rejection names one by its slug. Never `switch` on it. See
  `references/account-config.md`.
- `nsfw` — informational label on image/video jobs when the NSFW check is enabled; it
  never causes a rejection on its own.

A request with layers is released only after **every** layer passes. One rejection, one
failed job, or one timeout at any layer holds the whole request.

**Rejection reasons are for the operator, not for end users.** Log the `reason` and show
it in internal admin tooling; show end users only a generic "this content was not
allowed" message. Reasons can describe policy violations in terms unsuitable for an
end-user screen.

Scopes: each endpoint requires its scope — `moderate:text`, `moderate:image`,
`moderate:video`, `moderate:audio`; reading a job requires `job:read`. A missing scope
returns `403 FORBIDDEN`.

Error handling: `400 INVALID_REQUEST` (bad field or unreachable URL), `401 UNAUTHORIZED`
(bad key), `402 PAYMENT_REQUIRED` (account out of credit), `403 FORBIDDEN` (missing
scope), `429 RATE_LIMITED` (back off per `retry-after`), `500`/`503` (retry with backoff).
Two more end a retry loop rather than extending it: `403 ACCOUNT_TERMINATED` (the account
is terminated — not recoverable through the API, so stop and alert an operator) and
`404 JOB_NOT_FOUND` (the job ID does not exist or belongs to another account — a poll loop
must stop, not spin to its timeout). Errors are JSON:
`{ "error": "CODE", "message": "...", "statusCode": 400 }`. On any error the content
stays held — fail closed. Report the held state through the failure surface agreed in
step 3.

## Step 8 — Agent guardrails

- **Show the diff.** Present every change per approved call site; keep changes minimal
  and in the codebase's existing style.
- **Add tests** around each layer: prompt rejected → the generation call never runs and
  no image job is submitted; media rejected → media not published, even though the prompt
  passed; API error or timeout at any layer → content stays held; every layer passes →
  content released once. Cover the webhook handler too: a body with a missing, wrong, or
  stale signature → `400` and nothing released; a replayed `delivery_id` → acknowledged
  once, released once.
- **Never touch `/api/v1/admin/*`.** Those routes are for Omnifence operators, not for
  integrations. Do not call them, document them, or store credentials for them.
- **One API key per approved call site.** Jobs record the key they were submitted with
  (`api_key_id`, `api_key_name`), so a key per site turns the job list and the CSV export
  into a per-site audit trail. Attribution is stamped at submission time and cannot be
  reconstructed later. Recommend it at the step 4 checkpoint.
- **Never log or commit the API key or the webhook signing secret.** Read both from
  environment variables (for example `OMNIFENCE_API_KEY` and `OMNIFENCE_WEBHOOK_SECRET`),
  never hard-code them, and keep them out of client-side/browser code — moderation calls
  and webhook handling belong on the server.
- **Do not change the account's moderation configuration** — custom categories, the NSFW
  or text toggles, the signing secret — unless the user explicitly asks. Those settings
  apply to every job the account submits, not just this integration.
