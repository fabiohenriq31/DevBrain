/**
 * @devbrain/git-engine — owner: Codex (Phase 01, branch phase-01/codex-engine).
 *
 * Not implemented yet. This package will implement `GitService` from `@devbrain/contracts`
 * by invoking the system `git` executable (no shell) and parsing machine-readable output
 * (`--porcelain=v2`). Worktrees isolate code changes between tasks; they are not a
 * security boundary (docs/SECURITY.md).
 */
export type { GitService } from '@devbrain/contracts';

export const GIT_ENGINE_IMPLEMENTED = false as const;
