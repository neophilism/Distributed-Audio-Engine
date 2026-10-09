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
  for (const path of ['dist/src/index.js', 'dist/src/index.d.ts', 'dist/src/browser/index.js', 'dist/src/browser/index.d.ts', 'dist/src/node/index.js', 'dist/src/node/index.d.ts', 'src/index.ts', 'docs/security-baseline.json']) if (!paths.has(path)) throw new Error(`Missing package file: ${path}`);
  const consumer = join(dir, 'consumer'); await mkdir(consumer); await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(dir, packed.filename)], { cwd: consumer, maxBuffer: 1024 * 1024 });
  await writeFile(join(consumer, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import { compileProgram, ProgramTimeline, encryptAttachment, EndpointAttachmentReader, readAttachmentRange, canonicalJson } from '@neophilism/distributed-audio-engine';
    import { BrowserAudioSink } from '@neophilism/distributed-audio-engine/browser';
    import { SqliteCheckpointStore } from '@neophilism/distributed-audio-engine/node';
    const context = { tenantId: 'tenant', application: 'distributed-radio', parentMessageId: 'parent' };
    const encrypted = await encryptAttachment(new Uint8Array([1, 2, 3]), { ...context, filename: 'fixture.wav', mediaType: 'audio/wav' });
    const reader = await EndpointAttachmentReader.open(encrypted.privateManifest, context);
    const result = await readAttachmentRange(reader, { async read(request) { return encrypted.ciphertextChunks[request.chunkIndex]; } }, 0, 3);
    assert.deepEqual(result.plaintext, new Uint8Array([1, 2, 3])); reader.close();
    const timeline = new ProgramTimeline(0, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }]));
    assert.equal(timeline.targetAt(250).offsetFrames, 2000); assert.equal(typeof BrowserAudioSink, 'function');
    const checkpoints = new SqliteCheckpointStore(':memory:');
    assert.equal(checkpoints.compareAndSet(canonicalJson({ tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' }), undefined, { epoch: 1, sequence: 1 }), true); checkpoints.close();
  `);
  await run(process.execPath, ['smoke.mjs'], { cwd: consumer, maxBuffer: 1024 * 1024 });
  console.log(`Packed consumer smoke passed (${packed.entryCount} files, ${packed.size} bytes; local installation only)`);
} finally { await rm(dir, { recursive: true, force: true }); }
