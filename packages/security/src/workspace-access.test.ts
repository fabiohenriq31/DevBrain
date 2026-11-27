import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_CAPABILITIES, type WorkspaceAccessPolicy } from '@devbrain/contracts';
import { checkWorkspaceAccess } from './workspace-access.js';
import { planEnforcement } from './enforcement.js';
import { createDefaultPolicy } from './policy.js';
import { RotatingFileLogger } from './logger.js';

let base: string;
let root: string;
let outside: string;
let access: WorkspaceAccessPolicy;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'devbrain-sec-')));
  root = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'x');
  access = { allowedRoots: [root], readOnlyRoots: [path.join(root, 'docs')], allowNetwork: false };
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('workspace access (real paths)', () => {
  it('allows in-scope paths, including not-yet-existing files', async () => {
    const r = await checkWorkspaceAccess(access, path.join(root, 'src', 'new-file.ts'), 'write');
    expect(r).toMatchObject({ allowed: true, relativePath: 'src/new-file.ts' });
    expect(await checkWorkspaceAccess(access, 'src/index.ts', 'read')).toMatchObject({
      allowed: true,
    });
  });

  it('rejects traversal, other roots and invalid syntax', async () => {
    expect(
      await checkWorkspaceAccess(access, path.join(root, '..', 'outside', 'secret.txt'), 'read'),
    ).toMatchObject({
      allowed: false,
      reason: 'outside-scope',
    });
    expect(
      await checkWorkspaceAccess(access, path.join(outside, 'secret.txt'), 'read'),
    ).toMatchObject({ allowed: false });
    expect(await checkWorkspaceAccess(access, 'src\0x', 'read')).toMatchObject({
      allowed: false,
      reason: 'invalid-path',
    });
  });

  it('resolves junctions/symlinks before checking containment', async () => {
    await symlink(
      outside,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const viaLink = await checkWorkspaceAccess(
      access,
      path.join(root, 'link', 'secret.txt'),
      'read',
    );
    expect(viaLink.allowed).toBe(false);
    // A link pointing inside the workspace stays allowed, reported by its real path.
    await symlink(
      path.join(root, 'src'),
      path.join(root, 'src-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const inner = await checkWorkspaceAccess(access, path.join(root, 'src-link', 'a.ts'), 'read');
    expect(inner).toMatchObject({ allowed: true, relativePath: 'src/a.ts' });
  });

  it('enforces read-only roots and excluded globs (defaults + project)', async () => {
    expect(await checkWorkspaceAccess(access, 'docs/readme.md', 'write')).toMatchObject({
      allowed: false,
      reason: 'read-only',
    });
    expect(await checkWorkspaceAccess(access, 'docs/readme.md', 'read')).toMatchObject({
      allowed: true,
    });
    for (const p of ['.env', 'config/.env.local', 'keys/server.pem', '.ssh/id_rsa', '.npmrc']) {
      expect(await checkWorkspaceAccess(access, p, 'read')).toMatchObject({
        allowed: false,
        reason: 'excluded',
      });
    }
    expect(await checkWorkspaceAccess(access, 'vault/a.txt', 'read', ['vault/**'])).toMatchObject({
      reason: 'excluded',
    });
  });
});

describe('enforcement plan', () => {
  const policy = createDefaultPolicy('pol_00000000-0000-4000-8000-000000000000');

  it('requires per-session approval when the integration cannot enforce', () => {
    const plan = planEnforcement(NO_CAPABILITIES, policy, true);
    expect(plan).toMatchObject({
      level: 'none',
      requiresSessionApproval: true,
      networkAllowed: false,
    });
    expect(plan.limitations.map((l) => l.id)).toEqual(['no-enforcement', 'worktree-not-sandbox']);
  });

  it('uses the most restrictive sandbox an adapter supports', () => {
    const readOnlyPolicy = {
      ...policy,
      rules: [...policy.rules, { action: 'fs.write' as const, decision: 'ask' as const }],
    };
    const caps = { ...NO_CAPABILITIES, enforcement: 'adapter-sandbox' as const };
    expect(planEnforcement(caps, policy, false)).toMatchObject({
      sandboxMode: 'workspace-write',
      requiresSessionApproval: false,
    });
    expect(planEnforcement(caps, readOnlyPolicy, false)).toMatchObject({
      sandboxMode: 'read-only',
      requiresSessionApproval: true,
    });
    expect(
      planEnforcement({ ...NO_CAPABILITIES, enforcement: 'per-action' }, policy, false),
    ).toMatchObject({
      level: 'per-action',
      requiresSessionApproval: false,
      limitations: [],
    });
  });
});

describe('rotating file logger', () => {
  it('redacts secrets and bounds disk usage', () => {
    const dir = path.join(base, 'logs');
    const logger = new RotatingFileLogger({
      directory: dir,
      maxFileBytes: 64 * 1024,
      maxFiles: 3,
    }).child('test');
    logger.log('info', 'token sk-abcdefghijklmnopqrstuvwxyz0123 used', {
      password: 'hunter2',
      nested: { apiKey: 'k' },
    });
    const first = readFileSync(path.join(dir, 'devbrain.log'), 'utf8');
    expect(first).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(first).not.toContain('hunter2');
    expect(JSON.parse(first.trim())).toMatchObject({ level: 'info', component: 'app.test' });
    logger.log('debug', 'below min level');
    expect(readFileSync(path.join(dir, 'devbrain.log'), 'utf8')).not.toContain('below min level');

    for (let i = 0; i < 2000; i += 1) logger.log('info', `line ${i} ${'x'.repeat(200)}`);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['devbrain.1.log', 'devbrain.2.log', 'devbrain.log']);
    const total = files.reduce((n, f) => n + readFileSync(path.join(dir, f)).length, 0);
    expect(total).toBeLessThanOrEqual(3 * 64 * 1024 + 4096);
  });
});
