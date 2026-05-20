# PHAROS deploy

Two services:

- **pharos** — graph-space backend (port 3002)
- **gun-relay** — Gun WebSocket relay for P2P sync between users (port 8765)

## Local stack (no VPS yet)

```bash
# from repo root
cd deploy
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... PHAROS_NAME=Ian docker compose up --build
```

PHAROS at http://localhost:3002, relay health at http://localhost:8765/health.

## Just the relay locally (for development against the live PM2 instance)

```bash
cd deploy/gun-relay
npm install
node relay.js
# then restart the PM2 graph-space with GUN_RELAY_URL=http://localhost:8765/gun
```

## VPS

Cheapest $4–5/mo VPS (DigitalOcean, Hetzner, Vultr) is fine. Open port 8765
for the relay, then:

```bash
scp -r deploy/gun-relay your-vps:/opt/gun-relay/
ssh your-vps "cd /opt/gun-relay && docker build -t gun-relay . && \
  docker run -d --restart unless-stopped -p 8765:8765 \
    -v gun-data:/opt/gun-relay/data --name gun-relay gun-relay"
```

Verify: `curl http://your-vps:8765/health` → `{"status":"ok"}`.

Then on each user's machine, point their PHAROS at the VPS:

```bash
GUN_RELAY_URL=http://your-vps:8765/gun pm2 restart graph-space
```
