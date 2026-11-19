# AGENTS.md — WebDNSChecker

Instructions for AI coding agents (and humans) working in this repo. These are
deliberate decisions agreed with the project owner — do not change them without
asking.

## What this is
A self-hosted web app for running DNS lookups (nslookup / dig equivalent) from a
simple browser UI. Runs in Docker, published to Docker Hub. Intended for a home
lab / trusted LAN.

## Hard constraints
- **No CDN / no external requests from the UI.** Everything is served from this
  app. CSP is `default-src 'self'`. Use the system font stack and inline SVG
  icons — no web fonts, no icon libraries, no analytics.
- **Backend: plain `node:http`.** No Express, Fastify, or other framework.
  Reason: two endpoints + static files; keep the image small and the
  dependency/CVE surface minimal.
- **One runtime dependency: `dns-packet`.** Any new runtime dependency needs a
  clear justification and owner approval. Dev dependencies should also be
  avoided — use `node:test` for tests.
- **Frontend: vanilla HTML/CSS/JS, no build step.** Files in `public/` are served
  as-is.
- **Node 22 LTS, ES modules** (`"type": "module"`).

## Behavior rules
- **Two result views from one query engine.** Summary (nslookup-style) is the
  **default**; a toggle switches to Dig view (header, flags, QUESTION / ANSWER /
  AUTHORITY / ADDITIONAL sections, query time, server).
- **"Default" DNS server = the container's resolver** (`dns.getServers()[0]`,
  i.e. Docker's resolv.conf / `--dns`), overridable with env `DEFAULT_DNS`.
- **Custom DNS server**: IPv4/IPv6 with optional port (`1.2.3.4:5353`,
  `[2001:db8::1]:53`). Transport is **UDP with automatic TCP fallback** when the
  response is truncated (TC bit). **No DoH/DoT.**
- **Cookie history**: cookie `dnsServers` holds a JSON array of up to **5**
  custom servers, most-recently-used first. A server is saved **only after a
  successful query**. Users can remove entries. Cookie `dnsMode` remembers
  Default vs Custom. Cookies: `Path=/; SameSite=Lax; Max-Age=31536000`.
- **"All common types"** option queries A, AAAA, CNAME, MX, NS, TXT, SOA, CAA in
  parallel.
- **PTR**: entering an IP with type PTR auto-converts to the in-addr.arpa /
  ip6.arpa name.
- **Shareable URLs**: query state is reflected in the URL
  (`?name=&type=&server=&view=`); loading such a URL pre-fills and auto-runs.
- **Theme**: auto light/dark via `prefers-color-scheme`, plus a manual toggle
  remembered in `localStorage`.
- **Mobile-first**, works on phones and desktop; touch targets ≥ 44px.

## Security posture (LAN-grade)
- Strict input validation (hostname, IP, port, record type).
- Per-query timeout (`QUERY_TIMEOUT_MS`, default 5000).
- In-memory per-IP rate limit (`RATE_LIMIT` requests/minute, default 60) → 429.
- Security headers on every response. **No authentication.**

## Layout
```
src/server.js     HTTP server: static files, /api/config, /api/query, rate limit
src/dns.js        Raw DNS query: UDP, TCP fallback, timeout, timing
src/validate.js   Input validation, server parsing, PTR name conversion
public/           index.html, app.css, app.js, favicon.svg (served as-is)
test/             node:test tests (mock DNS server for dns.js)
Dockerfile        Multi-stage, node:22-alpine, non-root, HEALTHCHECK
.github/workflows/docker-publish.yml   Multi-arch build + push
```

## API
- `GET /api/config` → `{ defaultServer, types, allTypes }`
- `GET /api/query?name=&type=&server=` → `{ server, transport, timeMs, rcode,
  flags, question, answers, authorities, additionals }`.
  `type=ALL` → `{ results: { A: {...}, ... } }`. Omit `server` for default.
  Errors → `{ error }` with 400 / 429 / 502 / 504.
- `GET /healthz` → `ok` (used by Docker HEALTHCHECK)

## Environment variables
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DEFAULT_DNS` | container resolver | Server used for "Default" |
| `QUERY_TIMEOUT_MS` | `5000` | Per-query timeout |
| `RATE_LIMIT` | `60` | Requests per minute per client IP (0 = off) |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IP (behind a reverse proxy) |

Note: on Windows dev machines `dns.getServers()` may return `127.0.0.1`; set
`DEFAULT_DNS` locally. Inside the Linux container this is not an issue.

## Commands
- `npm start` — run the server
- `npm test` — run tests (`node --test`)
- `docker build -t webdnschecker .` / `docker run -p 8080:8080 webdnschecker`
- `docker compose up -d --build` / `docker compose down` (`docker-compose.yml`;
  read-only filesystem, all capabilities dropped; the app must never write to disk)
- VS Code F5 → `.vscode/launch.json` builds and runs the container with
  `--inspect` and attaches the debugger; `.vscode/tasks.json` holds the tasks.

## Dev environment
The owner develops on Windows with Docker and Node in the **`Ubuntu` WSL
distro** (use `wsl -d Ubuntu -e …`). Do not use `Ubuntu-22.04`: its Docker CLI
(20.10) is too old for the daemon. Never kill all `node.exe` processes on
Windows; stop test servers by PID or port.

## License
GPL-3.0-or-later (`LICENSE`). New source files start with
`// SPDX-License-Identifier: GPL-3.0-or-later` (or `/* … */` in CSS). Dependencies
must be GPL-3.0-compatible.

## CI
`.github/workflows/ci.yml` runs on every push to `main` and on every pull request: tests, a Docker build, and
a container smoke test. It publishes nothing.

## Release
GitHub Actions (`.github/workflows/docker-publish.yml`) builds
`linux/amd64` + `linux/arm64` with buildx and pushes to Docker Hub on `v*` tags
(and manual dispatch). Requires repo secrets `DOCKERHUB_USERNAME`,
`DOCKERHUB_TOKEN`, and repo variable `DOCKERHUB_REPO` (e.g. `user/webdnschecker`).
