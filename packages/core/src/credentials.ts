import {
  DevBrainError,
  StoreCredentialInputSchema,
  newId,
  nowTimestamp,
  parseOrThrow,
  type CredentialReference,
  type StoreCredentialInput,
} from '@devbrain/contracts';
import { CredentialVault, type SecretCipher } from '@devbrain/security';
import { audit, type CoreContext } from './context.js';

/**
 * Credentials: references are listed freely, values never leave the main process.
 * - `os-encrypted`: encrypted by the OS cipher (Electron safeStorage → DPAPI on Windows); only
 *   ciphertext is stored in SQLite (`credential_secrets`).
 * - `environment`: only the variable NAME is stored; the value is read at use time.
 */
export class CredentialService {
  private readonly vault: CredentialVault;

  constructor(
    private readonly ctx: CoreContext,
    cipher: SecretCipher,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.vault = new CredentialVault(cipher, ctx.db.secrets);
  }

  async list(): Promise<CredentialReference[]> {
    return this.ctx.db.credentials.list();
  }

  private require(id: string): CredentialReference {
    const ref = this.ctx.db.credentials.findById(id);
    if (!ref) throw new DevBrainError('NOT_FOUND', 'Credential not found', { details: { id } });
    return ref;
  }

  async store(input: StoreCredentialInput): Promise<CredentialReference> {
    const parsed = parseOrThrow(StoreCredentialInputSchema, input);
    if (parsed.providerId && !this.ctx.db.providers.findById(parsed.providerId)) {
      throw new DevBrainError('NOT_FOUND', 'Provider not found');
    }
    const id = newId('credential');
    let hint: string | null = null;
    if (parsed.storage === 'os-encrypted') {
      // Throws CREDENTIAL_UNAVAILABLE when OS encryption is not available: no plaintext fallback.
      hint = (await this.vault.put(id, parsed.secret)).hint;
    }
    const ref: CredentialReference = {
      id,
      label: parsed.label,
      providerId: parsed.providerId ?? null,
      storage: parsed.storage,
      locator: parsed.storage === 'os-encrypted' ? id : parsed.variable,
      hint,
      createdAt: nowTimestamp(),
      lastUsedAt: null,
    };
    try {
      this.ctx.db.driver.transaction(() => {
        this.ctx.db.credentials.save(ref);
        audit(this.ctx, {
          action: 'credential.stored',
          target: id,
          details: { storage: ref.storage, providerId: ref.providerId },
        });
      });
    } catch (error) {
      if (parsed.storage === 'os-encrypted') await this.vault.remove(id).catch(() => false);
      throw error;
    }
    return ref;
  }

  async remove(id: string): Promise<void> {
    const ref = this.require(id);
    const users = this.ctx.db.providers.list().filter((p) => p.provider.credentialRef === id);
    if (users.length > 0) {
      throw new DevBrainError('CONFLICT', 'Providers still reference this credential', {
        details: { providers: users.map((u) => u.provider.id) },
      });
    }
    this.ctx.db.driver.transaction(() => {
      if (ref.storage === 'os-encrypted') this.ctx.db.secrets.deleteSync(ref.locator);
      this.ctx.db.credentials.delete(id);
      audit(this.ctx, {
        action: 'credential.removed',
        target: id,
        details: { storage: ref.storage },
      });
    });
  }

  /**
   * Returns the secret value for immediate use by the execution engine (e.g. to inject an
   * environment variable into a provider process). MAIN PROCESS ONLY: never expose over IPC,
   * never log. Every use is audited.
   */
  async resolve(
    id: string,
    purpose: { agentId?: string; providerId?: string; reason: string },
  ): Promise<string> {
    const ref = this.require(id);
    let value: string;
    if (ref.storage === 'environment') {
      const fromEnv = this.env[ref.locator];
      if (!fromEnv) {
        throw new DevBrainError('CREDENTIAL_UNAVAILABLE', 'Environment variable is not set', {
          details: { variable: ref.locator },
        });
      }
      value = fromEnv;
    } else {
      value = await this.vault.reveal(ref.locator);
    }
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.credentials.save({ ...ref, lastUsedAt: nowTimestamp() });
      audit(this.ctx, {
        action: 'credential.used',
        actor: purpose.agentId
          ? { type: 'agent', agentId: purpose.agentId }
          : { type: 'system', component: 'core' },
        permission: 'credential.use',
        target: id,
        details: { reason: purpose.reason, providerId: purpose.providerId ?? null },
      });
    });
    return value;
  }
}
