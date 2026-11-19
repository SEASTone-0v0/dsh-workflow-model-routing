# Release and Security Audit — v2.6.4

Audit date: 2026-11-19

## Verdict

This directory is a local public-source candidate for the `dsh-workflow-model-routing` GitHub repository. The reviewed release contains no detected real credentials, private configuration backups, local deployment records, personal session identifiers, or hard-coded personal filesystem paths.

No remote repository was created, no content was pushed or published, and the source project was not modified.

## Included scope

- Plugin source in `lib/` and the current generated runtime in `runtime-7ce3d337381a/`.
- Build, migration, and release-audit scripts in `scripts/`.
- Seven offline test scripts in `test/`.
- Eleven Chinese user-manual chapters in `docs/user-manual/`.
- `package.json`, `package-lock.json`, `cordis.patch.yml`, `icon.svg`, and `release-notes.json`.
- `README.md`, `LICENSE`, `SECURITY.md`, `.gitignore`, and this report.

## Excluded scope

- `backups/`, live configuration snapshots, and `tmp-*` migration/configuration files.
- Historical deployment documents containing workstation paths or local Host ports.
- Obsolete runtime directories, SSS generated output, screenshots, and preview artifacts.
- `.dsh/`, `.env*`, dependency directories, npm caches, and generated tarball output.

## Release fixes applied to this copy

1. Changed the npm allowlist from `runtime-*` to `runtime-*/**`; the previous rule produced a tarball without the declared runtime entry.
2. Replaced the hard-coded model-tier source path with `DSH_WORKFLOW_MODEL_ROUTING_TIERS_FILE`; an unset or missing source uses built-in fallback tiers.
3. Replaced cross-project test resolution with `createRequire(import.meta.url)` and declared `jsdom`, `react`, and `react-dom` as development dependencies.
4. Added a reproducible lockfile, package scripts, a Node.js engine range aligned with the locked test dependencies, and an MIT license.
5. Replaced a documentation workstation-style path with a neutral example and changed credential-redaction test values to obvious non-secret fixtures.
6. Added `scripts/audit-release.mjs`, which reports only file locations and rule IDs, never matched secret values.

## Security checks

The release audit checks for:

- Private-key blocks, common GitHub/AWS token shapes, and API-key-shaped values.
- Windows absolute paths and session UUIDs.
- Symbolic links and forbidden local-data entries.
- Missing package entry declarations or missing runtime entry files.

Additional repository searches found no `.env`, private-key, certificate-store, backup, or root `tmp-*.json` files. Credential-assignment matches were reviewed as intentional test fixtures and replaced with explicit non-secret examples.

The repeatable audit result is **PASS, 0 findings**. This is a high-confidence release-hygiene review, not a formal security assessment or proof that every possible secret format is covered.

## Verification evidence

- `npm test`: all seven test scripts passed.
  - AI assistant: 38 passed.
  - AI jobs: 11 passed.
  - Execution integration: 14 checks passed.
  - Migration CLI: PASS, including dry-run default, stale-apply rejection, zero apply requests, and zero model calls.
  - Modes client: 63 passed.
  - Route policy: 10 checks passed.
  - Smoke/integration: 103 checks passed.
- `npm run audit`: PASS with zero findings.
- `npm pack --dry-run --ignore-scripts`: 24 package entries, including all nine current runtime modules, `README.md`, and `LICENSE`.
- The final source diff was reviewed; only the intended packaging, portability, documentation, and test-fixture changes differ from the public source copy.

## Verification boundaries

- Tests use fakes/jsdom and make no real paid or subscription model calls.
- Tests used preinstalled copies of the declared dependency versions through `NODE_PATH`; a clean `npm ci` was not performed. The lockfile was resolved separately with lifecycle scripts disabled.
- A real clean-profile DSH installation, Web GUI workflow, provider connection, model authorization, and production dispatch were not tested.
- An additional actual-tarball extraction/import helper did not pass its temporary-directory safety guard, so tarball import is not claimed as verified. The npm dry-run file-list check did pass.
- The exact compatible DSH version range remains unverified; the README records the historical baseline without inventing a broad compatibility claim.

## Before publishing

1. Review `git status --short` and confirm no ignored local files are already tracked.
2. Review the editable initial model preset in `cordis.patch.yml` for the intended public audience.
3. Create the GitHub repository separately, then add its real URL to the package metadata if desired.
4. Publish only after the repository owner accepts the verification boundaries above.
