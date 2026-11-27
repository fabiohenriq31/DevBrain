import { CredentialReferenceSchema, type CredentialReference } from '@devbrain/contracts';
import type { CiphertextStore } from '@devbrain/security';
import type { SqlDriver } from '../driver.js';
import { fromJson, json, notFound, validated } from './common.js';

/** Credential metadata. Never contains secret values (see SqliteCiphertextStore). */
export class CredentialRefRepository {
  constructor(private readonly db: SqlDriver) {}

  save(ref: CredentialReference): CredentialReference {
    const r = validated(CredentialReferenceSchema, ref, 'credential reference');
    this.db.run(
      `INSERT INTO credential_refs (id, locator, data) VALUES (:id, :locator, :data)
       ON CONFLICT(id) DO UPDATE SET locator = excluded.locator, data = excluded.data`,
      { id: r.id, locator: r.locator, data: json(r) },
    );
    return r;
  }

  findById(id: string): CredentialReference | null {
    const row = this.db.get<{ data: string }>('SELECT data FROM credential_refs WHERE id = :id', {
      id,
    });
    return row ? fromJson(CredentialReferenceSchema, row.data, 'credential reference') : null;
  }

  list(): CredentialReference[] {
    return this.db
      .all<{ data: string }>('SELECT data FROM credential_refs ORDER BY rowid')
      .map((r) => fromJson(CredentialReferenceSchema, r.data, 'credential reference'));
  }

  delete(id: string): void {
    const { changes } = this.db.run('DELETE FROM credential_refs WHERE id = :id', { id });
    if (changes === 0) throw notFound('Credential', id);
  }
}

/**
 * Stores OS-encrypted ciphertext (DPAPI via Electron safeStorage). Plaintext never reaches
 * this class: `CredentialVault` encrypts before calling `set`.
 */
export class SqliteCiphertextStore implements CiphertextStore {
  constructor(private readonly db: SqlDriver) {}

  async get(locator: string): Promise<Buffer | null> {
    const row = this.db.get<{ ciphertext: Uint8Array }>(
      'SELECT ciphertext FROM credential_secrets WHERE locator = :locator',
      { locator },
    );
    return row ? Buffer.from(row.ciphertext) : null;
  }

  async set(locator: string, ciphertext: Buffer): Promise<void> {
    this.db.run(
      `INSERT INTO credential_secrets (locator, ciphertext, updated_at) VALUES (:locator, :c, :at)
       ON CONFLICT(locator) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      { locator, c: new Uint8Array(ciphertext), at: new Date().toISOString() },
    );
  }

  async delete(locator: string): Promise<boolean> {
    return this.deleteSync(locator);
  }

  /** Synchronous variant, usable inside a transaction. */
  deleteSync(locator: string): boolean {
    return (
      this.db.run('DELETE FROM credential_secrets WHERE locator = :locator', { locator }).changes >
      0
    );
  }
}
