import type { AgentCapabilities, EnforcementLevel, PermissionPolicy } from '@devbrain/contracts';
import { evaluatePermission } from './policy.js';

/**
 * Translates what an integration can enforce into the constraints the execution engine must
 * apply. When DevBrain cannot intercept individual actions, the MOST RESTRICTIVE supported
 * mode is required and the limitation is surfaced to the user before the session runs.
 */
export interface EnforcementPlan {
  level: EnforcementLevel;
  /**
   * For `adapter-sandbox`: the mode the adapter must configure on the agent.
   * `read-only` when the policy does not auto-allow writes; otherwise `workspace-write`.
   */
  sandboxMode: 'read-only' | 'workspace-write' | null;
  /** Network may be enabled for the agent process. */
  networkAllowed: boolean;
  /**
   * The user must approve running this agent at all (per session) because DevBrain cannot
   * constrain it beyond the working directory.
   */
  requiresSessionApproval: boolean;
  /** Human-readable limitations to display (pt-BR UI translates by id). */
  limitations: { id: string; message: string }[];
}

export const planEnforcement = (
  capabilities: AgentCapabilities,
  policy: PermissionPolicy,
  workspaceAllowsNetwork: boolean,
): EnforcementPlan => {
  const level: EnforcementLevel = capabilities.enforcement ?? 'none';
  const writes = evaluatePermission(policy, { action: 'fs.write' }).decision;
  const network =
    workspaceAllowsNetwork &&
    evaluatePermission(policy, { action: 'network.request' }).decision === 'allow';
  const limitations: EnforcementPlan['limitations'] = [];

  if (level === 'per-action') {
    return {
      level,
      sandboxMode: null,
      networkAllowed: network,
      requiresSessionApproval: false,
      limitations,
    };
  }
  if (level === 'adapter-sandbox') {
    limitations.push({
      id: 'no-per-action-interception',
      message:
        'Individual file and command actions are not intercepted by DevBrain; the agent runs in its own restricted mode.',
    });
    if (!network) {
      limitations.push({
        id: 'network-depends-on-adapter',
        message: 'Network access is disabled through the adapter configuration only.',
      });
    }
    return {
      level,
      sandboxMode: writes === 'allow' ? 'workspace-write' : 'read-only',
      networkAllowed: network,
      requiresSessionApproval: writes !== 'allow',
      limitations,
    };
  }
  limitations.push({
    id: 'no-enforcement',
    message:
      'DevBrain cannot constrain this agent: it acts with your user permissions. Only the working directory and session approval apply.',
  });
  limitations.push({
    id: 'worktree-not-sandbox',
    message: 'Git worktrees isolate code changes, not access to the file system.',
  });
  return {
    level,
    sandboxMode: null,
    networkAllowed: network,
    requiresSessionApproval: true,
    limitations,
  };
};
