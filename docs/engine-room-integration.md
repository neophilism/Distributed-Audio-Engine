# Engine Room project discovery

The Engine Room GitHub App discovers this repository using `.exechub/project.yml`. Its 34 planned work units correspond to DAE-01 through DAE-34 in `docs/roadmap.json`, **not** to GitHub PR numbers. The milestone buckets here are coarse counts for portfolio registration; `docs/roadmap.json` remains the detailed dependency and evidence source.

No ordinal-to-PR relationship is implied. The same roadmap ID may span several PRs, and documentation PRs may cover no implementation ID. Engine Room must leave plan-to-GitHub-PR mapping unverified until explicitly reviewed; it may show observed GitHub activity separately. A manifest does not make this package a hosted service or attest deployment, native field validation, release certification, or independent E2EESA conformance. For detailed per-component evidence and false-claim prevention use `docs/implementation-status.md` and `docs/security-flow-inventory.json`.

To see this project in Engine Room: grant the Engine Room GitHub App access to this repository, run an authenticated reconciliation in the Engine Room deployment, and verify the plan is imported. Near-real-time updates require working authenticated webhooks or a trusted scheduler; the manifest alone does not configure those.
