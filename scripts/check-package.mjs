import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'dae-package-check-'));
try {
  const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { maxBuffer: 4 * 1024 * 1024 });
  const [packed] = JSON.parse(stdout);
  const paths = new Set(packed.files.map(file => file.path));
  for (const path of paths) if (/(^|\/)(?:node_modules|tests|\.env(?:\..*)?|\.git)(\/|$)|\.(?:sqlite|tgz)$/.test(path)) throw new Error(`Unexpected package file: ${path}`);
  for (const path of ['dist/src/index.js', 'dist/src/index.d.ts', 'dist/src/browser/index.js', 'dist/src/browser/index.d.ts', 'dist/src/android/index.js', 'dist/src/android/index.d.ts', 'dist/src/ios/index.js', 'dist/src/ios/index.d.ts', 'dist/src/node/index.js', 'dist/src/node/index.d.ts', 'src/index.ts', 'docs/security-baseline.json']) if (!paths.has(path)) throw new Error(`Missing package file: ${path}`);
  const consumer = join(dir, 'consumer'); await mkdir(consumer); await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(dir, packed.filename)], { cwd: consumer, maxBuffer: 1024 * 1024 });
  await writeFile(join(consumer, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { compileProgram, ProgramTimeline, encryptAttachment, EndpointAttachmentReader, readAttachmentRange, canonicalJson, CheckoutEngine, ReconciliationEngine, EntitlementLedger, OperationsEvidenceAcceptor, assessOperationsAssurance } from '@neophilism/distributed-audio-engine';
    import { BrowserAudioSink } from '@neophilism/distributed-audio-engine/browser';
    import { AndroidAudioSink } from '@neophilism/distributed-audio-engine/android';
    import { IOSAudioSink } from '@neophilism/distributed-audio-engine/ios';
    import { SqliteCheckpointStore, SqliteCommerceStore, SqliteAccountingStore, SqliteEntitlementStore } from '@neophilism/distributed-audio-engine/node';
    import { OutputEvidenceEndpoint } from '@neophilism/distributed-audio-engine/evidence';
    import { OutputLifecycle } from '@neophilism/distributed-audio-engine/output-lifecycle';
    const context = { tenantId: 'tenant', application: 'distributed-radio', parentMessageId: 'parent' };
    const encrypted = await encryptAttachment(new Uint8Array([1, 2, 3]), { ...context, filename: 'fixture.wav', mediaType: 'audio/wav' });
    const reader = await EndpointAttachmentReader.open(encrypted.privateManifest, context);
    const result = await readAttachmentRange(reader, { async read(request) { return encrypted.ciphertextChunks[request.chunkIndex]; } }, 0, 3);
    assert.deepEqual(result.plaintext, new Uint8Array([1, 2, 3])); reader.close();
    const timeline = new ProgramTimeline(0, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }]));
    assert.equal(timeline.targetAt(250).offsetFrames, 2000); assert.equal(typeof BrowserAudioSink, 'function');
    const checkpoints = new SqliteCheckpointStore(':memory:');
    assert.equal(checkpoints.compareAndSet(canonicalJson({ tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' }), undefined, { epoch: 1, sequence: 1 }), true); checkpoints.close();
    for (const value of [CheckoutEngine, ReconciliationEngine, OperationsEvidenceAcceptor, assessOperationsAssurance, OutputEvidenceEndpoint, OutputLifecycle, AndroidAudioSink, IOSAudioSink]) assert.equal(typeof value, 'function');
    const scope = { tenantId: 'tenant', application: 'distributed-radio', identityId: 'issuer' };
    const actor = { ...scope, deviceId: 'device', expiresAtMs: 1000, permissions: ['entitlements:manage'] };
    const grants = new SqliteEntitlementStore(':memory:'), ledger = new EntitlementLedger(scope, grants);
    ledger.grant(actor, { grantId: 'grant', subjectId: 'buyer', resources: [{resourceId: 'asset', uses: ['download']}], source: {kind: 'purchase', recordId: 'order'}, expiresAtMs: 900, authorizationEvidenceRef: 'sha256:' + 'a'.repeat(64) }, 100);
    assert.equal(ledger.access({ ...actor, identityId: 'buyer', permissions: ['assets:read'] }, 'asset', 'download', 200).allowed, true); grants.close();
    for (const Store of [SqliteCommerceStore, SqliteAccountingStore]) { const store = new Store(':memory:'); store.close(); }
  `);
  await run(process.execPath, ['smoke.mjs'], { cwd: consumer, maxBuffer: 1024 * 1024 });
  console.log(`Packed consumer smoke passed (${packed.entryCount} files, ${packed.size} bytes; local installation only)`);
} finally { await rm(dir, { recursive: true, force: true }); }
