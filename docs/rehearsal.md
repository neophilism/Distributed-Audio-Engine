# Run the integrated software rehearsal

This is the shortest verified software path through the current engine. It runs
real endpoint cryptography, actual TLS sockets, durable endpoint/controller
recovery and the same C PCM renderer linked by the mobile hosts. It needs no API
key, paid provider, cloud database, account enrollment or external security audit.
It does not play through physical speakers or create an application deployment.

## First run on a Linux development machine

Install Node **24.19.0**, a C11 compiler, Node C headers, OpenSSL, Python 3 and Git.
Clone this repository and run from its root:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix integrations/signal-parent
npm run rehearsal
```

The two installs use the existing exact lockfiles. The rehearsal itself is offline
except for local loopback TLS traffic and does not install packages, provision
cloud infrastructure or call a paid API. A missing dependency is a failure, not a
skipped test interpreted as success. `npm run rehearsal -- --help` lists the fixed
suite. This command currently requires Linux because its in-process native test
adapter is built as a Linux shared library. Actual Android and unsigned iOS builds
remain in the separate native workflow; no Mac/iPhone compatibility claim follows
from Linux success. The existing `npm run check` remains the portable entry point.

## What runs

The runner executes its own contract tests, the full portable checks (types,
boundaries, tests, dependency-plan validation and packed consumer installation),
Signal and relay consumer types, the actual Signal endpoint suite, the SQLite/TLS
relay suite, signed/encrypted JavaScript-to-C tests, actual Signal-to-C tests,
actual Signal-to-TLS-to-C tests, and the PR/status record validators. This includes
controller uncertainty/restart, lease replay, rights revocation, corrupted audio,
private-manifest recovery, emergency stopping and the explicit managed TLS edge.
The normal hosted platform and dependency-audit workflows are not removed.

A failed prerequisite prevents dependent execution, but independent record checks
still run. Every required step must pass. Exit zero with absent, contradictory,
skipped, cancelled or unfinished TAP test results cannot produce a passing report.
Each step has a ten-minute deadline and bounded output. Cancellation terminates
only that step's own process group; it does not kill unrelated host processes.
No credentials or deployment state are inherited by child tests: the environment
contains tooling variables, not API keys, proxy/preload settings or npm hooks.

## Evidence you can inspect

The command prints a new private evidence directory under the temporary directory.
To choose a location, name a **new absolute directory outside the repository**:

```sh
npm run rehearsal -- --output /tmp/my-dae-rehearsal
```

It creates `report.json`, per-step stdout/stderr logs and `SHA256SUMS`. It refuses
to overwrite an existing result. Evidence directories are mode 0700 and files are
mode 0600. The report records actual process exit states, exact test counts where
available, runtime, timestamps, Git commit, a SHA-256 digest of the actual source
snapshot and whether the working tree was clean. Source is hashed before and
after the run; changes prevent a pass. A dirty worktree can be tested, but its
separate content digest is not falsely represented as the committed source.
These checksums detect changed files; they are not independent signatures.

Failed preflight also writes a failing report. An installation/runtime problem
must be fixed and the command rerun into a new directory. `passed: true` means
this isolated software suite passed; `productionReady`, `deployed`,
`physicalOutputQualified`, `mobileRuntimeQualified` and `independentlyReviewed`
remain false. Human review is still a final separate review, not a development
prerequisite. A fixture-owned account root is not real user identity provisioning.

## Running the relay, separately

`npm run relay:start` starts the existing standalone TLS relay with explicit
operator configuration (see `services/ciphertext-relay/README.md`).
`npm run relay:staging` is the **Render-only** launcher documented in
`docs/render-relay-staging.md`; it intentionally rejects an arbitrary local or
production environment. Neither command supplies credentials, invents endpoint
membership or installs media keys on a server. The empty-grant staging service
admits no endpoint until actual authorized routing grants are configured.

The GitHub `Integrated software rehearsal` workflow runs the same command and
retains its report and logs. This is additional reproducible evidence, not a
replacement for the existing native, cryptographic, relay and dependency checks.
