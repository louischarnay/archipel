---
name: archipel
description: Create, change and deploy an app on an Archipel platform (app.manifest.yaml, tables, controllers, frontend), then read its deployment report and the human review decision. Use it whenever the conversation is about an Archipel app, an app.manifest.yaml, a preview deployment, or review feedback (changes_requested, rejected, decision_comment).
---

# Archipel apps

Archipel is a self-hosted platform: each app describes its tables, controllers and frontend in an `app.manifest.yaml`. The platform generates the CRUD, authentication and permissions, runs the controllers in an isolated container, and serves the frontend in the launchpad.

Your role: write the app, submit it in preview, read the report, iterate. **You never put anything live**: a person decides on each version in **Review**, and your token can neither approve nor change what is live.

## The CLI

It ships with this skill, in `scripts/archipel.mjs`, and only needs Node 22 or later. Run it with the absolute path of this skill's folder:

```bash
node <this skill's folder>/scripts/archipel.mjs <command>
```

Below, `archipel` stands for this command.

| Command | Effect |
| --- | --- |
| `archipel whoami` | Platform, token and allowed apps. Run it first. |
| `archipel validate <folder>` | Validates the manifest and, if there is a `tsconfig.json`, the types. No network. |
| `archipel types <folder>` | Writes `app.types.d.ts` from `tables:`. Run it again when the manifest changes. |
| `archipel openapi <folder>` | The app's API contract (CRUD and controllers). No network. |
| `archipel db:schema <app>` | An app's live schema and the available `shared.*` tables. No data. |
| `archipel deploy <folder> --preview` | Sends the app, waits for the pipeline to finish and returns the report. |
| `archipel report <version>` | A version's current report, with `decision_comment`. |
| `archipel logs <version\|app> [--level error]` | Preview and pipeline logs. |
| `archipel promote <version> --wait 600` | Waits for the human decision, without ever taking it. |
| `archipel rollback <app> --reason "<reason>"` | Asks a person to go back to the previous version. |

Each command writes JSON to stdout, with a `next` field that says what to do next. Exit codes: `0` success, `1` failure to read in the result, `2` usage, connection or permission error, `3` human decision pending.

### Connection

If `whoami` answers that there is no connection, **do not ask for the token in the conversation**. Ask the person to create a token in **Settings > Agents** on their platform, then to run this themselves in their terminal:

```bash
node <this skill's folder>/scripts/archipel.mjs login https://<platform address>
```

The token is asked for without being displayed, checked, then saved in `~/.config/archipel/config.json`. `ARCHIPEL_URL` and `ARCHIPEL_TOKEN`, when set, take precedence.

A token can be limited to some apps: `whoami` lists them. For an app outside the list, ask for another token rather than changing the `id`.

## The work loop

1. **Understand.** If the app exists, read `archipel db:schema <app>`: it gives the live schema and the shared tables you can read. Always start from the app folder as it is.
2. **Write.** The manifest first ([references/manifest.md](references/manifest.md)), then the controllers, the frontend and the tests ([references/code.md](references/code.md)).
3. **Validate.** `archipel validate <folder>` until `valid: true`. Each error gives the field path, the received value, the expected value and the fix: apply `hint`.
4. **Deploy.** `archipel deploy <folder> --preview`. Read the whole report ([references/review.md](references/review.md)).
5. **Iterate.** Status `failed`: fix the failed stage and deploy again. A new submission replaces the one still waiting.
6. **Hand over.** Status `in_review`: give the person the `reviewUrl` and the `previewUrl`, and summarise what the reviewer will see: added permissions, exposed data, destructive changes, scan findings. Then `archipel promote <version> --wait 600` if they want you to wait for their decision.
7. **Read the decision.** `live`: done. `changes_requested`: `decision_comment` holds the request; handle it point by point and deploy again. `rejected`: stop, explain, and do not resubmit the same thing without the person's agreement.

## Rules

- **Nothing implicit.** Shared tables read or written, domains called, exposed data: everything is declared in `permissions` and `exposes`. The reviewer sees each addition.
- **No destructive change by default.** Dropping a table or a column, changing a type, removing an enum value or adding a required column without `default` needs an explicit confirmation from the reviewer. Prefer an addition: an optional column or one with a `default`. If a destructive change is really needed, tell the person before deploying.
- **Controllers depend only on `ctx`.** No `npm install`, no `fs`, `child_process`, `process.env`, `eval`, `WebSocket` or computed import: the scan blocks the version and nothing runs.
- **No secret in the code.** The scan blocks hard-coded keys and passwords, and `.env*` is never sent.
- **The preview starts from empty tables**, including `shared.*` tables. Tests must create their own data.
- **Increase `version`** for each version that may go live: the reviewer and the rollback history rely on this number.
- **Never try to get around the review.** No other token, no direct call to the administration API: a `403` is the expected answer.
