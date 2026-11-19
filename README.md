# DSH Workflow Model Routing

A DeepSeek Harness plugin for execution modes, role tiers, and explicit primary/backup/upgrade model routing in multi-agent workflows.

中文名称：**运行模式与团队路由**。当前版本：**2.6.4**。

## Features

- Four independent execution-mode drafts: `economy`, `normal`, `performance`, and `broke`（经济、普通、性能、穷鬼）.
- Lead defaults, plugin dispatch controls, and plugin concurrency in the main control module.
- Centralized professional roles, optional team-role overrides, and escalation-advisor configuration.
- Explicit authorized-model lists, route validation, capability metadata, and advisory tier badges.
- AI-assisted configuration drafts with asynchronous jobs; generated content still requires review.
- A content-addressed runtime directory to avoid stale Node ESM modules after plugin reactivation.

## Routing semantics

- **Primary** is the default first-dispatch route.
- **Backup** is an explicit reassignment after a primary-channel or quota failure; it is not automatic failover.
- **Upgrade** is an explicit escalation after complex blockers, evidenced quality failures, or review rejection; it is not automatic scheduling.
- Route precedence is `override > teamRole > role[tier]`.
- Mode definitions are model-neutral preferences, not provider bans or guarantees of availability.

Saving a draft is different from enabling it. A model visible in a catalog is not proof of credentials, subscription access, endpoint health, input modality, or reasoning-effort support.

The plugin's dispatch switch and concurrency limits apply to its `role_subagent` path, not to every native DSH subagent tool.

## Requirements

- A compatible DeepSeek Harness installation with Cordis bundle patches, Web client support, and the official subagent model-selection integration.
- Node.js 22.12+ or 24+ for building and testing this repository.
- Separately configured model providers and credentials. This repository contains no provider credentials.

The historical source baseline references DSH 0.2.2-rc.3. Compatibility with other DSH versions must be verified before enabling the plugin; no broad version range is claimed here.

## Build and verify

```bash
npm install
npm run build
npm test
npm run audit
npm run pack:check
```

The test suite uses local fakes and jsdom. It does not make real model calls. `npm run audit` performs repeatable high-confidence secret, local-path, session-ID, symlink, forbidden-file, and package-entry checks; it is not a substitute for a professional security review.

`npm run pack:check` must list the current `runtime-*` files. A package without the runtime entry is not installable.

## Package and installation

```bash
npm run build
npm pack --ignore-scripts
```

Install the resulting tarball only through a DSH version that supports local bundle installation, then review and enable the bundle. The package remains `private: true` to prevent accidental npm publication; GitHub source archives and verified release tarballs are the intended distribution artifacts.

Review [cordis.patch.yml](cordis.patch.yml) before installation. Its model list is an editable initial preset, not evidence that those routes are available in your profile.

## Optional model-tier source

Tier badges work without an external file. To supply your own curated Markdown source, set:

```text
DSH_WORKFLOW_MODEL_ROUTING_TIERS_FILE=/path/to/your/model-tiers.md
```

If the variable is unset or the file is unavailable, the plugin uses built-in fallback tiers. Do not commit private configuration snapshots or credential files.

## Documentation

The Chinese user manual is in [docs/user-manual/](docs/user-manual/):

1. [Reading guide and quick start](docs/user-manual/00-reader-guide.md)
2. [Main control](docs/user-manual/01-main-control.md)
3. [Role center](docs/user-manual/02-role-center.md)
4. [Model configuration](docs/user-manual/03-model-config.md)
5. [Save and enable](docs/user-manual/04-save-enable.md)
6. [AI assistant](docs/user-manual/05-ai-assistant.md)
7. [Troubleshooting](docs/user-manual/06-troubleshooting.md)
8. [SSS collaboration network](docs/user-manual/07-sss-network.md)
9. [Task lifecycle](docs/user-manual/08-task-lifecycle.md)
10. [Examples](docs/user-manual/09-examples.md)
11. [Reference](docs/user-manual/10-reference.md)

The SSS collaboration network described in the manual is an interactive representation of saved configuration snapshots; it is not an SSS business execution engine.

## Security and release status

See [SECURITY.md](SECURITY.md) and [RELEASE-AUDIT.md](RELEASE-AUDIT.md). Offline tests and packaging checks do not prove a clean-profile GUI installation, real provider connectivity, paid model access, or production workflow success.

## License

[MIT](LICENSE) — Copyright (c) 2026 dsh-workflow-model-routing contributors.
