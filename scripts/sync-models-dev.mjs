/** Manual snapshot of discovery candidates. Never creates connections or credentials. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = 'https://models.dev/api.json';
const response = await fetch(source, { redirect: 'error' });
if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length > 10_000_000) throw new Error('Source catalog exceeded size limit');
const upstream = JSON.parse(bytes.toString('utf8'));
const commitResponse = await fetch(
  'https://api.github.com/repos/anomalyco/models.dev/commits/dev',
  { headers: { accept: 'application/vnd.github+json' } },
);
if (!commitResponse.ok) throw new Error('Cannot resolve upstream revision');
const commit = (await commitResponse.json()).sha;
const validUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};
const entries = Object.entries(upstream)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, value]) => {
    const documentationUrl = validUrl(value.doc);
    return {
      id,
      name: value.name || id,
      documentationUrl,
      kind: 'api',
      signupUrl: null,
      termsUrl: null,
      sourceId: 'models-dev',
      verifiedAt: null,
      siteUrl: null,
      endpointUrl: validUrl(value.api),
      authType: Array.isArray(value.env) && value.env.length ? 'api-key' : 'unknown',
      offer: 'unknown',
      requiresCard: null,
      regionalRestrictions: null,
      commercialUse: 'unknown',
      retentionPolicyUrl: null,
      trainingPolicyUrl: null,
      knownModelIds: Object.keys(value.models ?? {}).slice(0, 1000),
      publishedQuotaIds: [],
      quotaScope: null,
      consumptionUnit: null,
      verificationState: 'discovered',
      sourceUrls: [source, documentationUrl].filter(Boolean),
      dataLicense: 'MIT',
    };
  });
const document = {
  formatVersion: 1,
  sourceId: 'models-dev',
  revision: commit,
  license: 'MIT',
  entries,
};
const output = JSON.stringify(document, null, 2) + '\n';
if (Buffer.byteLength(output) > 5_000_000)
  throw new Error('Transformed catalog exceeded import limit');
const directory = join(root, 'catalog');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'models-dev-candidates.json'), output);
console.log(
  JSON.stringify({
    candidates: entries.length,
    revision: commit,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    outputBytes: Buffer.byteLength(output),
  }),
);
