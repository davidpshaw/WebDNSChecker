# WebDNSChecker

[![CI](https://github.com/davidpshaw/WebDNSChecker/actions/workflows/ci.yml/badge.svg)](https://github.com/davidpshaw/WebDNSChecker/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A small self-hosted web app for DNS lookups, a browser-friendly `nslookup` / `dig`.
It works on phones and desktops, has no CDN or external assets, and needs only one runtime dependency.

- Query A, AAAA, CNAME, MX, NS, TXT, SOA, CAA, PTR, SRV, NAPTR, DS, DNSKEY, TLSA, HINFO, or **all common types** at once
- Use the container's **default resolver** or a **custom DNS server** (IPv4/IPv6, optional port). The last 5 custom servers are remembered in a cookie.
- **Summary** view (default) or **Dig** view (header, flags, all sections, query time)
- UDP with automatic TCP fallback when a response is truncated
- Reverse lookups: pick PTR and enter an IP address
- Shareable links: `/?name=example.com&type=MX&server=1.1.1.1&view=dig`
- Light/dark theme follows the OS, with a manual toggle

## Run with Docker

```sh
docker run -d --name dnschecker -p 8080:8080 davidshawcodes/webdnschecker
```

Then open http://localhost:8080.

"Default" uses the container's resolver. To point it somewhere specific, either:

```sh
docker run -d -p 8080:8080 --dns 192.168.1.1 davidshawcodes/webdnschecker
# or
docker run -d -p 8080:8080 -e DEFAULT_DNS=192.168.1.1 davidshawcodes/webdnschecker
```

### docker compose

The repo includes [docker-compose.yml](docker-compose.yml). It builds from source and runs with a read-only
filesystem and all Linux capabilities dropped:

```sh
docker compose up -d --build
DEFAULT_DNS=192.168.1.1 HOST_PORT=8090 docker compose up -d   # optional overrides
```

To use the published image instead, a minimal setup is:

```yaml
services:
  dnschecker:
    image: davidshawcodes/webdnschecker:latest
    ports: ["8080:8080"]
    environment:
      DEFAULT_DNS: 192.168.1.1   # optional
    restart: unless-stopped
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DEFAULT_DNS` | container resolver | Server used for "Default" (`ip` or `ip:port`) |
| `QUERY_TIMEOUT_MS` | `5000` | Per-query timeout |
| `RATE_LIMIT` | `60` | Queries per minute per client IP (`0` disables) |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for the client IP (set when behind a reverse proxy) |

## API

- `GET /api/config` returns `{ defaultServer, types, allTypes }`
- `GET /api/query?name=example.com&type=A[&server=1.1.1.1]` returns `{ server, rcode, flags, answers, authorities, additionals, transport, timeMs, … }`
- `type=ALL` returns `{ results: { A: {…}, AAAA: {…}, … } }`
- `GET /healthz` returns `ok`

## Development

```sh
npm install
npm start      # http://localhost:8080
npm test
```

**VS Code:** press F5 ("Docker: build, run & debug") to build the image, run it as `webdnschecker-dev` on
http://localhost:8080 and attach the debugger (port 9229). Stopping the debugger removes the container.
The tasks in `.vscode/tasks.json` run Docker in the `Ubuntu` WSL distro. Edit the `-d Ubuntu` arguments if
yours is named differently.

On Windows, Node's resolver may report `127.0.0.1` as the system DNS server. If
"Default" lookups time out, run with `DEFAULT_DNS=<your router or DNS IP>`.

## Publishing (GitHub Actions)

`.github/workflows/docker-publish.yml` runs the tests and then builds `linux/amd64` + `linux/arm64`
images. It pushes them to Docker Hub whenever a `v*` tag is pushed (it can also be run manually).

Set up the repository:
- Secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token)
- Variable: `DOCKERHUB_REPO` = `davidshawcodes/webdnschecker` (already set)

Release:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request. It runs the tests, builds the
Docker image, and smoke-tests the running container (health check, page load, and a live query). It
publishes nothing. Images are published only by `docker-publish.yml` when a `v*` tag is pushed.

## Security

This app is designed for a trusted LAN. It has input validation, timeouts and a per-IP rate limit, but **no
authentication**. If you expose it to the internet, put it behind an authenticating reverse proxy.

## License

Copyright (C) 2026 David Shaw

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
[LICENSE](LICENSE) file for details.
