import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { runRelay } from '../src/main.mjs';
import { tlsMaterial, raw } from './helpers.mjs';

test('explicit private configuration starts the real TLS service and supports clean shutdown/reopen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dae-launcher-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { key, cert } = tlsMaterial();
  writeFileSync(join(directory, 'key.pem'), key, { mode: 0o600 }); writeFileSync(join(directory, 'cert.pem'), cert, { mode: 0o600 });
  const allocator = createServer(); await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port; await new Promise(resolve => allocator.close(resolve));
  const config = { host: '127.0.0.1', port, databasePath: join(directory, 'relay.sqlite'),
    tlsKeyFile: join(directory, 'key.pem'), tlsCertificateFile: join(directory, 'cert.pem'), grants: [] };
  const path = join(directory, 'config.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const running = await runRelay(path);
  try { assert.equal((await raw('https://127.0.0.1:' + port, { path: '/healthz' })).status, 200); }
  finally { await running.close(); }
  const reopened = await runRelay(path); await reopened.close(); await reopened.close();
  chmodSync(path, 0o644); await assert.rejects(runRelay(path), /PRIVATE_FILE/);
});
