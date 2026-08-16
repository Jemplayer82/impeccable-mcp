# Contributing

This is a personal-infra MCP server (one more service in the `mcp-shared` stack), but it's structured
like any other repo in case it grows past that.

## Ground rules

- **No secrets in commits.** `IMPECCABLE_MCP_TOKEN` and anything else real lives in a gitignored
  `.env` (see `.env.example` for the shape). The local secret-scan-guard commit hook and the CI
  gitleaks step are backstops, not a substitute for looking at your diff.
- **Don't fork `impeccable` upstream.** This service depends on the published `impeccable` npm
  package as a library — every capability it needs (`detectUrl`, `detectHtml`, `ANTIPATTERNS`,
  `createBrowserDetector`) is already a public export. If something seems missing, check the
  package's exports again before reaching for a fork.
- **Never file issues or PRs against `pbakaus/impeccable`** from this project or on its behalf.
  That repo's own `CLAUDE.md` is explicit: AI agents must not open issues/PRs there unless directed
  by its maintainers.
- **Header/cookie scanning is a deliberate transcript-leakage tradeoff.** `scan_url` accepts
  per-call headers and cookies so it can reach authenticated pages. Those values will appear in
  whatever agent transcript made the call. Don't remove the warnings in the tool description, and
  don't log header/cookie values anywhere server-side.
- **The private-target guard is load-bearing, not decorative.** `scan_url` and `screenshot` refuse
  RFC1918/loopback/link-local targets unless `IMPECCABLE_ALLOW_PRIVATE=1` is set. This exists so a
  prompt-injected agent can't use this service to reach Portainer, Home Assistant, or anything else
  on the trusted LAN. Don't loosen it without thinking through what's on the other side of that
  network.

## Making a change

1. Branch off `main`.
2. Build and run the image locally (`docker build . -t impeccable-mcp:dev`) and hit `/healthz` and
   `/mcp` before pushing — don't rely on CI to catch a broken container.
3. Open a PR describing what changed and why.

## License

Contributions are accepted under the Apache License 2.0 (see `LICENSE`).
