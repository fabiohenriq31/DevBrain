/**
 * Contract versioning.
 *
 * Rules (see docs/CONTRACTS.md):
 * - MAJOR: breaking change (field removed/renamed, type narrowed, enum value removed,
 *   IPC channel removed). Requires a new IPC namespace (`devbrain:v2:*`) and an ADR.
 * - MINOR: additive change (optional field, new enum value, new channel).
 * - PATCH: documentation or validation-message only.
 */
export const CONTRACTS_VERSION = '0.4.0' as const;

/** Major version embedded in IPC channel names. */
export const IPC_PROTOCOL_VERSION = 1 as const;

export type ContractsVersion = typeof CONTRACTS_VERSION;
