# Self-hosting GymCoach

The README gets you to a running container in one minute. This guide covers what
comes after: putting GymCoach behind a reverse proxy with HTTPS, backing up the
two volumes, upgrading without losing data, and choosing a model for the AI
coach. [docs/faq.md](faq.md) answers the questions that come up most often.

The commands below assume the [one-minute setup](../README.md#self-host-in-one-minute):
a directory (called `gymcoach` here) that holds `docker-compose.yml` and `.env`,
started with `docker compose up -d`. The container listens on the host port
`GYMCOACH_PORT` (default `3000`) and speaks plain HTTP; TLS belongs in the proxy
in front of it.

## Before you expose it

- **Architecture**: the published image is `linux/amd64` only. ARM hosts and
  Raspberry Pis are tracked in [#411](https://github.com/gymcoach-app/gymcoach/issues/411).
- **Secrets**: `.env` holds `JWT_SECRET` and the database password. Generate
  both once, never rotate them by rewriting the file (a new database password
  locks the app out of the existing database), and keep a copy with your
  backups.
- **Accounts**: the signup page is public (rate-limited to 5 attempts per
  minute per IP). Each account has its own data; there is no admin role. If the
  instance should be for a known group only, keep it on a VPN or put an IP
  allowlist in the proxy rather than relying on the signup page.
- **Disk**: the database and the progress photos grow with use. Both live in
  Docker volumes, so the disk that holds `/var/lib/docker` is the one to watch.

## Put it behind a reverse proxy

All four examples below proxy to the app on the host at `127.0.0.1:3000`
(change the port if you set `GYMCOACH_PORT`). Two settings belong in `.env`
once a domain points at the instance:

```bash
# Public HTTPS origin, used when GymCoach builds ChatGPT connector URLs.
MCP_PUBLIC_URL=https://gym.example.com
# Optional: exact-match allowlists for the MCP endpoint (issue #287).
# Setting either one enables DNS rebinding protection on the MCP transport.
MCP_ALLOWED_ORIGINS=https://gym.example.com
MCP_ALLOWED_HOSTS=gym.example.com
```

Leave `SESSION_COOKIE_SECURE` unset behind an HTTPS proxy. In production the
session cookie is `Secure` by default, which is what you want; see
[HTTPS on a home network](#https-on-a-home-network) for the plain-HTTP case.

### Caddy

Caddy obtains and renews certificates on its own. In the `Caddyfile`:

```caddyfile
gym.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000 {
		# The coach chat streams its reply; do not buffer it.
		flush_interval -1
	}
}
```

Reload with `caddy reload --config /etc/caddy/Caddyfile`.

### nginx

With certificates from Certbot in the usual Let's Encrypt paths:

```nginx
server {
    listen 443 ssl;
    server_name gym.example.com;

    ssl_certificate     /etc/letsencrypt/live/gym.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gym.example.com/privkey.pem;

    # Progress photos are uploaded through the app.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The coach chat streams its reply; buffering would hold it back.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Check the config with `nginx -t` and reload with `systemctl reload nginx`.

### Traefik

Traefik can read this from its file provider (`providers.file` in the static
configuration). The certificate resolver name depends on your Traefik setup;
`letsencrypt` is the common one.

```yaml
# dynamic.yml
http:
  routers:
    gymcoach:
      rule: Host(`gym.example.com`)
      service: gymcoach
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
  services:
    gymcoach:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:3000
```

### Cloudflare Tunnel

A tunnel avoids opening a port on your router. Create the tunnel in the
Cloudflare dashboard (or with `cloudflared tunnel create gymcoach`), then run
`cloudflared` with a config like this:

```yaml
# ~/.cloudflared/config.yml
tunnel: <TUNNEL-UUID>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: gym.example.com
    service: http://localhost:3000
  - service: http_status:404
```

Then `cloudflared tunnel run gymcoach`, or install the service with
`cloudflared service install`. Cloudflare's proxy has a 100 second response
timeout and a 100 MB upload limit on the free plan, both far above what the app
produces.

In every case, confirm the proxied URL serves the login page and that
`https://gym.example.com/login` is reachable from a phone before creating the
first account through the domain.

## HTTPS on a home network

A reverse proxy needs a certificate that the browser trusts. There are four
workable paths, in rough order of effort:

1. **Public domain, public proxy** (the sections above): Let's Encrypt validates
   the domain over HTTP or DNS, the proxy terminates TLS, and the instance can
   stay on the LAN if the router forwards 80/443 or a tunnel is used.
2. **Cloudflare Tunnel**: no port forwarding, certificate handled by Cloudflare.
   See the section above.
3. **Tailscale**: install Tailscale on the host and run `tailscale serve --bg 3000`.
   Tailscale terminates HTTPS with a certificate for your tailnet name, so the
   app is reachable only on the tailnet. No DNS record or port forwarding is
   needed.
4. **Local certificate authority** (`mkcert` or an internal CA): Caddy or nginx
   serves a certificate signed by that CA. Every device that should open the app
   needs the CA root installed. This keeps the instance entirely offline, and
   the certificate renewal is manual.

If you skip TLS and use plain HTTP on a trusted LAN, browsers discard the
`Secure` session cookie, so login appears to succeed and then immediately fails.
Set the opt-out explicitly:

```bash
# .env, only for plain HTTP on a network you trust
SESSION_COOKIE_SECURE=false
```

Never expose a `SESSION_COOKIE_SECURE=false` instance to the internet. And note
that the ChatGPT connector requires a public HTTPS URL regardless
([docs/chatgpt-mcp.md](chatgpt-mcp.md)); a LAN address will not work there.

## Back up the database and the uploads

Two Docker volumes hold everything the container writes: `postgres-data`
(database) and `uploads` (progress photos). Compose prefixes both with the
project name, which defaults to the directory name, so from `~/gymcoach` they
are `gymcoach_postgres-data` and `gymcoach_uploads`. Check with
`docker volume ls` if the directory was named differently.

A backup is three things: the database dump, the uploads archive, and `.env`.

```bash
cd ~/gymcoach
day=$(date +%F)
mkdir -p "backups/$day"

# 1. Database
docker compose exec -T db pg_dump -U gymcoach -d gymcoach \
  --clean --if-exists > "backups/$day/gymcoach.sql"

# 2. Progress photos (the volume is <project>_uploads)
docker run --rm \
  -v "gymcoach_uploads:/data:ro" \
  -v "$PWD/backups/$day:/backup" \
  alpine tar czf /backup/uploads.tar.gz -C /data .

# 3. The secrets
cp .env "backups/$day/env.bak"
```

Keep `.env` out of shared archives: it contains the database password and the
JWT secret. Restoring the database without the matching `POSTGRES_PASSWORD`
leaves the app unable to connect.

The in-app export is a different thing: **Settings -> Data -> Export all my
data (JSON)** writes one account's data (exercises, programs, sessions,
measurements and so on) to a file, and **Import a backup** in the same section
loads it back. It is useful for moving one user's history or for keeping a copy
you can read, but it is not a disaster-recovery backup of the instance.

### Restore onto the same host

Stop the app first so nothing writes while the database is being replaced:

```bash
cd ~/gymcoach
day=2026-10-22   # the folder you want to restore

docker compose down

# Recreate the database and load the dump (it drops existing objects first).
docker compose up -d db
cat "backups/$day/gymcoach.sql" | docker compose exec -T db psql -U gymcoach -d gymcoach

# Walk the photos back into the volume.
docker run --rm \
  -v "gymcoach_uploads:/data" \
  -v "$PWD/backups/$day:/backup" \
  alpine sh -c "cd /data && tar xzf /backup/uploads.tar.gz"

# Restore the matching .env, then start the app.
cp "backups/$day/env.bak" .env
docker compose up -d
```

The first start after a restore reapplies migrations (a no-op when the dump is
from the same version). Sign in with an account that existed in the backup.

### Restore onto a new host

Install Docker, create the directory, and put `docker-compose.yml` and the
backup folder in it. Then:

```bash
cd ~/gymcoach
day=2026-10-22

cp "backups/$day/env.bak" .env
docker compose up -d db

# The app's volumes are created by compose; load both.
cat "backups/$day/gymcoach.sql" | docker compose exec -T db psql -U gymcoach -d gymcoach
docker run --rm \
  -v "gymcoach_uploads:/data" \
  -v "$PWD/backups/$day:/backup" \
  alpine sh -c "cd /data && tar xzf /backup/uploads.tar.gz"

docker compose up -d
```

Point the DNS record (or the tunnel) at the new host when the login page
answers.

## Upgrade and roll back

Migrations run on every start (`migrate deploy`, a no-op when there is nothing
new), so an upgrade is a pull and a recreate. Take a backup first: a failed
upgrade is the one time you want the dump from five minutes ago.

```bash
cd ~/gymcoach

# Back up first, with the recipe above, then:
docker compose pull
docker compose up -d
docker compose ps
```

`docker compose ps` should show `db` healthy and `app` running. Open the site
and sign in. If the app crash-loops, read the log:

```bash
docker compose logs --tail=100 app
```

`latest` follows `main`. Every commit that passes CI also publishes an
immutable `sha-<short>` tag, which is what to pin for a deployment you do not
want to move under you:

```yaml
# docker-compose.yml, app service
image: ghcr.io/gymcoach-app/gymcoach:sha-2b1f4c8
```

To roll back, restore the previous tag and run `docker compose up -d`. Database
migrations are forward-only: if the failed upgrade applied a migration, an
older image will not work against that schema. In that case restore the
pre-upgrade backup instead of rolling the tag back.

If the instance still uses the pre-2026-10-05 image name
(`ghcr.io/julien-au/gymcoach`), see
[Pulling the prebuilt image](../README.md#pulling-the-prebuilt-image): those
images no longer receive updates.

## Choose a model for the AI coach

Without a key GymCoach is a plain tracker: the coach, the chat and program
generation say that no provider is configured. With a key, three surfaces call
the model: the weekly debrief, the chat (streamed, up to 4096 output tokens per
reply) and program generation. Your provider bills those calls at its own
per-token prices, and GymCoach has no built-in spend cap, so watch the
provider's usage dashboard for the first week.

Set one provider in `.env`:

| `LLM_PROVIDER`        | Key and model variables                                   | Notes                                                                                                                                                              |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anthropic` (default) | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`                    | Defaults to `claude-opus-4-7`. `claude-sonnet-4-6` and `claude-haiku-4-5` trade some coaching quality for lower cost.                                              |
| `openrouter`          | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`                  | Any model on OpenRouter, for example `anthropic/claude-sonnet-4.5`. Reasoning models also need `OPENROUTER_MAX_TOKENS` (their thinking counts against the budget). |
| `codex-lb`            | `CODEX_LB_BASE_URL`, `CODEX_LB_API_KEY`, `CODEX_LB_MODEL` | Any OpenAI Responses-compatible endpoint; include `/v1` in the base URL.                                                                                           |
| `demo`                | none                                                      | Canned replies. Useful to click through the AI screens without a key.                                                                                              |

Pricing is provider-side, so check the current tables rather than trusting a
number in a repository: [Anthropic pricing](https://www.anthropic.com/pricing)
and [OpenRouter models](https://openrouter.ai/models) (each model page lists its
input and output price).

Practical cost levers, cheapest first:

- Leave the key unset and use the tracker. Everything except the coach works.
- Use a smaller model for daily chat (`claude-haiku-4-5`,
  `anthropic/claude-haiku-4.5` on OpenRouter) and keep the expensive one for
  the weekly debrief, or accept the default and try it for a week.
- Chat output dominates the bill: a reply costs its output tokens, and the
  system prompt carries the recent training data. Long conversations are more
  expensive than many short ones.
- `LLM_PROVIDER=demo` costs nothing and exercises every AI screen.

## Troubleshooting

The fastest checks on the host:

```bash
cd ~/gymcoach
docker compose ps                    # both services up, db healthy
docker compose logs --tail=100 app   # app errors, migration failures
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

A `200` from the last command means the app answers locally, so the remaining
problem is in the proxy. `502` or a connection refused from the proxy means the
port does not match `GYMCOACH_PORT`, or the app is not up yet.

More answers in [docs/faq.md](faq.md).
