import type {
  ModelRoute,
  PrivacyPolicy,
  ProjectAiPolicy,
  ProjectPrivacyClass,
  ProviderEndpoint,
  ProviderPrivacyProfile,
} from '@devbrain/contracts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A route is local only when it is declared local AND its endpoint really is loopback. */
export const isLocalRoute = (route: ModelRoute, endpoint: ProviderEndpoint): boolean =>
  route.localOnly && LOOPBACK.has(new URL(endpoint.baseUrl).hostname.toLowerCase());

export interface PrivacyVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * PrivacyPolicyService — decides, in the privileged main process, whether a project's content
 * may leave the machine towards a provider. Rules (conservative; `unknown` never helps):
 * - local routes are always eligible (no egress);
 * - `restricted`: local only;
 * - `commercial-confidential`: provider explicitly approved for the project AND verified
 *   `trainingOnInputs = no` AND retention verified as `none` or `limited`;
 * - `personal-private`: provider approved for the project, OR verified `trainingOnInputs = no`;
 * - `public`: any configured provider except verified `trainingOnInputs = yes` unless approved.
 * The legacy gateway PrivacyPolicy (local-only / approved-providers) is applied on top: the
 * stricter of the two always wins.
 */
export class PrivacyPolicyService {
  evaluate(input: {
    route: ModelRoute;
    endpoint: ProviderEndpoint;
    gatewayPolicy: PrivacyPolicy;
    project: ProjectAiPolicy | null;
    profile: ProviderPrivacyProfile | null;
  }): PrivacyVerdict {
    const { route, endpoint, gatewayPolicy, project, profile } = input;
    if (isLocalRoute(route, endpoint)) return { allowed: true, reason: 'local route: no egress' };
    if (gatewayPolicy.mode === 'local-only')
      return { allowed: false, reason: 'gateway policy is local-only: external egress blocked' };
    if (
      gatewayPolicy.mode === 'approved-providers' &&
      !gatewayPolicy.allowedProviderIds.includes(endpoint.providerId)
    )
      return { allowed: false, reason: 'provider not in the gateway allow-list' };
    if (!project) return { allowed: true, reason: 'no project context: gateway policy only' };
    return this.forClass(project.privacyClass, endpoint.providerId, project, profile);
  }

  private forClass(
    cls: ProjectPrivacyClass,
    providerId: string,
    project: ProjectAiPolicy,
    profile: ProviderPrivacyProfile | null,
  ): PrivacyVerdict {
    const approved = project.approvedProviderIds.includes(providerId);
    const verified = !!profile?.verifiedAt;
    const training = verified ? profile.trainingOnInputs : 'unknown';
    const retention = verified ? profile.retention : 'unknown';
    switch (cls) {
      case 'restricted':
        return { allowed: false, reason: 'restricted project: local models only' };
      case 'commercial-confidential':
        if (!approved)
          return { allowed: false, reason: 'confidential project: provider not approved' };
        if (training !== 'no')
          return {
            allowed: false,
            reason: `confidential project: training on inputs is ${training}`,
          };
        if (retention !== 'none' && retention !== 'limited')
          return { allowed: false, reason: `confidential project: retention is ${retention}` };
        return { allowed: true, reason: 'approved provider with verified no-training/retention' };
      case 'personal-private':
        if (approved) return { allowed: true, reason: 'provider approved for this project' };
        if (training === 'no')
          return { allowed: true, reason: 'verified: provider does not train on inputs' };
        return {
          allowed: false,
          reason: `private project: training on inputs is ${training}; approve the provider explicitly`,
        };
      case 'public':
        if (training === 'yes' && !approved)
          return { allowed: false, reason: 'provider trains on inputs; approve it explicitly' };
        return { allowed: true, reason: 'public project' };
    }
  }
}
