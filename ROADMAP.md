# 9n9 roadmap

9n9 is a local-first, self-hosted automation system with no paid edition,
cloud-account requirement, or telemetry. This file is the durable product plan.

## v0.2 — Workflow editor (complete)

- Drag/drop and click-to-add node placement.
- Reliable connections with duplicate, input, and cycle protection.
- Keyboard deletion and undo/redo.
- Workflow validation with clickable errors.
- Per-node testing with JSON input/output.
- Expression picker for input and upstream values.
- Browser regression tests locally and against the deployed Pi.

## v0.3 — Security and credentials (complete)

- Local admin account with first-run password setup.
- Secure session cookies and login/logout UI.
- Login and sensitive-route rate limiting.
- CSRF protection for state-changing browser requests.
- Optional trusted-LAN-only mode.
- Generated webhook tokens, authentication, and rotation.
- Encrypted credential storage with the master key outside SQLite.
- API key, bearer token, basic auth, OAuth token, and SSH key credentials.
- Secret masking in UI, API responses, execution output, and logs.
- Credential picker inside supported nodes.
- Prevent expressions and workflow output from reading stored secrets.
- Audit events for authentication, credentials, webhook tokens, and security changes.

## v0.4 — Workflow management (complete)

- Delete, duplicate, archive, and restore workflows.
- Export/import workflow JSON and reusable templates.
- Editable unique webhook slugs.
- Descriptions, tags, search, filters, and sorting.
- Debounced autosave with visible save/error state.
- Unsaved-navigation protection.
- Workflow version history and restore.
- Invalid-flow activation confirmation.

## v0.5 — Editor improvements (complete)

- Multi-select, box selection, copy/paste, duplication, and group movement.
- Keyboard-shortcut help and context menus.
- Edge deletion controls, reconnecting, and labels.
- Automatic layout, snap-to-grid, minimap, and zoom-to-selected.
- Collapsible palette/inspector, node search, and recent nodes.
- Node defaults, notes, canvas groups, and sticky notes.
- Keyboard-only accessibility and smaller-screen fallback.

## v0.6 — Expressions and data mapping

- Syntax-highlighted expression editor with autocomplete.
- Browse previous-node output and insert fields by clicking.
- Expression preview and validation.
- Missing-path diagnostics and fallback values.
- String, number, boolean, date, JSON, array, and object transforms.
- JSONPath support and binary/file references.
- Pinned sample data and data from previous runs.
- Separate development and production samples.

## v0.7 — Execution engine reliability

- Server-side DAG validation and deterministic ordering.
- Parallel branches, joins, merges, and skipped-node traces.
- Cancellation and workflow/node timeouts.
- Retry policies with fixed or exponential delays.
- Continue-on-error and explicit error branches.
- Payload/output limits and full-output artifacts.
- Queueing, concurrency limits, and overlapping-run policies.
- Webhook idempotency and request-size limits.
- Run node/from node/until node, replay, resume, and manual approval.
- Persist in-flight state across restarts.

## v0.8 — Triggers

- Manual JSON input editor.
- Full HTTP-method webhooks with custom responses.
- Separate test and production webhook URLs.
- Cron builder, timezones, intervals, and missed-run handling.
- File watcher, MQTT, email/IMAP, RSS, GitHub, polling, and startup triggers.

## v0.9 — Core nodes

### Data and logic

- Set, rename, remove, merge, split, aggregate, filter, switch, loop, and delay.
- JavaScript, date/time, JSON, text, hashing, Base64, compression, and files.

### System and network

- Authenticated HTTP, SSH, allow-listed local shell, SFTP, and Docker.
- MQTT, TCP, DNS, ping/health checks, and Wake-on-LAN.

### Communication

- Telegram, Discord, Slack, email/SMTP, Matrix, and webhook responses.

### Data stores

- PostgreSQL, MySQL/MariaDB, SQLite, Redis, MongoDB, Sheets, CSV, and JSON.

### Development and AI

- GitHub, GitLab, Git, registries, subflows, and the 9n9 API.
- Structured Codex sessions, local Ollama, OpenAI-compatible endpoints,
  schemas, approvals, limits, and workspace permission profiles.

## v0.10 — Credentials and OAuth integrations

- OAuth callbacks, refresh, expiry detection, and health tests.
- Credential usage lists, rotation, and access restrictions.
- Environment, Docker, file, Vault, and Bitwarden secret sources.
- SSH known-host checks, custom TLS CAs, and client certificates.

## v0.11 — Debugging and observability

- Live execution progress and node-state highlighting.
- Per-node I/O, search, and complete run downloads.
- Structured logs, levels, timing, success/failure, queue, disk, and health data.
- Codex/scheduler/webhook diagnostics and error notifications.
- Prometheus and optional OpenTelemetry/log forwarding, disabled by default.

## v0.12 — Data management and backups

- Scheduled/manual verified backups with retention and restore.
- Database integrity checks and migration rollback strategy.
- Separate workflow and encrypted-credential exports.
- Run-history retention, payload cleanup, and disk warnings.
- Graceful shutdown before upgrades.

## v0.13 — Plugin and node SDK

- Stable manifests, typed I/O, fields, credentials, triggers, execution, and validation.
- Local/Git plugin discovery, compatibility checks, and enable/disable controls.
- Development CLI, hot reload, test harness, examples, and eventual signatures.
- No proprietary marketplace requirement.

## v0.14 — API and command line

- Scoped API tokens and documented workflow/run/credential/webhook APIs.
- OpenAPI document.
- CLI for workflows, runs, export/import, backup/restore, health, and deployment.
- Stable machine-readable output.

## v0.15 — Operations and deployment

- One-command Pi installation, upgrades, backups, and rollback.
- Published arm64/amd64 images and tagged releases.
- Startup migration/config checks, readiness, graceful shutdown, and resource limits.
- Log rotation, Caddy/nginx/local HTTPS/Tailscale/firewall examples.
- systemd and offline-install options.
- Secret-safe diagnostic bundles and update notifications without telemetry.

## v1.0 — Production-ready local automation

- Security review and threat model.
- Dependency/container scanning.
- Backup, restore, migration, upgrade, and rollback drills.
- Browser, ARM stress, scheduler longevity, webhook load, database recovery,
  and Codex recovery tests.
- Complete user, API, node-author, examples, release, and migration documentation.
- Stable workflow format and plugin API.

## Post-v1 — Optional expansion

- Multiple users, roles, sharing, and approvals.
- Git-backed workflows and development/staging/production environments.
- Remote workers, distributed queues, and high availability.
- Forms, public templates, mobile monitoring, and desktop packaging.
- Visual subflows and AI-assisted generation/debugging.
