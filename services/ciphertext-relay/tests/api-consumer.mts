import { CiphertextRelayClient, RelayAccessPolicy, createCiphertextRelay, SqliteCiphertextMailbox } from '../src/index.mjs';
import type { CiphertextChunkTransport } from '../../../dist/src/index.js';
const client = new CiphertextRelayClient({ origin: 'https://localhost', token: 'provided-by-operator' });
const transport: CiphertextChunkTransport = client.chunksFrom('sender', { tenantId: 'tenant', application: 'distributed-radio' });
void transport;
void createCiphertextRelay({ store: new SqliteCiphertextMailbox(':memory:'), access: new RelayAccessPolicy([]), key: 'key', cert: 'cert' });
// @ts-expect-error Insecure TLS override is intentionally not part of this API.
new CiphertextRelayClient({ origin: 'https://localhost', token: 'token', rejectUnauthorized: false });
// @ts-expect-error Private manifests must not be accepted as upload fields.
client.uploadChunk({ attachmentKeyHex: 'secret' });

import { createRenderEdgeCiphertextRelay } from '../src/index.mjs';
declare const testStore: SqliteCiphertextMailbox, testAccess: RelayAccessPolicy;
void createRenderEdgeCiphertextRelay({ store: testStore, access: testAccess,
  publicOrigin: 'https://relay-test.onrender.com', sourceCommit: 'c'.repeat(40) });
void testAccess.activeCount(Date.now());
