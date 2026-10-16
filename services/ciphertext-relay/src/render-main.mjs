import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteCiphertextMailbox, RelayAccessPolicy, createRenderEdgeCiphertextRelay } from './index.mjs';
import { decode, invariant, integer } from './records.mjs';

/** Deploy only to the explicitly authorized Render test service. No endpoint
 * secret, media key or private manifest is provisioned on this process.
 */
export async function runRenderRelay(env = process.env) {
  invariant(env.RENDER === 'true' && env.RENDER_SERVICE_TYPE === 'web' &&
    env.DAE_RELAY_MODE === 'render-staging' && env.RENDER_GIT_REPO_SLUG === 'neophilism/Distributed-Audio-Engine',
    'RELAY_RENDER_STAGING_CONFIGURATION_REQUIRED');
  invariant(typeof env.PORT === 'string' && /^[1-9][0-9]{3,4}$/.test(env.PORT), 'RELAY_RENDER_PORT_REQUIRED');
  const port = Number(env.PORT); integer(port, 1024, 65535);
  invariant(![18012, 18013, 19099].includes(port), 'RELAY_RENDER_RESERVED_PORT');
  const encoded = env.DAE_RELAY_GRANTS_JSON ?? '[]';
  invariant(typeof encoded === 'string' && Buffer.byteLength(encoded) <= 32768, 'RELAY_RENDER_GRANT_LIMIT');
  const access = new RelayAccessPolicy(decode(Buffer.from(encoded)));
  let directory, store, server, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (server?.listening) {
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await stopped;
    }
    store?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  };
  try {
    directory = mkdtempSync(join(tmpdir(), 'dae-render-relay-')); chmodSync(directory, 0o700);
    store = new SqliteCiphertextMailbox(join(directory, 'ciphertext.sqlite'), {
      maxPackets: 128, maxMailboxPackets: 64, maxBytes: 2 * 1024 * 1024,
      maxChunks: 64, maxChunkBytes: 8 * 1024 * 1024,
    });
    server = createRenderEdgeCiphertextRelay({ store, access, publicOrigin: env.RENDER_EXTERNAL_URL,
      sourceCommit: env.RENDER_GIT_COMMIT });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => { server.removeListener('error', reject); resolve(); });
    });
    return { server, close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  runRenderRelay().then(({ server, close }) => {
    console.log(JSON.stringify({ status: 'listening', service: 'ciphertext-relay', environment: 'staging',
      sourceCommit: process.env.RENDER_GIT_COMMIT, storage: 'ephemeral-sqlite', productionReady: false }));
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      close().catch(() => { process.exitCode = 1; });
    };
    server.on('error', () => { process.exitCode = 1; stop(); });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }).catch(() => { console.error('Ciphertext relay startup rejected'); process.exitCode = 1; });
}
