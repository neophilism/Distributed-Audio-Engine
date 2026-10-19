# DAE-32  Stable release and maintainer checklist

This work adds an advisory assessReleaseCandidate that keeps development artifacts and production release explicitly separate. It requires each named GitHub check to be observed as successful against the exact 40-character source SHA, the package's source SHA to match that head, and a separately recorded reproducible package and resolved security findings. Missing, stale, duplicated or different-head checks are not success.

A development-candidate result does not confer deployment authority, physical-device compatibility, E2EESA certification, independent expert review or production access. Production-ready evidence is a distinct status requiring actual device qualification and an affirmative production authorization record. The assessment function does not execute publishing, deploy, or grant permissions.

Maintainer verification:
1. Pin a source commit and review README, AGENTS.md, the approved development plan and release notes.
2. On Node 24.19.0 and TypeScript 7.0.2, run npm ci --ignore-scripts, npm run check, npm run rehearsal and applicable native integration scripts. Record exit codes and exact SHA.
3. Inspect GitHub required jobs, actual branch protection and mergeability; retain packed source artifacts, digests and offline consumer smoke results.
4. Review security, privacy, migrations, rollback and recovery evidence. AI-assisted review is not independent certification.
5. For hardware/production claims, require real supported-device trials, interrupt timing, soak evidence and operator authorization. Otherwise mark field/prod NOT VERIFIED.
6. Do not bump stable versions, distribute packages, deploy production services or trigger paid resources based only on an advisory assessment.

No stable release, deployment, hardware field qualification or independent certification is claimed by this development PR.
