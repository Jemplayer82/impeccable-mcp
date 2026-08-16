<img src="assets/fathom-header-banner.svg" alt="Fathom Works — impeccable-mcp" width="100%">

# `$ impeccable-mcp`

**An MCP server wrapping [impeccable](https://github.com/pbakaus/impeccable)'s design-lint engine — headless Chrome plus 59 deterministic anti-pattern rules — so any agent can scan a URL and get back structured findings, no per-agent setup required.** No LLM, no API key needed for the scan itself; the engine is pure detection.

---

## `[ what it does ]`

- Takes `impeccable`'s public library exports (`detectUrl`, `detectHtml`, `ANTIPATTERNS`, `createBrowserDetector`) — an official npm dependency, not a fork — and exposes them as MCP tools
- Runs one long-lived headless Chromium instance, each scan in its own incognito context
- Serves MCP over streamable HTTP on port **8000**, same shape as [gsd-browser-mcp](https://github.com/Jemplayer82/gsd-browser-mcp)
- Lets any MCP client (Claude Code, Fred, Billy, whatever's next) scan a website's design without local setup

---

## `[ tools ]`

| Tool | Needs a browser | What it does |
|---|---|---|
| `scan_url` | yes | Loads a URL in headless Chrome, runs all detector rules, returns findings grouped by `slop` (AI design tells) vs `quality` (a11y/design issues). Accepts optional `headers` / `cookies` for authenticated pages. |
| `scan_html` | no | Runs the static detector against a raw HTML/CSS string. No browser launched — use this to check generated markup before it's written to disk. |
| `screenshot` | yes | Returns a PNG of the rendered page as MCP image content. |
| `list_rules` | no | Returns the full rule registry (id, name, category, description) from `impeccable`'s `ANTIPATTERNS`. |

> **Header/cookie values you pass to `scan_url` will appear in the calling agent's transcript.**
> That's a deliberate tradeoff for reaching authenticated pages, not an oversight — see
> `CONTRIBUTING.md`. Don't pass anything you wouldn't want logged.

### The private-target guard

`scan_url` and `screenshot` refuse RFC1918, loopback, and link-local targets by default. This
service's whole job is "fetch whatever URL an agent hands it" — without the guard, a
prompt-injected agent could turn it into a LAN port scanner or point it at Portainer/Home
Assistant from inside the trusted network. Set `IMPECCABLE_ALLOW_PRIVATE=1` only if you specifically
need to scan an internal site and understand the tradeoff.

---

## `[ quick start ]`

### 1. pull and run

```bash
$ docker run -d \
  -p 8000:8000 \
  --shm-size=512mb \
  -e IMPECCABLE_MCP_TOKEN=$(openssl rand -hex 32) \
  ghcr.io/jemplayer82/impeccable-mcp:latest
```

### 2. connect your mcp client

```
http://localhost:8000/mcp
```
with `Authorization: Bearer <IMPECCABLE_MCP_TOKEN>`.

---

## `[ docker compose ]`

```yaml
services:
  impeccable-mcp:
    image: ghcr.io/jemplayer82/impeccable-mcp:latest
    restart: unless-stopped
    shm_size: "512mb"
    mem_limit: 1536m
    init: true
    ports:
      - "8000:8000"
    environment:
      IMPECCABLE_MCP_TOKEN: your-token-here  # pragma: allowlist secret — doc placeholder
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8000/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

---

## `[ environment variables ]`

| Variable | Required | Description |
|---|---|---|
| `IMPECCABLE_MCP_TOKEN` | Yes | Bearer token clients must send. Server refuses to start if unset. |
| `PORT` | No | Listen port inside the container. Default `8000`. |
| `IMPECCABLE_ALLOW_PRIVATE` | No | Set to `1` to allow scans of RFC1918/loopback/link-local targets. Default off. |
| `MAX_CONCURRENCY` | No | Max concurrent browser-backed scans. Default `2`. |
| `BROWSER_IDLE_TIMEOUT_MS` | No | Close the idle browser after this long with no scans. Default `300000` (5 min). |

---

## `[ how it works ]`

A single Node/ESM process:

1. `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` over raw `node:http` — stateless,
   a fresh server + transport per request, no session bookkeeping.
2. `src/scan.mjs` holds one Chromium via `impeccable`'s `createBrowserDetector`, relaunching on
   crash and closing after `BROWSER_IDLE_TIMEOUT_MS` of inactivity. Each scan gets its own
   incognito browser context so headers/cookies from one call never leak into another.
3. Findings come back in `impeccable`'s stable shape (`antipattern`, `name`, `description`,
   `severity`, `category`, `snippet`), grouped by category with a count summary.

`impeccable` itself needs no LLM and no API key — it's a deterministic rule engine. This server
doesn't add one either; it's transport, auth, browser lifecycle, and a URL guard around a library.

---

## `[ related ]`

- [impeccable](https://github.com/pbakaus/impeccable) — the underlying detection engine (don't
  file issues/PRs there from this project; see `CONTRIBUTING.md`)
- [gsd-browser-mcp](https://github.com/Jemplayer82/gsd-browser-mcp) — the sibling MCP this repo's
  transport, auth, and Dockerfile pattern were cloned from
- [Impeccable Chrome extension](https://chromewebstore.google.com/detail/impeccable/bdkgmiklpdmaojlpflclinlofgjfpabf) — same rule engine, for a human looking at DevTools directly. This
  server exists for agents; the extension is still the right tool for eyeballing a page yourself.

---

## `[ license ]`

Apache License 2.0 — see `LICENSE`.

---

<img src="assets/fathom-footer-banner.svg" alt="Fathom Works — sound the depths before you set a course" width="100%">
