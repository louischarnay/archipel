# The manifest: `app.manifest.yaml`

At the root of the app folder. Any unknown field is refused, and `archipel validate` explains each error.

```yaml
manifest: 1
id: tickets                  # ^[a-z][a-z0-9-]{1,39}$, never changes
name: Ticket management      # 80 characters at most
version: 1.0.0               # semver, increase it for each version that may go live
icon: ./assets/icon.svg      # optional
group: support               # optional: launchpad app group, no effect on permissions

frontend:                    # optional
  dir: ./web                 # folder of static files, with an index.html
  route: /tickets            # ^/[a-z0-9][a-z0-9-]*$, unique on the platform

roles:                       # optional: app role → identity provider groups
  support: [helpdesk]

tables:
  ticket:
    columns:
      id: { type: uuid, pk: true }
      title: { type: string, required: true }
      status: { type: enum, values: [open, done], default: open }
      customer_id: { type: ref, to: shared.customer }
    crud: true               # generated API under /data/ticket
    rbac:
      read: [user]
      write: [support]

controllers:
  - path: GET /tickets/health
    handler: ./api/health.js
  - path: POST /tickets/:id/close
    handler: ./api/close.js
    needs: [ticket.write]

permissions:
  reads: [shared.customer]   # shared tables read
  writes: []                 # shared tables written
  network: [api.example.com] # domains called by ctx.fetch and by the frontend

exposes:
  data: [ticket]             # tables flagged to administrators as exposed data
  mcp:                       # actions offered in the command palette
    - name: close_ticket
      description: Closes a ticket by its id
      calls: POST /tickets/:id/close
      input: { id: uuid }

health: /tickets/health      # must match a declared GET controller
tests: ./smoke.yaml          # optional, see code.md
```

An app declares at least a frontend, a table or a controller.

## Tables

- Exactly one `pk` column, of type `uuid`, `string` or `integer`. A `uuid` or `string` `pk` missing at creation gets a UUID; an `integer` `pk` must be provided. Prefer `uuid`.
- Types: `uuid`, `string`, `text`, `integer`, `number`, `boolean`, `date`, `datetime`, `json`, `enum` (with `values`), `ref` (with `to`).
- Table and column names: `^[a-z][a-z0-9_]*$`.
- `required: true` makes the column required at creation. For an `enum`, `default` must be listed in `values`.
- `ref` to a table of the app (`to: ticket`) or to a shared table (`to: shared.customer`), which must then be listed in `permissions.reads` or `permissions.writes`.
- Each app has its own tables: the `ticket` of `tickets` has nothing to do with a `ticket` in another app. Tables are stored as `app_<id>_<table>`, hyphens becoming underscores: a name that gives the same result as another app's table (`crm` + `data_customer` against `crm-data` + `customer`) is refused.

## Permissions

- Everyone signed in has the `user` role. Each identity provider group is worth a role of the same name, `roles:` adds some under another name, and the platform's administrator group is worth `admin`.
- `admin` passes every rule.
- `rbac.read` reads, `rbac.write` reads and writes. Without `rbac.read`, only `admin` reads the table.
- `needs: [ticket.write]` reserves a controller for people who have this permission on the table. A controller without `needs` is open to anyone signed in: check `ctx.user.roles` if the action is sensitive.
- There are no permissions at the app group level.

## Shared tables

- A `shared.<name>` table is declared under `tables` in the app that owns it, with the prefix. Only one app owns it.
- Another app reads it with `permissions.reads: [shared.<name>]`, or writes it with `permissions.writes`, and calls it `shared.<name>` everywhere: `ctx.db.table('shared.customer')`, `/data/shared.customer`.
- The owning app must be live before the first deployment of an app that reads its table: otherwise validation fails and says so.

## Network

An entry of `permissions.network` applies to `ctx.fetch` and to the frontend:

| Form | Allows |
| --- | --- |
| `api.example.com` | `https`, port 443, public address |
| `api.example.com:8443` | `https` on this port |
| `http://intranet.local:8080` | `http` and private addresses, flagged to the reviewer |

The loopback and metadata addresses stay refused.

A preview only reaches the rules already approved for the app: a new rule applies once a person approves the version. Keep `health` and `tests` independent of a host you are adding, or they fail before the review.

## What the reviewer sees

Each change of `permissions` or `exposes.data`, each destructive schema change and each scan finding is highlighted in the review. Keep these sections minimal, and explain any addition to the person.

## Reserved routes

The frontend cannot take `/api`, `/auth`, `/login`, `/setup`, `/run`, `/preview`, `/ui` or `/health`, nor a route already used by another app.
