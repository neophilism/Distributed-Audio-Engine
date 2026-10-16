import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

export const REHEARSAL_STEPS = Object.freeze([
  { id: 'runner', command: 'node', args: ['--test', '--test-reporter=tap', 'scripts/rehearsal/runner.test.mjs'], tap: true, requires: [] },
  { id: 'portable', command: 'npm', args: ['run', 'check'], tap: true, requires: [] },
  { id: 'signal-types', command: 'npm', args: ['run', 'typecheck', '--prefix', 'integrations/signal-parent'], requires: ['portable'] },
  { id: 'relay-types', command: 'npm', args: ['run', 'typecheck', '--prefix', 'services/ciphertext-relay'], requires: ['portable'] },
  { id: 'signal', command: 'npm', args: ['test', '--prefix', 'integrations/signal-parent'], tap: true, requires: ['portable'] },
  { id: 'relay', command: 'npm', args: ['test', '--prefix', 'services/ciphertext-relay'], tap: true, requires: ['portable'] },
  { id: 'native', command: 'sh', args: ['native/integration/test.sh'], tap: true, requires: ['portable'] },
  { id: 'signal-native', command: 'sh', args: ['integrations/signal-parent/test-native.sh'], tap: true, requires: ['portable', 'signal'] },
  { id: 'network-native', command: 'sh', args: ['services/ciphertext-relay/test-network.sh'], tap: true, requires: ['portable', 'signal', 'relay'] },
  { id: 'plan', command: 'node', args: ['scripts/validate-pr-registry.mjs'], requires: [] },
  { id: 'plan-tests', command: 'node', args: ['--test', '--test-reporter=tap', 'registry/pr-contract.test.mjs'], tap: true, requires: [] },
  { id: 'status-record', command: 'python3', args: ['scripts/validate_e2eesa_status.py'], requires: [] },
].map(step => Object.freeze({ ...step, args: Object.freeze(step.args), requires: Object.freeze(step.requires) })));
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const check = (ok, code) => { if (!ok) throw new Error(code); };

/** Child processes get only tooling variables, not API keys, deployment tokens,
 * NODE_OPTIONS, npm hooks/proxies or arbitrary preload configuration. */
export function rehearsalEnvironment(source = process.env, home = tmpdir()) {
  const env = { HOME: home, TMPDIR: tmpdir(), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    CI: 'true', NO_COLOR: '1', npm_config_update_notifier: 'false', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
    npm_config_userconfig: join(home, 'isolated-user.npmrc'), npm_config_globalconfig: join(home, 'isolated-global.npmrc') };
  for (const key of ['PATH', 'CC', 'NODE_INCLUDE_DIR']) if (typeof source[key] === 'string') env[key] = source[key];
  return env;
}

export function parseTapSummary(text) {
  const fields = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const values = {};
  for (const field of fields) {
    const matches = [...text.matchAll(new RegExp(`^# ${field} ([0-9]+)\\r?$`, 'gm'))];
    check(matches.length === 1, 'REHEARSAL_INVALID_TAP_SUMMARY');
    const n = Number(matches[0][1]); check(Number.isSafeInteger(n), 'REHEARSAL_INVALID_TAP_COUNT'); values[field] = n;
  }
  check(values.tests > 0 && values.tests === values.pass + values.fail + values.cancelled + values.skipped + values.todo,
    'REHEARSAL_INCONSISTENT_TAP_COUNTS');
  return values;
}

export function sourceIdentity(root) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    check(result.status === 0, 'REHEARSAL_GIT_CHECKOUT_REQUIRED'); return result.stdout;
  };
  const commit = git(['rev-parse', 'HEAD']).trim(); check(/^[0-9a-f]{40}$/.test(commit), 'REHEARSAL_INVALID_SOURCE_COMMIT');
  const names = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  check(names.length > 0 && names.length <= 10000, 'REHEARSAL_SOURCE_FILE_LIMIT');
  const hash = createHash('sha256'); hash.update('DAE-SOURCE-SNAPSHOT-v1\0');
  for (const name of names) {
    check(!isAbsolute(name) && !name.split('/').includes('..'), 'REHEARSAL_SOURCE_PATH');
    const path = join(root, name), info = lstatSync(path);
    check(info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024, 'REHEARSAL_SOURCE_FILE');
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`); hash.update(bytes);
  }
  return { commit, digest: 'sha256:' + hash.digest('hex'), files: names.length,
    clean: git(['status', '--porcelain', '--untracked-files=normal']).trim().length === 0 };
}

export function preflight(root, version = process.versions.node) {
  check(process.platform === 'linux', 'REHEARSAL_LINUX_REQUIRED');
  check(version === '24.19.0', 'REHEARSAL_NODE_24_19_0_REQUIRED');
  check(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === '@neophilism/distributed-audio-engine', 'REHEARSAL_WRONG_REPOSITORY');
  const require = createRequire(join(root, 'package.json'));
  try { check(require('typescript/package.json').version === '7.0.2', 'REHEARSAL_INSTALL_ROOT_DEPENDENCIES'); }
  catch { throw new Error('REHEARSAL_INSTALL_ROOT_DEPENDENCIES'); }
  const parentRequire = createRequire(join(root, 'integrations/signal-parent/package.json'));
  try { parentRequire.resolve('@signalapp/libsignal-client'); }
  catch { throw new Error('REHEARSAL_INSTALL_SIGNAL_DEPENDENCIES'); }
  for (const executable of ['npm', 'sh', process.env.CC ?? 'cc', 'openssl', 'python3', 'git']) {
    const args = executable === 'sh' ? ['-c', 'exit 0'] : ['--version'];
    if (executable === 'openssl') args[0] = 'version';
    const result = spawnSync(executable, args, { stdio: 'ignore', timeout: 10000 });
    check(result.status === 0, 'REHEARSAL_MISSING_TOOL_' + executable.replace(/[^A-Za-z0-9]/g, '_').toUpperCase());
  }
  const include = process.env.NODE_INCLUDE_DIR ?? join(dirname(dirname(process.execPath)), 'include/node');
  try { check(lstatSync(join(include, 'node_api.h')).isFile(), 'REHEARSAL_NODE_HEADERS_REQUIRED'); }
  catch { throw new Error('REHEARSAL_NODE_HEADERS_REQUIRED'); }
}

/** Fixed executable/argument vectors; no shell interpolation or remote execution.
 * Timeout/cancellation kills only the detached process group created for this step. */
export async function executeStep(step, { root, directory, signal, timeoutMs = 600000, env }) {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000, 'REHEARSAL_TIMEOUT_BOUND');
  check(/^[a-z][a-z0-9-]{0,63}$/.test(step.id), 'REHEARSAL_STEP_ID');
  const files = { stdout: `${step.id}.stdout.log`, stderr: `${step.id}.stderr.log` };
  const fds = {}, sizes = { stdout: 0, stderr: 0 }; let child, reason = null, timer, killTimer;
  const started = performance.now();
  try {
    for (const stream of ['stdout', 'stderr']) fds[stream] = openSync(join(directory, files[stream]), 'wx', 0o600);
    const completion = await new Promise(resolveResult => {
      if (signal?.aborted) { reason = 'cancelled'; resolveResult({ code: null, signal: null }); return; }
      child = spawn(step.command === 'node' ? process.execPath : step.command, step.args,
        { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => { if (Number.isInteger(child.pid) && child.pid > 0) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      } };
      const stop = why => {
        if (reason) return; reason = why;
        if (Number.isInteger(child.pid) && child.pid > 0) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Failed spawn or already exited. */ }
        }
        killTimer = setTimeout(kill, 1000); killTimer.unref();
      };
      const cancel = () => stop('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
        if (sizes[stream] + bytes.length > MAX_LOG_BYTES) { stop('log-limit'); return; }
        try { writeSync(fds[stream], bytes); sizes[stream] += bytes.length; } catch { stop('log-write-failed'); }
      });
      child.once('error', () => { reason = 'spawn-failed'; });
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel);
        // Remove any orphaned processes left in this step's own process group.
        kill(); resolveResult({ code, signal: exitSignal });
      });
      timer = setTimeout(() => stop('timeout'), timeoutMs); timer.unref();
    });
    const logs = Object.fromEntries(Object.entries(files).map(([stream, name]) => [stream,
      { file: name, sha256: sha256(readFileSync(join(directory, name))), bytes: sizes[stream] }]));
    let counts = null;
    if (!reason && completion.code === 0 && step.tap) {
      try { counts = parseTapSummary(readFileSync(join(directory, files.stdout), 'utf8')); }
      catch { reason = 'invalid-test-summary'; }
      if (counts && (counts.fail || counts.cancelled || counts.skipped || counts.todo)) reason = 'tests-not-all-passed';
    }
    return { id: step.id, status: !reason && completion.code === 0 ? 'passed' : 'failed',
      reason: reason ?? (completion.code === 0 ? null : 'nonzero-exit'), exitCode: completion.code,
      signal: completion.signal, durationMs: Math.round(performance.now() - started), counts, logs };
  } finally { for (const fd of Object.values(fds)) closeSync(fd); }
}

export async function runRehearsal({ root, output, signal, execute = executeStep, identify = sourceIdentity, validate = preflight, onStep = () => {} }) {
  root = resolve(root); output = resolve(output);
  // Keep evidence out of the measured checkout and never overwrite prior evidence.
  const inside = relative(root, output);
  check(inside.startsWith('..' + sep) || isAbsolute(inside), 'REHEARSAL_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  mkdirSync(output, { mode: 0o700 });
  const home = join(output, 'tool-home'); mkdirSync(home, { mode: 0o700 });
  for (const name of ['isolated-user.npmrc', 'isolated-global.npmrc'])
    writeFileSync(join(home, name), '', { flag: 'wx', mode: 0o600 });
  const report = { version: 1, scope: 'isolated-software-integration-rehearsal', startedAt: new Date().toISOString(),
    finishedAt: null, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    source: null, sourceUnchanged: false, steps: [], passed: false, failure: null,
    claims: { deployed: false, physicalOutputQualified: false, mobileRuntimeQualified: false,
      independentlyReviewed: false, productionReady: false } };
  try {
    validate(root); report.source = identify(root);
    for (const step of REHEARSAL_STEPS) {
      if (signal?.aborted || step.requires.some(id => report.steps.find(row => row.id === id)?.status !== 'passed')) {
        report.steps.push({ id: step.id, status: 'skipped', reason: signal?.aborted ? 'cancelled' : 'failed-prerequisite' }); continue;
      }
      onStep(step.id, 'running');
      const result = await execute(step, { root, directory: output, signal, env: rehearsalEnvironment(process.env, home) });
      report.steps.push(result); onStep(step.id, result.status);
    }
    const after = identify(root);
    report.sourceUnchanged = after.commit === report.source.commit && after.digest === report.source.digest;
    report.passed = report.sourceUnchanged && report.steps.length === REHEARSAL_STEPS.length && report.steps.every(row => row.status === 'passed');
    if (!report.sourceUnchanged) report.failure = 'source-changed-during-rehearsal';
    else if (!report.passed) report.failure = signal?.aborted ? 'cancelled' : 'one-or-more-checks-incomplete';
  } catch (error) {
    // Fixed error codes only; filesystem, tool and dependency messages can expose paths/configuration.
    report.failure = /^REHEARSAL_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'rehearsal-failed';
  } finally {
    report.finishedAt = new Date().toISOString();
    const bytes = JSON.stringify(report, null, 2) + '\n';
    writeFileSync(join(output, 'report.json'), bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(output, 'SHA256SUMS'), `${sha256(bytes)}  report.json\n` + report.steps.flatMap(step =>
      Object.values(step.logs ?? {}).map(log => `${log.sha256}  ${log.file}\n`)).join(''), { flag: 'wx', mode: 0o600 });
  }
  return report;
}
