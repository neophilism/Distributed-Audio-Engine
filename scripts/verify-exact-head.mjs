/**
 * Read-only GitHub Actions head verifier. Local decision support, not a merger,
 * GitHub branch protection replacement, or evidence of mobile field operation.
 *
 * node scripts/verify-exact-head.mjs owner/repository <40-char-commit-sha>
 * Public repositories work without a token at GitHub's anonymous rate limits.
 */
const REQUIRED = Object.freeze([
  'Engine CI',
  'Native audio CI',
  'Signal parent integration',
  'Ciphertext relay integration',
  'Integrated software rehearsal',
]);
export { REQUIRED };

export function assessHeadRuns(runs, sha, expected = REQUIRED) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw Error('INVALID_HEAD_SHA');
  if (!Array.isArray(runs) || !Array.isArray(expected) || !expected.length ||
      new Set(expected).size !== expected.length) throw Error('INVALID_RUN_LIST');
  const details = [];
  for (const name of expected) {
    const matching = runs.filter(run => run && run.name === name &&
      run.head_sha === sha && run.event === 'pull_request');
    matching.sort((a, b) => {
      const ai = Date.parse(a.created_at || '') || 0;
      const bi = Date.parse(b.created_at || '') || 0;
      return bi - ai || (b.run_attempt || 0) - (a.run_attempt || 0) ||
        (b.id || 0) - (a.id || 0);
    });
    const latest = matching[0];
    const state = !latest ? 'missing' :
      latest.status !== 'completed' ? 'pending' :
      latest.conclusion === 'success' ? 'passed' : 'failed';
    details.push({ name, state, runId: latest?.id ?? null,
      conclusion: latest?.conclusion ?? null, url: latest?.html_url ?? null });
  }
  return { sha, passed: details.every(row => row.state === 'passed'), workflows: details };
}

export async function fetchHeadRuns(repository, sha, token = '') {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split('/').some(part => part === '.' || part === '..' || part.includes('..')) ||
      !/^[0-9a-f]{40}$/.test(sha)) throw Error('INVALID_REPOSITORY_OR_HEAD');
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const endpoint = 'https://api.github.com/repos/' + repository +
      '/actions/runs?event=pull_request&head_sha=' + sha +
      '&per_page=100&page=' + page;
    const headers = { Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dae-head-verifier' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(endpoint, { headers, redirect: 'error' });
    if (!response.ok) throw Error('GITHUB_WORKFLOW_FETCH_FAILED_' + response.status);
    const parsed = await response.json();
    if (!Array.isArray(parsed.workflow_runs)) throw Error('GITHUB_RUN_RESPONSE_INVALID');
    all.push(...parsed.workflow_runs);
    if (parsed.workflow_runs.length < 100) return all;
  }
  // Never report a pass from a potentially incomplete run collection.
  throw Error('GITHUB_RUNS_PAGINATION_LIMIT');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const [, , repository, sha] = process.argv;
  try {
    const result = assessHeadRuns(
      await fetchHeadRuns(repository, sha, process.env.GITHUB_TOKEN || ''), sha);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(String(error?.message || error) + '\n');
    process.exitCode = 1;
  }
}
