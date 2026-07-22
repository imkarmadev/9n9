# 9n9

A small, local-first workflow engine for one Raspberry Pi and one owner.

No cloud account. No telemetry. No enterprise edition. No API-key requirement
for Codex: 9n9 calls the private, already-authenticated `codex-agent` bridge.

## Current features

- Visual flow editor
- Drag/drop node placement with collision and viewport protection
- Reliable one-input connections with cycle and duplicate protection
- Keyboard deletion plus undo/redo
- Live workflow validation before execution
- Per-node testing with editable JSON input and visible output
- Expression picker for input and upstream step values
- Manual, webhook, and cron triggers
- Local Codex, HTTP, compose, and condition nodes
- SQLite workflow storage and run history
- First-run local admin, hardened sessions, CSRF, rate limits, and audit log
- AES-256-GCM encrypted local credentials with API key, bearer, basic, OAuth,
  and SSH key types
- Server-only credential injection with masking/redaction in APIs and run data
- Token-authenticated webhooks with one-time display and immediate rotation
- Archive, restore, duplicate, permanently delete, search, filter, and sort flows
- Editable descriptions, tags, and unique webhook slugs
- Debounced race-safe autosave with unsaved-navigation protection
- Immutable workflow version history with disabled-on-restore rollback
- Portable JSON import/export and credential-free reusable templates
- Docker image for arm64 and amd64
- Template values such as `{{input.body}}` and `{{steps.nodeId.body}}`

## Editor controls

- Drag a palette item to place it exactly, or click it to add near the center.
- Drag from a node's right handle to the next node's left handle.
- Select a node or connection and press `Delete` or `Backspace`.
- Use `Ctrl/Cmd+Z` to undo and `Ctrl/Cmd+Shift+Z` to redo.
- Open the validation badge in the header to jump to broken nodes.
- Select a node to insert expressions or run it alone with test JSON.

## Local development

Requires Node.js 22 or newer.

```bash
cp .env.example .env
sed -i.bak "s|^N9N_MASTER_KEY=.*|N9N_MASTER_KEY=$(openssl rand -base64 32)|" .env
npm ci
npx playwright install chromium
npm run dev
```

Open <http://localhost:3000>.

## Development flow

Run the full gate before merging or deploying:

```bash
npm run check
```

That runs ESLint, a production Next.js build, and the Playwright browser suite.
The browser tests use an isolated temporary SQLite database and cover auth and
CSRF boundaries, hardened cookies, login rate limits, encrypted/masked
credentials, server-side secret injection and redaction, webhook rotation,
workflow lifecycle, metadata, search/filter/sort, race-safe autosave, navigation
protection, import/export, templates, versions, activation confirmation,
editing, execution, and run history. Failure screenshots, traces, and videos
are written to `test-results/`.

## Workflow management

- Use the search and status/sort controls above the flow list.
- Open **Workflow settings** from the editor header to edit the slug,
  description, and tags or to duplicate, archive, export, template, restore a
  version, or permanently delete the flow.
- Changes autosave after a short debounce; edits made during an in-flight save
  remain pending and save next.
- Imported workflows, template instances, duplicates, and restored versions
  start disabled. Templates intentionally omit credential bindings.
- Enabling an invalid workflow requires an explicit confirmation and is also
  enforced by the server API.

For faster browser-test iteration:

```bash
npm run test:e2e
npm run test:e2e:ui
```

After deploying, test the real LAN origin too:

```bash
npm run test:e2e:live
```

This matters because browsers apply different security rules to `localhost`
and a plain-HTTP LAN address. The Pi deployment command runs this live suite
automatically after its health check.

GitHub Actions runs the same gate for every push to `main` and every pull
request.

## Raspberry Pi

The current Codex companion is attached to the n8n Docker network, so the
default Compose configuration joins that same private network:

```bash
docker compose up -d --build
```

Open `http://YOUR_PI_IP:9999`.

The deploy script creates the master key and an initial random admin password
without printing either one. Retrieve the initial password over SSH:

```bash
ssh imkarma@192.168.1.95 'sudo cat /opt/9n9/.initial-admin-password'
```

Sign in as `admin`, then change it from **Security**. The initial-password file
is only for first access and is not rewritten when you change the password.

From a development machine on the same LAN, deploy only after all checks pass:

```bash
npm run deploy:pi
```

The deploy command runs the full quality gate, mirrors the verified source to
`imkarma@192.168.1.95:/opt/9n9`, rebuilds the Docker service, and waits for its
health endpoint. Override `N9N_PI_TARGET`, `N9N_PI_PATH`, or `N9N_PI_URL` when
deploying somewhere else.

Before removing n8n permanently, give the Codex bridge a durable network:

```bash
docker network create codex-private
docker network connect codex-private codex-agent
```

Then change the `codex` network name in `docker-compose.yml` to
`codex-private` and redeploy.

Keep port `9999` on your trusted LAN or behind a reverse proxy. Set
`N9N_PUBLIC_ORIGIN` to the exact browser origin so origin and CSRF validation
remain strict. `N9N_TRUSTED_LAN_ONLY=true` adds the optional application-level
LAN check; a host firewall or private-interface bind remains the stronger
network boundary.

## Webhooks

Enable a flow containing a Webhook trigger, then call:

```bash
curl -X POST http://YOUR_PI_IP:9999/hooks/FLOW_SLUG \
  -H 'authorization: Bearer YOUR_ONE_TIME_WEBHOOK_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"message":"hello"}'
```

Create or rotate the token from the Webhook node inspector. 9n9 stores only
its SHA-256 digest, so the raw token cannot be recovered later.

The complete product plan is tracked in [ROADMAP.md](./ROADMAP.md).

## License

MIT. No paid edition.
