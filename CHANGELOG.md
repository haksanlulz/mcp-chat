# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Not yet released (`package.json` is at 0.1.0). Changes before 2026-11-27 are in the git history.

### Added

- The runtime serves the built page itself (`npm run build:web`, then the runtime's own address): a fresh nonce CSP per load with `strict-dynamic`, Trusted Types with no policy allowed, and assets confined to `dist/web/assets`.
- The Vite dev page gets the same CSP with one nonce per dev-server start; Trusted Types is report-only there.

### Changed

- Every runtime response carries the security headers, and a `same-site` request is refused.
- The page meets WCAG 2.2 AAA contrast in both themes, has a level-one heading, and the message box is a named form landmark.

### Fixed

- `vite preview` no longer gets the dev CSP, which blocked every script on the built page.
