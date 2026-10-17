import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessHeadRuns, fetchHeadRuns, REQUIRED } from './verify-exact-head.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
function run(name, overrides = {}) {
  return { id: 1, name, head_sha: SHA, event: 'pull_request',
    status: 'completed', conclusion: 'success', created_at: '2026-10-17T14:00:00Z',
    run_attempt: 1, html_url: 'https://github.com/example/repo/actions/runs/1',
    ...overrides };
}
const successful = () => REQUIRED.map(name => run(name));

test('release gate requires all five successful exact-head pull-request workflows', () => {
  const result = assessHeadRuns(successful(), SHA);
  assert.equal(result.passed, true);
  assert.equal(result.workflows.length, 5);
  assert.deepEqual(new Set(result.workflows.map(item => item.name)), new Set(REQUIRED));
  assert.ok(result.workflows.every(item => item.state === 'passed'));
});

test('wrong head, push-only, missing and still queued checks are never treated as green', () => {
  const runs = successful();
  runs[0] = run(REQUIRED[0], { head_sha: OTHER });
  runs[1] = run(REQUIRED[1], { event: 'push' });
  runs[2] = run(REQUIRED[2], { status: 'queued', conclusion: null });
  runs.pop();
  const result = assessHeadRuns(runs, SHA);
  assert.equal(result.passed, false);
  assert.deepEqual(result.workflows.map(item => item.state),
    ['missing', 'missing', 'pending', 'passed', 'missing']);
});

test('a newer pending or failed attempt is not superseded by an older success', () => {
  const runs = successful();
  runs.push(run(REQUIRED[0], { id: 30, status: 'in_progress', conclusion: null,
    created_at: '2026-10-17T15:00:00Z' }));
  runs.push(run(REQUIRED[1], { id: 31, status: 'completed', conclusion: 'failure',
    created_at: '2026-10-17T15:00:00Z' }));
  const result = assessHeadRuns(runs, SHA);
  assert.equal(result.passed, false);
  assert.deepEqual(result.workflows.slice(0, 2).map(item => item.state), ['pending', 'failed']);
});

test('malformed head and inconsistent checklist fail closed', () => {
  assert.throws(() => assessHeadRuns([], 'main'), /INVALID_HEAD_SHA/);
  assert.throws(() => assessHeadRuns([], SHA, ['Engine CI', 'Engine CI']), /INVALID_RUN_LIST/);
  assert.throws(() => assessHeadRuns(null, SHA), /INVALID_RUN_LIST/);
});

test('GitHub fetch is read only, pinned to the full SHA and rejects failures', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const captured = [];
  globalThis.fetch = async (url, options) => {
    captured.push({ url, options });
    return { ok: true, json: async () => ({ workflow_runs: successful() }) };
  };
  const runs = await fetchHeadRuns('neophilism/Distributed-Audio-Engine', SHA);
  assert.equal(runs.length, 5);
  assert.match(captured[0].url, new RegExp('head_sha=' + SHA));
  assert.equal(captured[0].options.redirect, 'error');
  assert.equal(captured[0].options.headers.Authorization, undefined);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchHeadRuns('neophilism/Distributed-Audio-Engine', SHA), /FETCH_FAILED_503/);
  await assert.rejects(fetchHeadRuns('../invalid', SHA), /INVALID_REPOSITORY/);
});
