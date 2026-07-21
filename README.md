# 9n9

A small, local-first workflow engine for one Raspberry Pi and one owner.

No cloud account. No telemetry. No enterprise edition. No API-key requirement
for Codex: 9n9 calls the private, already-authenticated `codex-agent` bridge.

## First slice

- Visual flow editor
- Manual, webhook, and cron triggers
- Local Codex, HTTP, compose, and condition nodes
- SQLite workflow storage and run history
- Docker image for arm64 and amd64
- Template values such as `{{input.body}}` and `{{steps.nodeId.body}}`

## Local development

Requires Node.js 22 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

Open <http://localhost:3000>.

## Raspberry Pi

The current Codex companion is attached to the n8n Docker network, so the
default Compose configuration joins that same private network:

```bash
docker compose up -d --build
```

Open `http://YOUR_PI_IP:9999`.

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
