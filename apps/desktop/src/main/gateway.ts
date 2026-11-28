import { AiGateway } from '@devbrain/ai-gateway';
import { DevBrainError } from '@devbrain/contracts';
import type { CoreServices } from '@devbrain/core';

/** Resolve only credentials referenced by a persisted connection to this AI provider. */
export const createGatewayForCore = (core: CoreServices): AiGateway => {
  const gateway = new AiGateway(core.db.driver, async (id, providerId) => {
    const ref = (await core.credentials.list()).find((item) => item.id === id);
    const bound = gateway
      .connections()
      .some((connection) => connection.credentialId === id && connection.providerId === providerId);
    if (!ref || (ref.providerId && ref.providerId !== providerId) || !bound)
      throw new DevBrainError('PERMISSION_DENIED', 'Credential is not bound to this provider');
    return core.credentials.resolve(id, { providerId, reason: 'ai.inference' });
  });
  return gateway;
};
