#!/usr/bin/env node
/**
 * Drift check, in two halves.
 *
 * Against the published OpenAPI spec: every endpoint path, method, response
 * field, response status, and query parameter the skill relies on must exist,
 * the retired endpoints must not appear at all, and the size limits the skill
 * states must match the ones the spec states.
 *
 * Against the published docs pages: contract facts the spec cannot express —
 * error codes, failed-job `error_code` values, webhook payload fields, and
 * scopes — must match in both directions. A code, field, or scope the docs add
 * that the skill never mentions fails the check, and so does one the skill
 * names that the docs no longer list. Existence of a path is not enough: the
 * old check passed for a month while the webhook contract and the video limit
 * changed underneath the skill.
 *
 * Spec source: https://docs.omnifence.ai/api-reference/openapi.json
 * (exported by the API repo's `yarn export:openapi`, hosted by the docs site).
 * Docs source: the same site's raw markdown (`<page>.md`).
 * Local runs: SPEC_URL=<url or file> and DOCS_URL=<url>, or DOCS_DIR=<the API
 * repo's docs/ directory> to check against unpublished `.mdx` sources.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');
const SPEC_URL = process.env.SPEC_URL ?? 'https://docs.omnifence.ai/api-reference/openapi.json';
const DOCS_URL = (process.env.DOCS_URL ?? 'https://docs.omnifence.ai').replace(/\/$/, '');
const DOCS_DIR = process.env.DOCS_DIR;

/** Retired endpoints and their scopes/slugs. Their reappearance anywhere in the
 * skill text is a hard failure, whatever the spec says. */
const FORBIDDEN = [
  'moderate/prompt',
  'moderate/chat',
  'prompt-moderate',
  'chat-moderate',
  'moderate:prompt',
  'moderate:chat',
];

/** Response fields the skill documents, and the spec schema that must carry them. */
const REQUIRED_FIELDS = [
  { path: '/api/v1/job/{id}', method: 'get', status: '200', fields: ['is_prohibited', 'reason', 'nsfw', 'job_id', 'status', 'completed_at'] },
  { path: '/api/v1/moderate/text', method: 'post', status: '202', fields: ['job_id', 'status'] },
  { path: '/api/v1/moderate/image', method: 'post', status: '202', fields: ['job_id', 'status'] },
  { path: '/api/v1/moderate/video', method: 'post', status: '202', fields: ['job_id', 'status'] },
  { path: '/api/v1/moderate/audio', method: 'post', status: '202', fields: ['job_id', 'status'] },
  { path: '/api/v1/jobs', method: 'get', status: '200', fields: ['jobs'] },
  { path: '/api/v1/me/webhook-secrets', method: 'get', status: '200', fields: ['secrets', 'tolerance_seconds', 'grace_hours'] },
  { path: '/api/v1/me/webhook-secrets/reveal', method: 'post', status: '200', fields: ['secret'] },
  { path: '/api/v1/me/webhook-secrets/rotate', method: 'post', status: '200', fields: ['secret'] },
  { path: '/api/v1/me/moderation-config', method: 'get', status: '200', fields: ['enabled_categories', 'catalogue'] },
  { path: '/api/v1/me/custom-categories', method: 'get', status: '200', fields: ['categories', 'count', 'limit'] },
  // `api_key_id`/`api_key_name` back the one-key-per-call-site guidance in step 8.
  { path: '/api/v1/job/{id}', method: 'get', status: '200', fields: ['type', 'error_code', 'api_key_id', 'api_key_name'] },
  { path: '/api/v1/me/default-categories', method: 'get', status: '200', fields: ['categories'] },
  // The recovery `job_id` on 503 SUBMISSION_STATUS_UNKNOWN: submission-errors.md polls it
  // instead of resubmitting.
  ...['text', 'image', 'video', 'audio'].map((m) => ({
    path: `/api/v1/moderate/${m}`, method: 'post', status: '503', fields: ['job_id'],
  })),
  // Text batch (references/moderate-text-batch.md): the accepted batch, its recovery
  // `batch_id`, the batch read, and the batch fields a job read names.
  { path: '/api/v1/moderate/text/batch', method: 'post', status: '202', fields: ['batch_id', 'status', 'items'] },
  { path: '/api/v1/moderate/text/batch', method: 'post', status: '503', fields: ['batch_id'] },
  { path: '/api/v1/moderate/text/batch/{batch_id}', method: 'get', status: '200', fields: ['type', 'batch_id', 'status', 'completed_at', 'items'] },
  { path: '/api/v1/job/{id}', method: 'get', status: '200', fields: ['batch_id', 'batch_key'] },
  // Shared Registry (skills/omnifence-registry).
  { path: '/api/v1/registry/check', method: 'post', status: '200', fields: ['match', 'signals', 'normalisation_version'] },
  ...['200', '201'].map((status) => ({
    path: '/api/v1/registry/entries', method: 'post', status, fields: ['entry_id', 'status', 'member_case_ref', 'expires_at'],
  })),
  { path: '/api/v1/registry/entries', method: 'get', status: '200', fields: ['entries', 'next_cursor'] },
  { path: '/api/v1/registry/entries/{id}/revoke', method: 'post', status: '200', fields: ['entry_id', 'status', 'revoked_at'] },
];

/** Fields of each item in a response array the skill reads (`signals[]`). */
const REQUIRED_ITEM_FIELDS = [
  {
    path: '/api/v1/moderate/text/batch', method: 'post', status: '202', array: 'items',
    fields: ['key', 'job_id'],
  },
  {
    path: '/api/v1/moderate/text/batch/{batch_id}', method: 'get', status: '200', array: 'items',
    fields: ['key', 'job_id', 'status', 'is_prohibited', 'reason', 'error_code'],
  },
  {
    path: '/api/v1/registry/check', method: 'post', status: '200', array: 'signals',
    fields: ['category', 'reporter_count', 'first_reported_at', 'last_reported_at', 'automated_refusal_permitted'],
  },
];

/** Response statuses the skill tells an integration to handle. */
const REQUIRED_STATUSES = [
  { path: '/api/v1/moderate/video', method: 'post', statuses: ['202', '413', '415', '422', '503'] },
  { path: '/api/v1/moderate/text', method: 'post', statuses: ['202', '503'] },
  { path: '/api/v1/moderate/image', method: 'post', statuses: ['202', '503'] },
  { path: '/api/v1/moderate/audio', method: 'post', statuses: ['202', '503'] },
  { path: '/api/v1/moderate/text/batch', method: 'post', statuses: ['202', '503'] },
  { path: '/api/v1/registry/entries', method: 'post', statuses: ['200', '201'] },
];

/** Enum values the skill branches on. */
const REQUIRED_ENUMS = [
  { path: '/api/v1/job/{id}', method: 'get', status: '200', field: 'status', values: ['queued', 'processing', 'completed', 'failed'] },
  { path: '/api/v1/moderate/text/batch/{batch_id}', method: 'get', status: '200', field: 'status', values: ['processing', 'completed'] },
  { path: '/api/v1/registry/entries', method: 'post', status: '201', field: 'status', values: ['active', 'disputed', 'revoked', 'expired'] },
];

/**
 * Request-body enums the registry skill sends. Both directions: a new category
 * or context is a contract change the skill must describe before members use it.
 */
const REQUIRED_REQUEST_ENUMS = [
  { path: '/api/v1/registry/check', method: 'post', field: 'context', values: ['signup', 'login', 'periodic'] },
  { path: '/api/v1/registry/entries', method: 'post', field: 'category', values: ['payment_fraud', 'prohibited_content', 'ban_evasion'] },
];

/**
 * Numeric limits the skill states. `source` pulls the authoritative value(s) out
 * of the spec or a docs page; each `skill` entry pulls every statement of the
 * same limit out of one skill file. Every statement must equal the source, and
 * each file must state it at least once.
 */
const LIMITS = [
  {
    name: 'video size (MB)',
    source: { spec: ['/api/v1/moderate/video', 'post'], re: /larger than (\d+) MB/ },
    skill: [
      { file: 'references/moderate-video.md', re: /(\d+) MB/g },
      { file: 'SKILL.md', re: /Generated video[^\n]*?≤ (\d+) MB/g },
    ],
  },
  {
    name: 'audio size (MB)',
    source: { spec: ['/api/v1/moderate/audio', 'post'], re: /no larger than (\d+) MB/ },
    skill: [
      { file: 'references/moderate-audio.md', re: /(\d+) MB/g },
      { file: 'SKILL.md', re: /Generated audio[^\n]*?≤ (\d+) MB/g },
    ],
  },
  {
    name: 'audio duration (minutes)',
    source: { spec: ['/api/v1/moderate/audio', 'post'], re: /no longer than (\d+) minutes/ },
    skill: [
      { file: 'references/moderate-audio.md', re: /(\d+) minutes/g },
      { file: 'SKILL.md', re: /Generated audio[^\n]*?≤ (\d+) minutes/g },
    ],
  },
  {
    name: 'text length (characters)',
    source: { doc: 'api-reference/endpoint/text-moderate', re: /limited to ([\d,]+) characters/ },
    skill: [
      { file: 'references/moderate-text.md', re: /([\d,]+) characters/g },
      { file: 'references/submission-errors.md', re: /([\d,]+) characters/g },
      { file: 'SKILL.md', re: /([\d,]+) characters/g },
    ],
  },
];

/** Backticked UPPER_SNAKE tokens that are not API codes (env vars and the like). */
const NOT_A_CODE = /^OMNIFENCE_/;

/** Query parameters the skill tells an integration to send. */
const REQUIRED_PARAMS = [
  { path: '/api/v1/jobs', method: 'get', params: ['status'] },
  { path: '/api/v1/jobs/export', method: 'get', params: ['from', 'to'] },
  { path: '/api/v1/registry/entries', method: 'get', params: ['limit', 'cursor', 'status'] },
];

async function loadSpec() {
  if (!/^https?:\/\//.test(SPEC_URL)) {
    return JSON.parse(await readFile(SPEC_URL, 'utf8'));
  }
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`Failed to fetch spec (${res.status}) from ${SPEC_URL}`);
  return res.json();
}

/** Raw markdown of one docs page: `<page>.md` from the site, or `<page>.mdx` from DOCS_DIR. */
async function loadDoc(page) {
  if (DOCS_DIR) return readFile(join(DOCS_DIR, `${page}.mdx`), 'utf8');
  const url = `${DOCS_URL}/${page}.md`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch docs page (${res.status}) from ${url}`);
  return res.text();
}

/** The backticked first-column values of every markdown table row in `text`. */
function tableKeys(text) {
  const keys = [];
  for (const m of text.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) keys.push(m[1]);
  return keys;
}

/** `text` from a `### heading` (or `## heading`) up to the next heading of the same level or higher. */
function section(text, heading) {
  const start = text.search(new RegExp(`^#{2,3} ${heading}\\s*$`, 'm'));
  if (start === -1) return null;
  const level = text.slice(start).match(/^#+/)[0].length;
  const rest = text.slice(start + level + 1);
  const end = rest.search(new RegExp(`^#{2,${level}} `, 'm'));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every UPPER_SNAKE code inside backticks, with or without a leading status (`404 JOB_NOT_FOUND`). */
function backtickedCodes(text) {
  const codes = new Set();
  for (const m of text.matchAll(/`(?:\d{3} )?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) {
    if (!NOT_A_CODE.test(m[1])) codes.add(m[1]);
  }
  return codes;
}

function backtickedScopes(text) {
  const scopes = new Set();
  for (const m of text.matchAll(/`([a-z]+:[a-z]+)`/g)) scopes.add(m[1]);
  return scopes;
}

async function collectMarkdown(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const path = join(entry.parentPath ?? entry.path, entry.name);
      files.push({ path, text: await readFile(path, 'utf8') });
    }
  }
  if (files.length === 0) throw new Error(`No markdown files found under ${dir}`);
  return files;
}

/** Expand `/moderate/{text,image}` brace sets; normalise a JS `${var}` to the `{*}` wildcard. */
function extractReferences(text) {
  const refs = [];
  const cleaned = text.replace(/\$\{[^}]*\}/g, '{*}');
  const re = /(?:\b(GET|POST|PUT|DELETE)\s+)?(\/api\/v1\/[A-Za-z0-9_\-/{},$*]+)/g;
  for (const match of cleaned.matchAll(re)) {
    const method = match[1]?.toLowerCase();
    let path = match[2].split('?')[0].replace(/[/,.]+$/, '');
    const braceSet = path.match(/\{([^}]*,[^}]*)\}/);
    if (braceSet) {
      for (const option of braceSet[1].split(',')) {
        refs.push({ method, path: path.replace(braceSet[0], option) });
      }
    } else {
      refs.push({ method, path });
    }
  }
  return refs;
}

/**
 * Match a documented path against spec paths. A documented `{param}` matches a spec
 * `{param}`; a `{*}` (a JS interpolation, such as `/moderate/${endpoint}`) matches any
 * segment, because the code fills it at run time.
 */
function findSpecPath(specPaths, docPath) {
  const docSegs = docPath.split('/');
  return specPaths.find((specPath) => {
    const specSegs = specPath.split('/');
    if (specSegs.length !== docSegs.length) return false;
    return specSegs.every((seg, i) => {
      const isParam = (s) => s.startsWith('{') && s.endsWith('}');
      return seg === docSegs[i] || docSegs[i] === '{*}' || (isParam(seg) && isParam(docSegs[i]));
    });
  });
}

function operationParams(spec, { path, method }) {
  const params = spec.paths?.[path]?.[method]?.parameters;
  return Array.isArray(params) ? params.map((p) => p.name) : null;
}

function schemaProperties(spec, { path, method, status }) {
  const schema = spec.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
  return schema?.properties ?? null;
}

const spec = await loadSpec();
const specPaths = Object.keys(spec.paths ?? {});
const files = await collectMarkdown(SKILLS_DIR);
const errors = [];

for (const { path: file, text } of files) {
  const rel = file.slice(ROOT.length + 1);

  for (const needle of FORBIDDEN) {
    if (text.toLowerCase().includes(needle)) {
      errors.push(`${rel}: references the retired endpoint form "${needle}"`);
    }
  }

  for (const { method, path } of extractReferences(text)) {
    // The skill names /api/v1/admin/* only to forbid touching it; admin routes
    // are deliberately absent from the public spec.
    if (path.startsWith('/api/v1/admin')) continue;
    const specPath = findSpecPath(specPaths, path);
    if (!specPath) {
      errors.push(`${rel}: path ${path} is not in the published spec`);
    } else if (method && !spec.paths[specPath][method]) {
      errors.push(`${rel}: ${method.toUpperCase()} ${path} — method not in the published spec`);
    }
  }
}

for (const check of REQUIRED_FIELDS) {
  const props = schemaProperties(spec, check);
  if (!props) {
    errors.push(`spec: no ${check.status} JSON schema for ${check.method.toUpperCase()} ${check.path}`);
    continue;
  }
  for (const field of check.fields) {
    if (!(field in props)) {
      errors.push(`spec: field "${field}" missing from ${check.method.toUpperCase()} ${check.path} ${check.status} response`);
    }
  }
}

for (const check of REQUIRED_PARAMS) {
  const names = operationParams(spec, check);
  if (!names) {
    errors.push(`spec: no parameters on ${check.method.toUpperCase()} ${check.path}`);
    continue;
  }
  for (const param of check.params) {
    if (!names.includes(param)) {
      errors.push(`spec: query param "${param}" missing from ${check.method.toUpperCase()} ${check.path}`);
    }
  }
}

for (const check of REQUIRED_STATUSES) {
  const responses = spec.paths?.[check.path]?.[check.method]?.responses ?? {};
  for (const status of check.statuses) {
    if (!(status in responses)) {
      errors.push(`spec: ${check.method.toUpperCase()} ${check.path} no longer documents a ${status} response`);
    }
  }
}

for (const check of REQUIRED_ENUMS) {
  const values = schemaProperties(spec, check)?.[check.field]?.enum;
  if (!Array.isArray(values)) {
    errors.push(`spec: no enum for "${check.field}" on ${check.method.toUpperCase()} ${check.path} ${check.status}`);
    continue;
  }
  for (const v of values) {
    if (!check.values.includes(v)) {
      errors.push(`spec: "${check.field}" on ${check.method.toUpperCase()} ${check.path} gained the value "${v}" the skill does not handle`);
    }
  }
  for (const v of check.values) {
    if (!values.includes(v)) {
      errors.push(`spec: "${check.field}" on ${check.method.toUpperCase()} ${check.path} lost the value "${v}" the skill branches on`);
    }
  }
}

for (const check of REQUIRED_ITEM_FIELDS) {
  const items = schemaProperties(spec, check)?.[check.array]?.items?.properties;
  if (!items) {
    errors.push(`spec: no item schema for "${check.array}" on ${check.method.toUpperCase()} ${check.path} ${check.status}`);
    continue;
  }
  for (const field of check.fields) {
    if (!(field in items)) {
      errors.push(`spec: field "${check.array}[].${field}" missing from ${check.method.toUpperCase()} ${check.path} ${check.status} response`);
    }
  }
}

for (const check of REQUIRED_REQUEST_ENUMS) {
  const values = spec.paths?.[check.path]?.[check.method]?.requestBody?.content?.['application/json']?.schema?.properties?.[check.field]?.enum;
  if (!Array.isArray(values)) {
    errors.push(`spec: no request enum for "${check.field}" on ${check.method.toUpperCase()} ${check.path}`);
    continue;
  }
  for (const v of values) {
    if (!check.values.includes(v)) {
      errors.push(`spec: request "${check.field}" on ${check.method.toUpperCase()} ${check.path} gained the value "${v}" the skill does not describe`);
    }
  }
  for (const v of check.values) {
    if (!values.includes(v)) {
      errors.push(`spec: request "${check.field}" on ${check.method.toUpperCase()} ${check.path} lost the value "${v}" the skill sends`);
    }
  }
}

// --- Docs-page checks -------------------------------------------------------

const skillFile = (name, skill = 'omnifence-integration') => {
  const hit = files.find((f) => f.path.endsWith(`/${skill}/${name}`));
  if (!hit) {
    errors.push(`${skill}/${name}: the file the drift check reads is missing`);
    return '';
  }
  return hit.text;
};
const allSkillText = files.map((f) => f.text).join('\n');
const normalise = (n) => n.replace(/,/g, '');

const docs = Object.fromEntries(
  await Promise.all(
    [
      'errors',
      'platform/error-recovery',
      'platform/webhooks',
      'authentication',
      'api-reference/endpoint/text-moderate',
      'registry/errors',
      'registry/categories',
      'registry/hashing',
    ].map(
      async (page) => [page, await loadDoc(page)],
    ),
  ),
);

for (const limit of LIMITS) {
  const sourceText = limit.source.spec
    ? spec.paths?.[limit.source.spec[0]]?.[limit.source.spec[1]]?.description ?? ''
    : docs[limit.source.doc];
  const expected = sourceText.match(limit.source.re)?.[1];
  if (!expected) {
    errors.push(`limits: the source no longer states the ${limit.name} (pattern ${limit.source.re})`);
    continue;
  }
  for (const { file, re } of limit.skill) {
    const found = [...skillFile(file).matchAll(re)].map((m) => m[1]);
    if (found.length === 0) errors.push(`${file}: does not state the ${limit.name} (${expected})`);
    for (const value of found) {
      if (normalise(value) !== normalise(expected)) {
        errors.push(`${file}: states the ${limit.name} as ${value}; the API says ${expected}`);
      }
    }
  }
}

// API error codes (errors page table) and failed-job `error_code` values
// (error-recovery bullets, webhooks table): every one must appear in the skill.
const errorCodes = tableKeys(docs['errors']);
const jobErrorCodes = [
  ...[...docs['platform/error-recovery'].matchAll(/^[-*] `([A-Z][A-Z0-9_]+)`:/gm)].map((m) => m[1]),
  ...tableKeys(section(docs['platform/webhooks'], 'Failed job') ?? ''),
];
if (errorCodes.length === 0) errors.push('docs: no error code table found on the errors page');
if (jobErrorCodes.length === 0) errors.push('docs: no failed-job error_code values found');
for (const code of new Set([...errorCodes, ...jobErrorCodes])) {
  if (!allSkillText.includes(code)) {
    errors.push(`docs: the error code ${code} is documented but the skill never handles it`);
  }
}

// The reverse: every code the skill names must still be documented somewhere.
const documentedCodes = new Set(Object.values(docs).flatMap((text) => [...backtickedCodes(text)]));
for (const code of backtickedCodes(allSkillText)) {
  if (!documentedCodes.has(code)) {
    errors.push(`skill: names the code ${code}, which the docs no longer list`);
  }
}

// Webhook payload fields: the docs table must match the webhook reference.
const webhookFields = tableKeys(section(docs['platform/webhooks'], 'Fields') ?? '');
if (webhookFields.length === 0) errors.push('docs: no webhook payload field table found');
const handlerText = skillFile('references/webhook-handler.md');
for (const field of webhookFields) {
  if (!handlerText.includes(`\`${field}\``)) {
    errors.push(`references/webhook-handler.md: webhook payload field "${field}" is documented but not covered`);
  }
}

// Scopes, both directions.
const docScopes = new Set(tableKeys(docs['authentication']).filter((k) => /^[a-z]+:[a-z]+$/.test(k)));
if (docScopes.size === 0) errors.push('docs: no scope table found on the authentication page');
for (const scope of docScopes) {
  if (!allSkillText.includes(`\`${scope}\``)) {
    errors.push(`docs: the scope ${scope} is documented but the skill never names it`);
  }
}
for (const scope of backtickedScopes(allSkillText)) {
  if (docScopes.size > 0 && !docScopes.has(scope)) {
    errors.push(`skill: names the scope ${scope}, which the docs no longer list`);
  }
}

// --- Shared Registry --------------------------------------------------------

// Categories: the docs table and the registry skill must name the same set.
const registrySkill = skillFile('SKILL.md', 'omnifence-registry');
const docCategories = tableKeys(docs['registry/categories']).filter((k) => /^[a-z_]+$/.test(k));
if (docCategories.length === 0) errors.push('docs: no category table found on registry/categories');
for (const category of docCategories) {
  if (!registrySkill.includes(`\`${category}\``)) {
    errors.push(`omnifence-registry/SKILL.md: the category ${category} is documented but the skill never names it`);
  }
}
for (const category of REQUIRED_REQUEST_ENUMS.find((c) => c.field === 'category').values) {
  if (docCategories.length > 0 && !docCategories.includes(category)) {
    errors.push(`docs: registry/categories no longer lists the category ${category} the skill reports`);
  }
}

/** Rows of the hashing test-vector table: [input, normalised | null, sha256 | null]. */
function hashingVectors(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 3 || !cells[0].startsWith('`')) continue;
    const unquote = (c) => (c.startsWith('`') ? c.slice(1, -1) : null);
    rows.push([unquote(cells[0]).replaceAll('\u2420', ' '), unquote(cells[1]), unquote(cells[2])]);
  }
  return rows;
}

// Hashing: the skill's vector table must equal the published one, and the
// skill's reference implementation must reproduce every published vector. A
// wrong copy here would make a member's reports match nobody.
const hashingRef = skillFile('references/hashing.md', 'omnifence-registry');
const docVectors = hashingVectors(docs['registry/hashing']);
const skillVectors = hashingVectors(hashingRef);
if (docVectors.length === 0) errors.push('docs: no test-vector table found on registry/hashing');
if (JSON.stringify(skillVectors) !== JSON.stringify(docVectors)) {
  errors.push('omnifence-registry/references/hashing.md: the test vectors differ from registry/hashing');
}
const docVersion = docs['registry/hashing'].match(/The rules on this page are version `(\d+)`/)?.[1];
if (!docVersion) errors.push('docs: registry/hashing no longer states the normalisation version');
else if (!hashingRef.includes(`normalisation version \`${docVersion}\``)) {
  errors.push(`omnifence-registry/references/hashing.md: does not state normalisation version ${docVersion}`);
}
const implementation = hashingRef.match(/```javascript\n([\s\S]*?export function registryDigest[\s\S]*?)```/)?.[1];
if (!implementation) {
  errors.push('omnifence-registry/references/hashing.md: no reference implementation found');
} else if (docVectors.length > 0) {
  const dir = await mkdtemp(join(tmpdir(), 'omnifence-hash-'));
  try {
    const file = join(dir, 'registry-hash.mjs');
    await writeFile(file, implementation);
    const { normaliseEmail, registryDigest } = await import(pathToFileURL(file).href);
    for (const [input, normalised, sha256] of docVectors) {
      const gotNormalised = normaliseEmail(input);
      const gotDigest = registryDigest(input);
      if (gotNormalised !== normalised || gotDigest !== sha256) {
        errors.push(
          `omnifence-registry/references/hashing.md: ${JSON.stringify(input)} gives ${gotNormalised} / ${gotDigest}; the docs say ${normalised} / ${sha256}`,
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const docsSource = DOCS_DIR ?? DOCS_URL;
if (errors.length > 0) {
  console.error(`Drift check FAILED against ${SPEC_URL} and ${docsSource}:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.warn(`Drift check passed: ${files.length} skill file(s) match ${SPEC_URL} and ${docsSource}`);
