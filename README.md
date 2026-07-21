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
The browser tests use an isolated temporary SQLite database and cover adding and
configuring nodes, saving a durable graph, running a flow, webhooks, and run
history. Failure screenshots, traces, and videos are written to `test-results/`.

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

Keep port `9999` on your trusted LAN or behind a reverse proxy. Version 0.1
intentionally has no multi-user authentication.

## Webhooks

Enable a flow containing a Webhook trigger, then call:

```bash
curl -X POST http://YOUR_PI_IP:9999/hooks/FLOW_SLUG \
  -H 'content-type: application/json' \
  -d '{"message":"hello"}'
```

## License

MIT. No paid edition.
