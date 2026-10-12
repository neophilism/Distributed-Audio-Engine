import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteCiphertextMailbox, RelayAccessPolicy, createCiphertextRelay } from './index.mjs';
import { exact, decode, integer, invariant } from './records.mjs';

function privateRead(path, maximum) {
  invariant(typeof path === 'string' && path === resolve(path), 'RELAY_CONFIG_PATH');
  const parent = dirname(path), dir = lstatSync(parent);
  invariant(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid() &&
    (dir.mode & 0o777) === 0o700 && realpathSync(parent) === parent, 'RELAY_CONFIG_DIRECTORY');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    invariant(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= maximum, 'RELAY_CONFIG_PRIVATE_FILE');
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    for (;;) { const read = readSync(fd, bytes, offset, bytes.length - offset, null); if (!read) break; offset += read; }
    invariant(offset === stat.size, 'RELAY_CONFIG_FILE_CHANGED'); return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
/** Starts only when explicitly given an operator's private configuration file.
 * No certificate/key generation, cloud provisioning, background task or spending.
 */
export async function runRelay(configFile) {
  invariant(process.platform !== 'win32' && typeof process.getuid === 'function', 'RELAY_POSIX_REQUIRED');
  const config = decode(privateRead(configFile, 32768));
  exact(config, ['host','port','databasePath','tlsKeyFile','tlsCertificateFile','grants']);
  invariant(typeof config.host === 'string' && ['127.0.0.1', '0.0.0.0', '::1', '::'].includes(config.host), 'RELAY_BIND_ADDRESS');
  integer(config.port, 1024, 65535);
  const key = privateRead(config.tlsKeyFile, 65536), cert = privateRead(config.tlsCertificateFile, 65536);
  const access = new RelayAccessPolicy(config.grants), store = new SqliteCiphertextMailbox(config.databasePath);
  let server;
  try { server = createCiphertextRelay({ key, cert, access, store }); }
  catch (error) { store.close(); throw error; }
  finally { key.fill(0); }
  try { await new Promise((done, fail) => { server.once('error', fail); server.listen(config.port, config.host, done); }); }
  catch (error) { server.closeAllConnections(); server.close(); store.close(); throw error; }
  let closing;
  const close = () => {
    if (closing) return closing;
    closing = new Promise(done => {
      const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
      server.close(() => { clearTimeout(deadline); store.close(); done(); });
      server.closeIdleConnections();
    });
    return closing;
  };
  return { server, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    invariant(process.argv.length === 3, 'RELAY_CONFIGURATION_REQUIRED');
    const relay = await runRelay(process.argv[2]);
    process.once('SIGTERM', () => { void relay.close(); });
    process.once('SIGINT', () => { void relay.close(); });
    console.log('Ciphertext relay listening over TLS. No endpoint keys are configured here.');
  } catch { console.error('Relay startup rejected. Check the private configuration, TLS files and database.'); process.exitCode = 1; }
}
