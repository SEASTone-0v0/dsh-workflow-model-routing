# Security Policy

## Supported version

Security and packaging review currently applies to the 2.6.4 source release.

## Reporting a vulnerability

Use GitHub private vulnerability reporting when it is enabled for the repository, or contact the repository owner privately. Do not open a public issue containing credentials, private configuration, exploit payloads against third parties, or sensitive profile data.

Never include real API keys, cookies, OAuth tokens, subscription details, or private model endpoints in bug reports. Redact local paths when they are not necessary to reproduce the issue.

## Configuration safety

- Review `cordis.patch.yml` before enabling the bundle.
- Model authorization is an allowlist, not proof of provider permissions or endpoint security.
- Save and enable are separate actions; review AI-generated drafts before applying them.
- The deployment migration CLI defaults to dry-run. Its `--apply` option can modify DSH configuration and must be used only after reviewing the plan and current revisions.
- Local Host routes are intended for loopback use. Do not expose them to untrusted networks.

The release audit is a high-confidence automated review, not a guarantee that every secret or vulnerability has been found.
