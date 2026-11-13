# Controllers, frontend and tests

## App structure

```
my-app/
  app.manifest.yaml
  api/            controllers in JavaScript (compiled if the app is in TypeScript)
  src/            TypeScript sources, optional
  web/            static frontend, with index.html
  assets/icon.svg
  smoke.yaml      tests, optional
```

`.git`, `node_modules` and `.env*` are never sent.

## Controllers

An ES module that exports a default function. It receives `ctx` and returns the response body (200), or throws `ctx.error(status, message)`.

```js
export default async function close(ctx) {
  const ticket = await ctx.db.table('ticket').get(ctx.params.id);
  if (!ticket) throw ctx.error(404, 'Ticket not found');
  return ctx.db.table('ticket').update(ticket.id, { status: 'done' });
}
```

| `ctx` | Content |
| --- | --- |
| `params`, `query`, `body` | Path parameters (`:id`), query parameters, JSON body |
| `user` | `sub`, `name`, `roles` of the person calling |
| `db.table(name)` | `list({ where, limit, offset })`, `get(id)`, `insert(row)`, `update(id, patch)`, `remove(id)` |
| `fetch` | Like `fetch`, limited to `permissions.network`, response read in full and capped at 5 MB |
| `log` | `info`, `warn`, `error`: visible in `archipel logs` |
| `error(status, message)` | Error to throw to answer anything other than 200 |

`db.table` only reaches the app's tables and those in `permissions`. `list` returns 100 rows by default, 500 at most.

The controller runs in a container without network, read-only, with 128 MB of memory by default. It has no `node_modules`: only import relative files of the app. The scan blocks `fs`, `child_process`, Node's network modules, `process.env`, `eval`, `new Function`, computed imports and `WebSocket`.

### In TypeScript

Add a `tsconfig.json`: `validate` and `deploy` then run `tsc --noEmit`, and a type error blocks the submission. `@archipel/sdk` gives the type of `ctx` and `archipel types` the type of the tables. The SDK only contains types: import it with `import type`, a real import is refused.

```ts
import type { Controller } from '@archipel/sdk';
import type { Tables } from '../app.types.js';

const close: Controller<Tables, { id: string }> = async (ctx) => {
  const ticket = await ctx.db.table('ticket').get(ctx.params.id);
  if (!ticket) throw ctx.error(404, 'Ticket not found');
  return ctx.db.table('ticket').update(ticket.id, { status: 'done' });
};

export default close;
```

The manifest points to the compiled JavaScript (`handler: ./api/close.js`): compile with `tsc` before deploying. If `@archipel/sdk` cannot be installed, write JavaScript directly: it is accepted the same way.

## App API

- CRUD of a `crud: true` table: `GET /data/<table>` (`limit`, `offset`, and a filter per column: `?status=open`), `POST /data/<table>`, `GET`, `PATCH` and `DELETE /data/<table>/<id>`. A shared table: `/data/shared.<name>`.
- Controllers: at the address declared in `controllers`.
- `archipel openapi <folder>` gives the full contract.

## Frontend

Static files under `frontend.dir`, served at `frontend.route` in the launchpad. Use relative paths (`./main.js`). Each HTML page gets `window.archipel`:

```js
archipel.user;      // { name, roles }
archipel.preview;   // true in the review preview
const tickets = await archipel.api('/data/ticket');
await archipel.api('/data/ticket', { method: 'POST', body: { title: 'Out of order' } });
await archipel.api(`/tickets/${id}/close`, { method: 'POST' });
```

`archipel.api` adds the token, sends `body` as JSON and throws an error with `status` if the response is not 2xx.

The frontend runs in an isolated origin:

- no `localStorage` and no cookies: keep the state in a table;
- a single HTML page, with client-side routing;
- any external domain (CDN, API, font) must be listed in `permissions.network`; prefer files included in the app;
- the token lasts one hour: beyond that, the page must be reloaded.

Follow the launchpad's visual direction: light glass, very rounded shapes, pill buttons, light theme.

## Tests

The pipeline always runs, on empty tables:

1. `health`, if declared;
2. for each `crud: true` table, as `admin`: list (200), creation of a row filled with its required columns (201), read (200), deletion (204), and a write as a plain `user` that must be refused (403) if `rbac.write` does not contain `user`;
3. the tests in `tests:`, in order.

```yaml
tests:
  - name: Create a ticket
    request: POST /data/ticket
    as: support            # role used, admin by default; user for a person without a role
    body: { title: Out of order }
    expect: { status: 201, body: { status: open } }   # body: expected subset
    save: { ticket: id }   # ${ticket} reusable in the next tests
  - name: Close the ticket
    request: POST /tickets/${ticket}/close
    expect: { status: 200, body: { status: done } }
```

Test at least each controller, a permission refusal and an error case (404, 400). A failing test blocks the version before review.
