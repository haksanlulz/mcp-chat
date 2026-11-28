# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Not yet released (`package.json` is at 0.1.0). Changes before 2026-11-27 are in the git history.

### Added

- The model provider's address is checked at startup against an allowlist (`server/egress.ts`): known hosted providers over https, local and tailnet servers over http, more hosts through `MCP_CHAT_PROVIDER_HOSTS`.
- The runtime serves the built page itself (`npm run build:web`, then the runtime's own address): a fresh nonce CSP per load with `strict-dynamic`, Trusted Types with no policy allowed, and assets confined to `dist/web/assets`.
- The Vite dev page gets the same CSP with one nonce per dev-server start; Trusted Types is report-only there.
- `npm start` reads the model keys from a secret store (`MCP_CHAT_SECRET_GET`) and strips secret-named variables from the shell's environment before starting the runtime.
- Security events on stderr, one JSON line each: refused requests, rejected bodies, refused tool calls and unexpected errors.
- The runtime answers as `mcp-chat.localhost`, a site of its own, and prints that address at start.
- `GAUNTLET.md` §7 tags ASVS 5.0.0 levels 1 and 2 for V1, V3, V13, V14 and V16; §8 lists the data the runtime holds and every log it writes.

### Changed

- Every runtime response carries the security headers, and a `same-site` request is refused.
- API responses and the chat stream are `Cache-Control: no-store` (the stream was `no-cache`).
- A failed MCP server's error text is escaped in its status line, so it cannot write a second log line.
- The page meets WCAG 2.2 AAA contrast in both themes, has a level-one heading, and the message box is a named form landmark.

### Fixed

- `vite preview` no longer gets the dev CSP, which blocked every script on the built page.
