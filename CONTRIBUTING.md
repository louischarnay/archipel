# Contributing

Thank you for helping. Issues and pull requests are welcome; for a large change, open an issue first so that the approach can be discussed before the code.

Never report a vulnerability in a public issue: see [SECURITY.md](SECURITY.md).

## Setting up

Node 22 or later. Docker or Podman is only needed for the container tests.

```bash
npm install
npm run build
npm run dev
```

## Before opening a pull request

```bash
npm run build
```

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run format:check
```

```bash
npm test
```

Bump the version once per pull request, `minor` for a feature and `patch` for a fix; CI refuses a pull request that keeps the version of `main`. A `major` bump is left to the maintainers.

```bash
npm run version:bump -- minor
```

`npm test` runs vitest on the packages, then the integration suite in `test/` on SQLite. CI also replays it on PostgreSQL (`ARCHIPEL_TEST_PG`) and in a container (`ARCHIPEL_TEST_CONTAINER=1`); see [README.md](README.md#tests).

`npm run dev` builds the interface once, then starts the server. To rebuild the interface on each change, run `npm run dev:web` in another terminal and reload the page.

## Code layout

Everything is TypeScript. An npm workspace per package:

| Package | What it holds |
| --- | --- |
| `packages/server` | The host: NestJS on Fastify. |
| `packages/web` | The launchpad interface: React, built by Vite into `packages/web/dist`, served by the host under `/ui/`. |
| `packages/manifest-schema` | The manifest format, its validation, generated types and OpenAPI. Shared by the server and the CLI. |
| `packages/cli` | The agent's CLI and MCP server, plus the Claude Code skill. |
| `packages/sdk` | Types only, for app controllers. |

`packages/server/src` has one folder per domain. Each holds a NestJS module, its controllers (`*.controller.ts`) and its services:

- `auth`: OIDC, sessions, agent tokens, and the access guard. A route states who may call it with `@SignedIn()`, `@AdminOnly()`, `@AdminOrAgent()`, `@AgentOnly()` or `@AdminWithRecentSignIn()`.
- `pipeline`: from a submitted archive to a reviewed version (validate, scan, preview, smoke tests, migrations).
- `runtime`: what runs live (generated CRUD, controllers in their container, `/run/*`).
- `releases`, `apps`, `links`, `commands`, `settings`, `account`: the `/api/*` routes behind each page.
- `shell`: the launchpad pages and the app frontends.
- `config`, `database`, `http`: shared building blocks.

`platform.ts` puts it together: one Fastify instance, the plugins that apply to every route, then the NestJS application. `main.ts` starts it.

`packages/web/src` follows the screens: `pages/` (one file per route), `shell/` (sidebar, palette, activity prompt), `release/`, `settings/` and `setup/` for the larger screens, `components/` for shared pieces, and `api/` for the typed client.

`packages/server/runner/runner.mjs` stays JavaScript: it runs as is in the app containers, with no build and no dependency.

## Conventions

- **English everywhere**: interface, API and CLI messages, documentation, comments and tests.
- **Plain wording**: "app" and "app group". The island motif stays visual, never in the words.
- **API routes are described with TypeBox**: each controller method declares its body, parameters and responses with `@RouteSchema`. A field missing from the response schema is removed at serialisation.
- **No destructive migration** without an explicit flag and a human confirmation.
- **Sober by default**: no new resident container or service without a documented reason.
- **Security first**: app code runs in its container, never in the host. A change that weakens a boundary described in [SECURITY.md](SECURITY.md) must say so in the pull request.
- Each change comes with its tests.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
