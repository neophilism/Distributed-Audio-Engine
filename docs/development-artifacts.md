# Verified development artifacts

The Engine CI `verify` job assembles an artifact only after the repository checks
and dependency audit succeed. Download the `engine-development-<commit>` artifact
from the matching GitHub Actions run. It contains:

- `source.tar.gz`: tracked repository source from the checked commit, under `source/`.
- The npm `.tgz`: the built development package, installable with `npm install /path/to/package.tgz`.
- `SOURCE_COMMIT`, `NODE_VERSION`, and `SHA256SUMS`: source/runtime binding and byte-integrity checks.

Run `sha256sum -c SHA256SUMS` after extracting the Actions ZIP. Confirm the run's
commit and conclusion in GitHub; hashes alone do not authenticate a publisher.
Pull-request runs use GitHub's tested merge commit, not necessarily the PR head.
Use the main-branch run for the merged development artifact.

The source archive intentionally excludes untracked files, credentials, working
directories and dependency installations. Artifacts expire after seven days and
can be recreated from source with the pinned runtime, `npm ci --ignore-scripts`,
`npm run check`, and `npm pack --ignore-scripts`.

This is not npm publication, native-device qualification, a hosted deployment,
or an independently approved stable release. All existing production gates apply.
