import { DevBrainError } from '@devbrain/contracts';

/**
 * Credential vault. Secrets are encrypted with an OS-backed cipher (Electron `safeStorage`,
 * which uses DPAPI on Windows) and stored as ciphertext by a pluggable store. Only the main
 * process holds a vault; the renderer and agents only see `CredentialReference` ids.
 */

/** Subset of Electron's `safeStorage` API, injected so this package stays Electron-free. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Persists ciphertext only. */
export interface CiphertextStore {
  get(locator: string): Promise<Buffer | null>;
  set(locator: string, ciphertext: Buffer): Promise<void>;
  delete(locator: string): Promise<boolean>;
}

const LOCATOR = /^[A-Za-z0-9_.:-]{1,200}$/;

export class CredentialVault {
  constructor(
    private readonly cipher: SecretCipher,
    private readonly store: CiphertextStore,
  ) {}

  private ensureAvailable(): void {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new DevBrainError(
        'CREDENTIAL_UNAVAILABLE',
        'OS encryption is not available; refusing to store secrets',
      );
    }
  }

  private static check(locator: string): void {
    if (!LOCATOR.test(locator))
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid credential locator');
  }

  async put(locator: string, secret: string): Promise<{ hint: string | null }> {
    CredentialVault.check(locator);
    if (secret.length === 0) throw new DevBrainError('VALIDATION_FAILED', 'Empty secret');
    this.ensureAvailable();
    await this.store.set(locator, this.cipher.encryptString(secret));
    return { hint: secret.length >= 12 ? secret.slice(-4) : null };
  }

  /** Returns the plaintext. Callers must use it immediately and never log or return it over IPC. */
  async reveal(locator: string): Promise<string> {
    CredentialVault.check(locator);
    this.ensureAvailable();
    const ciphertext = await this.store.get(locator);
    if (!ciphertext) throw new DevBrainError('NOT_FOUND', 'Credential not found');
    return this.cipher.decryptString(ciphertext);
  }

  async has(locator: string): Promise<boolean> {
    CredentialVault.check(locator);
    return (await this.store.get(locator)) !== null;
  }

  async remove(locator: string): Promise<boolean> {
    CredentialVault.check(locator);
    return this.store.delete(locator);
  }
}

/** In-memory store, for tests and ephemeral sessions. */
export class MemoryCiphertextStore implements CiphertextStore {
  private readonly data = new Map<string, Buffer>();
  get(locator: string): Promise<Buffer | null> {
    return Promise.resolve(this.data.get(locator) ?? null);
  }
  set(locator: string, ciphertext: Buffer): Promise<void> {
    this.data.set(locator, Buffer.from(ciphertext));
    return Promise.resolve();
  }
  delete(locator: string): Promise<boolean> {
    return Promise.resolve(this.data.delete(locator));
  }
}
