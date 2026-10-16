import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { REHEARSAL_STEPS, runRehearsal } from './rehearsal/runner.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: npm run rehearsal -- [--output /absolute/new/evidence-directory | --list | --help]';
if (args.length === 1 && ['--list', '--help'].includes(args[0])) {
  console.log(usage);
  console.log('Requires a Linux checkout, Node 24.19.0, installed lockfile dependencies, C compiler/Node headers, OpenSSL, Python 3 and Git.');
  console.log('Runs isolated software tests with temporary endpoint identities. No API keys, remote deployment or physical speakers.');
  for (const step of REHEARSAL_STEPS) console.log(`${step.id}: ${step.command} ${step.args.join(' ')}`);
} else if (args.length !== 0 && !(args.length === 2 && args[0] === '--output' && args[1].startsWith('/'))) {
  console.error(usage); process.exitCode = 2;
} else {
  const abort = new AbortController();
  const cancel = () => abort.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const output = args[1] ?? join(tmpdir(), 'dae-rehearsal-' + randomUUID());
  try {
    const report = await runRehearsal({ root: resolve(fileURLToPath(new URL('..', import.meta.url))), output,
      signal: abort.signal, onStep: (id, status) => console.log(`[${id}] ${status}`) });
    console.log(JSON.stringify({ passed: report.passed, failure: report.failure, evidenceDirectory: output,
      productionReady: false, physicalOutputQualified: false }));
    if (!report.passed) process.exitCode = abort.signal.aborted ? 130 : 1;
  } catch {
    console.error('Rehearsal could not create new evidence. Use a new directory outside the repository.'); process.exitCode = 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
