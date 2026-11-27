#!/usr/bin/env node
/**
 * Pre-publication guard: scans files tracked (or staged) by git for secrets and for local
 * artifacts that must never be published (databases, logs, env files, keys).
 * Exit code 1 on any finding. Run by `pnpm validate` and recommended as a pre-push step.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const FORBIDDEN_FILES = [
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/,
  /\.(db|sqlite|sqlite3|db-wal|db-shm|log|pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)\.claude\/settings\.local\.json$/,
];

const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abposr]-[0-9A-Za-z-]{20,}/],
];

// Test fixtures intentionally contain fake secret-shaped strings.
const ALLOW_CONTENT = [/\.test\.ts$/, /^scripts\/check-secrets\.mjs$/];

const findings = [];
for (const file of files) {
  if (FORBIDDEN_FILES.some((re) => re.test(file))) findings.push(`${file}: forbidden file type`);
  if (ALLOW_CONTENT.some((re) => re.test(file))) continue;
  let stats;
  try {
    stats = statSync(file);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > 2 * 1024 * 1024) continue;
  const text = readFileSync(file, 'utf8');
  for (const [name, re] of SECRET_PATTERNS)
    if (re.test(text)) findings.push(`${file}: possible ${name}`);
}

if (findings.length) {
  console.error(`Secret scan failed:\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log(`Secret scan OK (${files.length} files).`);
