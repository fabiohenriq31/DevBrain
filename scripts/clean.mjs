#!/usr/bin/env node
/** Removes build outputs (never node_modules or user data). */
import { rm } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const patterns = [
  'packages/*/dist',
  'packages/*/*.tsbuildinfo',
  'packages/*/tsconfig.tsbuildinfo',
  'apps/*/out',
  'coverage',
];
for (const pattern of patterns) {
  for await (const entry of glob(pattern)) {
    await rm(entry, { recursive: true, force: true });
    console.log(`removed ${entry}`);
  }
}
