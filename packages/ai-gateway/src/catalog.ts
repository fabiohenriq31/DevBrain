import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CatalogSnapshotSchema,
  DevBrainError,
  ProviderCatalogEntrySchema,
  parseOrThrow,
  type CatalogSnapshot,
  type ProviderCatalogEntry,
} from '@devbrain/contracts';
import type { SqlDriver } from '@devbrain/database';
import { SPECIFIC_CONNECTION_PROFILES } from './profiles.js';

const ImportEntry = ProviderCatalogEntrySchema.extend({
  siteUrl: z.url().nullable(),
  endpointUrl: z.url().nullable(),
  authType: z.enum(['api-key', 'oauth', 'none', 'unknown']),
  offer: z.enum([
    'recurring-free',
    'trial',
    'promotional-credit',
    'subscription',
    'paid',
    'local',
    'unknown',
  ]),
  requiresCard: z.boolean().nullable(),
  regionalRestrictions: z.string().nullable(),
  commercialUse: z.enum(['allowed', 'restricted', 'unknown']),
  retentionPolicyUrl: z.url().nullable(),
  trainingPolicyUrl: z.url().nullable(),
  knownModelIds: z.array(z.string().min(1)).max(1000),
  publishedQuotaIds: z.array(z.string().min(1)).max(100),
  quotaScope: z.string().nullable(),
  consumptionUnit: z.string().nullable(),
  verificationState: z.enum([
    'discovered',
    'documented',
    'configured',
    'authenticated',
    'operational',
    'qualified',
    'unavailable',
    'discontinued',
  ]),
  sourceUrls: z.array(z.url()).min(1).max(20),
  dataLicense: z.string().min(1),
}).strict();
export type CatalogImportEntry = z.infer<typeof ImportEntry>;

const ImportDocument = z
  .object({
    formatVersion: z.literal(1),
    sourceId: z.string().min(2).max(128),
    revision: z.string().min(1).max(200),
    license: z.string().min(1).max(200),
    entries: z.array(ImportEntry).max(10_000),
  })
  .strict();
export type CatalogImportDocument = z.infer<typeof ImportDocument>;

/** Atomic, size-bounded catalog importer. Imported data never modifies connections. */
export class ProviderCatalog {
  constructor(private readonly db: SqlDriver) {}

  list(): ProviderCatalogEntry[] {
    const imported = this.db
      .all<{ data: string }>('SELECT data FROM ai_catalog_entries ORDER BY id')
      .map((row) => ImportEntry.parse(JSON.parse(row.data)));
    const ids = new Set(imported.map((entry) => entry.id));
    return [...imported, ...SPECIFIC_CONNECTION_PROFILES.filter((entry) => !ids.has(entry.id))];
  }

  import(bytes: Uint8Array, expectedSourceId: string): CatalogSnapshot {
    if (bytes.byteLength > 5_000_000)
      throw new DevBrainError('VALIDATION_FAILED', 'Catalog exceeds size limit');
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new DevBrainError('VALIDATION_FAILED', 'Catalog is not valid JSON');
    }
    const document = parseOrThrow(ImportDocument, decoded, 'catalog');
    if (document.sourceId !== expectedSourceId)
      throw new DevBrainError('VALIDATION_FAILED', 'Catalog source mismatch');
    const ids = new Set(document.entries.map((entry) => entry.id));
    if (ids.size !== document.entries.length)
      throw new DevBrainError('VALIDATION_FAILED', 'Duplicate provider IDs');
    if (
      document.entries.some(
        (entry) => entry.sourceId !== expectedSourceId || entry.dataLicense !== document.license,
      )
    )
      throw new DevBrainError('VALIDATION_FAILED', 'Catalog provenance mismatch');
    const snapshot = CatalogSnapshotSchema.parse({
      id: `cat_${randomUUID()}`,
      sourceId: expectedSourceId,
      revision: document.revision,
      fetchedAt: new Date().toISOString(),
      providerCount: document.entries.length,
      modelCount: new Set(document.entries.flatMap((entry) => entry.knownModelIds)).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO ai_catalog_snapshots (id,source_id,data,applied_at) VALUES (:id,:source,:data,:at)',
        {
          id: snapshot.id,
          source: expectedSourceId,
          data: JSON.stringify({ snapshot, document }),
          at: snapshot.fetchedAt,
        },
      );
      this.db.exec('DELETE FROM ai_catalog_entries');
      for (const entry of document.entries)
        this.db.run(
          'INSERT INTO ai_catalog_entries (id,snapshot_id,data) VALUES (:id,:snapshot,:data)',
          { id: entry.id, snapshot: snapshot.id, data: JSON.stringify(entry) },
        );
    });
    return snapshot;
  }

  rollback(snapshotId: string): CatalogSnapshot {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM ai_catalog_snapshots WHERE id=:id',
      { id: snapshotId },
    );
    if (!row) throw new DevBrainError('NOT_FOUND', 'Catalog snapshot missing');
    const stored = JSON.parse(row.data) as { snapshot: unknown; document: unknown };
    const snapshot = CatalogSnapshotSchema.parse(stored.snapshot);
    const document = ImportDocument.parse(stored.document);
    this.db.transaction(() => {
      this.db.exec('DELETE FROM ai_catalog_entries');
      for (const entry of document.entries)
        this.db.run(
          'INSERT INTO ai_catalog_entries (id,snapshot_id,data) VALUES (:id,:snapshot,:data)',
          { id: entry.id, snapshot: snapshotId, data: JSON.stringify(entry) },
        );
    });
    return snapshot;
  }
}
