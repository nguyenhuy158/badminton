# Repository Guidelines

## Project Structure & Module Organization

`badminton.huyab.cfd`: one Cloudflare Worker for everything about badminton, behind
the shared SSO. It serves the fund and session tracker (static page in `public/`,
group data from Workers KV)
and is the first spoke of the cron hub. The court availability page and API that
used to live at `caulong.huyab.cfd` (scanner `alobo` on the Pipi VPS) are being moved
here.

```text
src/
  index.ts                 # Worker: /api/version and /api/health (public), SSO gate, /data/<name>.json from KV, then static assets
  index.test.ts            #   Worker routes
  build-info.ts            #   BuildInfo type; build-info.generated.ts is written by scripts/build-info.mjs
  alobo/
    rules.ts               #   Which free court intervals count as a booking (pure)
    scan.ts                #   Scan one venue through an injected Alobo API, build the area document
    client.ts              #   Alobo bundle key derivation, request signature, AES response decoding
    *.test.ts              #   Unit tests + cases recorded from the Python watcher
    *.fixtures.json        #   Output of the Python `rules.py` / `watch.py`, the reference
public/                    # Static page (no data: the group data is private, in KV)
scripts/build-info.mjs     # Bakes the commit into the bundle before check, test, build, deploy
wrangler.jsonc             # Worker config: custom domain, SSO_ISSUER
```

## Ecosystem

See the [huyab.cfd ecosystem map](https://github.com/nguyenhuy158/kit/blob/main/docs/ECOSYSTEM.md) for how all personal repos connect.

- Kit packages: `@huyab/sso` (`getClaimsFromRequest`, `ssoUrl`), `@huyab/config`
  (Biome + tsconfig base), reusable CI `check.yml`. Planned: `@huyab/cron`
  (`handleTick`, section 4.5 of the ecosystem map).
- Talks to: sso (login redirect and JWKS). Planned: the cron hub (ticks), the Alobo
  API (court scan), Telegram Bot API (weekly summary).

## Build, Test, and Development Commands

- `pnpm install`: install dependencies.
- `pnpm dev`: run the Worker locally with `wrangler dev`.
- `pnpm check`: `tsc --noEmit`.
- `pnpm lint` / `pnpm format`: Biome check / format.
- `pnpm test`: Vitest, colocated `*.test.ts`.
- `pnpm build`: `wrangler deploy --dry-run`, catches bundling errors.
- `pnpm deploy`: `wrangler deploy` (manual only; normal deploys come from Workers Builds).

Use `pnpm`, never `npm`.

## Coding Style & Naming Conventions

TypeScript, strict. Two-space indentation, double quotes (Biome). Named exports,
`import type`, kebab-case file names. Name magic numbers as constants near their
module. Keep `src/alobo/rules.ts` pure: no `fetch`, no `Date.now()`; the caller
passes `now`.

## Testing Guidelines

Test observable behavior. `rules.fixtures.json` holds 1,386 cases produced by
running the original Python `rules.py` (`infra-hosts/alobo`); `rules.test.ts`
replays them, so the TypeScript port must return the same windows. Regenerate the
file only from the Python reference, never by hand.

## Commit & Pull Request Guidelines

Conventional Commits with an emoji and a scope, for example
`✨ feat(alobo): port the court scan`. Pull requests: short summary, check/test
results, linked issue if any, screenshots for visible UI changes.

## Deploy & CI

Pushing to `main` deploys through Cloudflare Workers Builds. CI calls kit's
`check.yml`. Secrets (Alobo tokens, Telegram bot token, hub key) are set with
`wrangler secret put`, never committed.

## Architecture Decisions & Pitfalls

- **This repo is public, so it holds no personal data.** The group documents (names,
  who paid what, fund balance) live in the Workers KV namespace bound as `DATA`, key
  `data:<name>` (for example `data:hem-long-thu`). The Worker serves them at
  `/data/<name>.json` only after the SSO check, with `cache-control: private, no-store`,
  and only for names matching `[a-z0-9-]+`. Never commit a `public/data/` folder, real
  names, amounts or account numbers, not even in fixtures or tests. Change data with
  `wrangler kv key put --binding DATA "data:<name>" --path <file>`.
- The namespace is `badminton-data`; its id is in `wrangler.jsonc` (ids are not secrets).

- **Free plan limits shape the scan.** A Worker invocation gets 50 subrequests and
  10 ms CPU. One venue costs about 9 Alobo calls, so one invocation scans exactly
  one venue; the 15 venues are staggered over the minutes of a 15-minute cycle.
- **Never derive keys inside the Worker.** `deriveKeys` runs regexes over the
  10.8 MB `main.dart.js` and took about 1.4 s of CPU, 100x the free limit. Derive
  `{ responseKey, signatureKey }` outside (script or CI), store them, and let the
  Worker only call `sign` and `decodeResponse` (WebCrypto, cheap). When Alobo ships
  a new bundle, decoding fails closed and the keys must be derived again.
- **Rules and scan must match the Python watcher** until it is switched off.

## Agent-Specific Instructions

Keep responses short and focused. If a requirement is unclear, ask before making
assumptions. Design UI/UX to fit inside a single viewport by default; UI primitives
come only from [ui-kit](https://github.com/nguyenhuy158/ui-kit) (copy them here, do
not hand-roll). Do not point `caulong.huyab.cfd` at this Worker or switch off the
Pipi timers until the migration is verified.
