#!/usr/bin/env node
/**
 * Drift check: every endpoint path, method, and response field named in the
 * skill text must exist in the published Omnifence OpenAPI spec, and the
 * retired endpoints must not appear at all.
 *
 * Spec source: https://docs.omnifence.ai/api-reference/openapi.json
 * (exported by the API repo's `yarn export:openapi`, hosted by the docs site).
 * Override with SPEC_URL=<url or local file path> for local runs.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');
const SPEC_URL = process.env.SPEC_URL ?? 'https://docs.omnifence.ai/api-reference/openapi.json';

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
];

async function loadSpec() {
  if (!/^https?:\/\//.test(SPEC_URL)) {
    return JSON.parse(await readFile(SPEC_URL, 'utf8'));
  }
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`Failed to fetch spec (${res.status}) from ${SPEC_URL}`);
  return res.json();
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

/** Expand `/moderate/{text,image}` brace sets; normalise `${var}` to `{id}`. */
function extractReferences(text) {
  const refs = [];
  const cleaned = text.replace(/\$\{[^}]*\}/g, '{id}');
  const re = /(?:\b(GET|POST|PUT|DELETE)\s+)?(\/api\/v1\/[A-Za-z0-9_\-/{},$]+)/g;
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

/** Match a documented path against spec paths, treating `{param}` as a wildcard segment. */
function findSpecPath(specPaths, docPath) {
  const docSegs = docPath.split('/');
  return specPaths.find((specPath) => {
    const specSegs = specPath.split('/');
    if (specSegs.length !== docSegs.length) return false;
    return specSegs.every((seg, i) => {
      const isParam = (s) => s.startsWith('{') && s.endsWith('}');
      return seg === docSegs[i] || (isParam(seg) && isParam(docSegs[i]));
    });
  });
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

if (errors.length > 0) {
  console.error(`Drift check FAILED against ${SPEC_URL}:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.warn(`Drift check passed: ${files.length} skill file(s) match ${SPEC_URL}`);
