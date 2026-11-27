/**
 * @devbrain/execution-engine — owner: Codex (Phase 01, branch phase-01/codex-engine).
 *
 * Not implemented yet. This package will provide the `SessionService` and
 * `ExecutionService` implementations from `@devbrain/contracts`, running agent processes
 * through `@devbrain/provider-sdk` adapters under `@devbrain/security` policies.
 * See docs/PHASE_01.md (block "Codex") for the scope and acceptance criteria.
 */
export type {
  ExecutionService,
  SessionService,
  ExecutionEventListener,
  Unsubscribe,
} from '@devbrain/contracts';

export const EXECUTION_ENGINE_IMPLEMENTED = false as const;
