import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeStep, rehearsalEnvironment, parseTapSummary, runRehearsal, REHEARSAL_STEPS, preflight } from './runner.mjs';

const tap = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dae-runner-test-')); const root = join(base, 'repo'); mkdirSync(root);
  const output = join(base, 'evidence'); t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, output, signal: new AbortController().signal };
}
const identity = () => ({ commit: 'a'.repeat(40), digest: 'sha256:' + 'b'.repeat(64), files: 12, clean: true });
const mock = ({ id }) => Promise.resolve({ id, status: 'passed' });

test('rehearsal: fixture TAP summaries must be positive, unambiguous and arithmetically consistent', () => {
  assert.equal(parseTapSummary(tap).pass, 2);
  for (const text of ['', tap + tap, tap.replace('# tests 2', '# tests 0'), tap.replace('# pass 2', '# pass 1')])
    assert.throws(() => parseTapSummary(text));
});
test('rehearsal: tooling environment omits API credentials, unsafe preload flags and npm config', () => {
  const env = rehearsalEnvironment({ PATH: '/bin', HOME: '/private', API_KEY: 'canary', NODE_OPTIONS: '--require malicious',
    npm_config_registry: 'https://attacker.invalid', RENDER_API_KEY: 'secret', HTTPS_PROXY: 'bad' }, '/temporary');
  assert.equal(env.PATH, '/bin'); assert.equal(env.HOME, '/temporary');
  for (const key of ['API_KEY', 'NODE_OPTIONS', 'npm_config_registry', 'RENDER_API_KEY', 'HTTPS_PROXY']) assert.equal(key in env, false);
  assert.equal(env.npm_config_offline, 'true');
});
test('rehearsal: a successful actual child process retains checksummed private logs and parsed counts', async t => {
  const f = fixture(t); mkdirSync(f.output, { mode: 0o700 });
  const result = await executeStep({ id: 'child', command: 'node', args: ['-e', `process.stdout.write(${JSON.stringify(tap)})`], tap: true },
    { ...f, directory: f.output, env: rehearsalEnvironment(), timeoutMs: 3000 });
  assert.equal(result.status, 'passed'); assert.equal(result.counts.tests, 2);
  assert.equal(result.logs.stdout.bytes, Buffer.byteLength(tap)); assert.match(result.logs.stdout.sha256, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(f.output, result.logs.stdout.file)).mode & 0o777, 0o600);
});
test('rehearsal: exit zero cannot disguise missing tests, skipped cases or an explicit failure', async t => {
  const f = fixture(t); mkdirSync(f.output);
  for (const [i, text] of ['', tap.replace('# pass 2', '# pass 1').replace('# skipped 0', '# skipped 1'),
    tap.replace('# pass 2', '# pass 1').replace('# fail 0', '# fail 1')].entries()) {
    const result = await executeStep({ id: 'bad-' + i, command: 'node', args: ['-e', `console.log(${JSON.stringify(text)})`], tap: true },
      { ...f, directory: f.output, env: rehearsalEnvironment(), timeoutMs: 3000 });
    assert.equal(result.status, 'failed');
  }
});
test('rehearsal: timeout and cancelled executions return failures, not hanging test sessions', async t => {
  const f = fixture(t); mkdirSync(f.output);
  const result = await executeStep({ id: 'timeout', command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] },
    { ...f, directory: f.output, env: rehearsalEnvironment(), timeoutMs: 80 });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'timeout');
  const abort = new AbortController(); abort.abort();
  const cancelled = await executeStep({ id: 'cancelled', command: 'node', args: [] },
    { ...f, signal: abort.signal, directory: f.output, env: rehearsalEnvironment(), timeoutMs: 1000 });
  assert.equal(cancelled.reason, 'cancelled');
});
test('rehearsal: failed preflight writes an explicit failure report without starting checks', async t => {
  const f = fixture(t);
  const result = await runRehearsal({ ...f, validate: () => { throw Error('REHEARSAL_MISSING_TOOL_CC'); },
    execute: () => { throw Error('must not run'); } });
  assert.equal(result.passed, false); assert.equal(result.steps.length, 0);
  assert.equal(JSON.parse(readFileSync(join(f.output, 'report.json'), 'utf8')).failure, 'REHEARSAL_MISSING_TOOL_CC');
  assert.equal(statSync(f.output).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.output, 'report.json')).mode & 0o777, 0o600);
});
test('rehearsal: fixed suite is complete only when every required step and unchanged source succeed', async t => {
  const f = fixture(t);
  const result = await runRehearsal({ ...f, validate: () => {}, identify: identity, execute: mock });
  assert.equal(result.passed, true); assert.equal(result.steps.length, REHEARSAL_STEPS.length);
  assert.equal(result.claims.productionReady, false); assert.equal(result.claims.deployed, false);
  assert.equal(result.claims.physicalOutputQualified, false); assert.equal(result.claims.independentlyReviewed, false);
});
test('rehearsal: failed prerequisite skips dependent work but still runs independent plan checks', async t => {
  const f = fixture(t); const visited = [];
  const result = await runRehearsal({ ...f, validate: () => {}, identify: identity, execute: async step => {
    visited.push(step.id); return { id: step.id, status: step.id === 'portable' ? 'failed' : 'passed' };
  } });
  assert.equal(result.passed, false); assert.equal(visited.includes('network-native'), false); assert.equal(visited.includes('plan'), true);
  assert.equal(result.steps.find(s => s.id === 'signal').status, 'skipped');
});
test('rehearsal: modified source and all pre-cancelled work never pass', async t => {
  const f = fixture(t); let count = 0;
  const result = await runRehearsal({ ...f, validate: () => {}, identify: () => ({ ...identity(), digest: String(count++) }), execute: mock });
  assert.equal(result.passed, false); assert.equal(result.failure, 'source-changed-during-rehearsal');
  const f2 = fixture(t), abort = new AbortController(); abort.abort();
  const stopped = await runRehearsal({ ...f2, signal: abort.signal, validate: () => {}, identify: identity, execute: mock });
  assert.equal(stopped.passed, false); assert.equal(stopped.steps.every(s => s.status === 'skipped'), true);
});
test('rehearsal: previous evidence and repository source paths are never overwritten', async t => {
  const f = fixture(t); mkdirSync(f.output);
  await assert.rejects(runRehearsal({ ...f, validate: () => {}, identify: identity, execute: mock }));
  await assert.rejects(runRehearsal({ ...f, output: join(f.root, 'evidence'), validate: () => {}, identify: identity, execute: mock }), /OUTSIDE_REPOSITORY/);
});
test('rehearsal: missing executable is a failed step with retained evidence', async t => {
  const f = fixture(t); mkdirSync(f.output);
  const result = await executeStep({ id: 'missing', command: 'dae-nonexistent-tool-6718', args: [] },
    { ...f, directory: f.output, env: rehearsalEnvironment(), timeoutMs: 1000 });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'spawn-failed');
});
test('rehearsal: supported runtime is not fabricated by a successful generic node executable', () => {
  assert.throws(() => preflight('.', '22.16.0'), /NODE_24_19_0_REQUIRED/);
});

// This runs npm itself; a mocked child runner would not catch duplicate config loads.
test('rehearsal: isolated npm config actually runs scripts without inherited credentials', async t => {
  const f = fixture(t); mkdirSync(f.output);
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ private: true, scripts: { probe: 'node -e "process.exit(0)"' } }));
  const result = await executeStep({ id: 'npm-probe', command: 'npm', args: ['run', 'probe'] },
    { ...f, directory: f.output, env: rehearsalEnvironment(process.env, f.output), timeoutMs: 3000 });
  assert.equal(result.status, 'passed');
});
