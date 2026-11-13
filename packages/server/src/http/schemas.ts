import { Type, type TProperties, type TSchema } from 'typebox';

// Shapes accepted and returned by the API: any unexpected field is refused before reaching a route.
const APP_ID = '^[a-z][a-z0-9-]{1,39}$';
const RELEASE_ID = '^rel[0-9a-f]{12}$';
const TOKEN_ID = '^agt[0-9a-f]{12}$';
const MAX_FIELD = 200;
const MAX_COMMENT = 2000;

const text = (maxLength = MAX_FIELD) => Type.String({ maxLength });
const opt = <T extends TSchema>(schema: T) => Type.Optional(schema);
// `Type.Union` would produce an `anyOf`: a single type with null gives better errors and simpler serialisation.
const nullable = (maxLength?: number) =>
  Type.Unsafe<string | null>({ type: ['string', 'null'], ...(maxLength ? { maxLength } : {}) });
const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const idParam = (pattern: string) => ({ params: object({ id: Type.String({ pattern }) }) });
const releaseId = Type.String({ pattern: RELEASE_ID });

export const appParam = idParam(APP_ID);
export const releaseParam = idParam(RELEASE_ID);
export const tokenParam = idParam(TOKEN_ID);
export const sessionParam = idParam('^ses[0-9a-f]{24}$');
export const alertParam = idParam('^[0-9]{1,18}$');
export const draftParam = idParam('^[0-9a-f]{32}$');
export const linkParam = idParam('^lnk[0-9a-f]{12}$');
export const commandParams = {
  params: object({ app: Type.String({ pattern: APP_ID }), tool: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }) }),
};

export const rollbackBody = { body: object({ releaseId: opt(releaseId) }) };
export const rollbackRequestBody = { body: object({ releaseId: opt(releaseId), reason: opt(nullable(MAX_COMMENT)) }) };
export const groupBody = { body: object({ name: opt(text(100)) }) };
export const gitBody = { body: object({ url: opt(text(2000)), ref: opt(nullable(MAX_FIELD)) }) };
export const linkBody = { body: object({ name: text(), url: text(2000), group: opt(nullable(40)) }) };
export const approveBody = { body: object({ comment: opt(nullable(MAX_COMMENT)), allowDestructive: opt(Type.Boolean()) }) };
export const declineBody = { body: object({ comment: opt(nullable(MAX_COMMENT)) }) };
const appList = Type.Array(Type.String({ pattern: APP_ID }), { maxItems: 100, uniqueItems: true });
export const tokenBody = { body: object({ name: opt(text()), days: opt(Type.Number()), apps: opt(appList) }) };
export const fileQuery = { querystring: object({ path: opt(text(1000)) }) };
export const releasesQuery = { querystring: object({ view: opt(Type.String({ maxLength: 20 })), app: opt(text(40)) }) };
export const commandBody = { body: object({ input: opt(Type.Unknown()) }) };

export const unlockBody = { body: object({ code: opt(text(40)) }) };
export const identityTestBody = {
  body: object({
    issuer: opt(nullable(MAX_FIELD)),
    clientId: opt(nullable(MAX_FIELD)),
    clientSecret: opt(nullable(MAX_FIELD)),
    scopes: opt(nullable(MAX_FIELD)),
    groupsClaim: opt(nullable(MAX_FIELD)),
    adminGroup: opt(nullable(MAX_FIELD)),
    providerName: opt(nullable(MAX_FIELD)),
    publicUrl: opt(nullable(MAX_FIELD)),
  }),
};
const database = object({ client: opt(Type.String({ maxLength: 40 })), url: opt(nullable(1000)) });
export const databaseBody = { body: database };
export const settingsBody = {
  body: object({
    launchpad: opt(Type.Unsafe<Record<string, unknown>>({ type: 'object' })),
    identity: opt(object({ testId: opt(text(64)) })),
    database: opt(database),
    completeSetup: opt(Type.Boolean()),
  }),
};

// Responses. `additionalProperties` lets through `issues` and `reauth_required`, set by the error handler.
export const errorBody = Type.Object({ error: Type.String() }, { additionalProperties: true });
export const refused = { 400: errorBody, 401: errorBody, 403: errorBody };
export const okBody = object({ ok: Type.Boolean() });

const user = object({
  sub: Type.String(),
  name: Type.String(),
  email: nullable(),
  groups: Type.Array(Type.String()),
  admin: Type.Boolean(),
});

export const meBody = object({
  user,
  authMode: Type.String(),
  isolated: Type.Boolean(),
  branding: object({
    name: Type.String(),
    title: Type.String(),
    welcome: Type.String(),
    loginMessage: Type.String(),
    accent: Type.String(),
    background: Type.String(),
    showGroups: Type.Boolean(),
    openMode: Type.String(),
    hasLogo: Type.Boolean(),
  }),
});

export const link = object({
  id: Type.String(),
  name: Type.String(),
  url: Type.String(),
  group: nullable(),
  hasIcon: Type.Boolean(),
});

export const launchpadBody = object({
  apps: Type.Array(
    object({
      id: Type.String(),
      name: Type.String(),
      group: nullable(),
      route: Type.String(),
      version: Type.String(),
      hasIcon: Type.Boolean(),
    }),
  ),
  links: Type.Array(link),
  groups: Type.Array(object({ id: Type.String(), name: Type.String() })),
});

export const sessionsBody = object({
  sessions: Type.Array(
    object({
      id: Type.String(),
      name: Type.String(),
      email: nullable(),
      admin: Type.Boolean(),
      ip: nullable(),
      user_agent: nullable(),
      created_at: Type.String(),
      last_seen_at: Type.String(),
      current: Type.Boolean(),
    }),
  ),
});

const tokenApps = Type.Unsafe<string[] | null>({ type: ['array', 'null'], items: { type: 'string' } });

export const tokensBody = object({
  tokens: Type.Array(
    object({
      id: Type.String(),
      name: Type.String(),
      apps: tokenApps,
      created_at: Type.String(),
      expires_at: Type.String(),
      revoked_at: nullable(),
      last_used_at: nullable(),
    }),
  ),
});

export const issuedTokenBody = object({
  id: Type.String(),
  name: Type.String(),
  token: Type.String(),
  expires_at: Type.String(),
  apps: tokenApps,
});

export const agentIdentityBody = object({ id: Type.String(), name: Type.String(), apps: tokenApps });

const count = Type.Number();
const nullableCount = Type.Unsafe<number | null>({ type: ['number', 'null'] });
// Free-form shapes: the manifest and the report have their own contracts, the published JSON Schema and the pipeline report.
const free = Type.Unknown();
const dictionary = Type.Unsafe<Record<string, unknown>>({ type: 'object', additionalProperties: true });

export const createdBody = object({ id: Type.String() });
export const dictionaryBody = dictionary;

const releaseSummaryFields = {
  id: Type.String(),
  app_id: nullable(),
  name: Type.String(),
  version: nullable(),
  status: Type.String(),
  stage: nullable(),
  source_type: Type.String(),
  source_label: Type.String(),
  submitted_by: Type.String(),
  created_at: Type.String(),
  decided_at: nullable(),
  decided_by: nullable(),
  decision_comment: nullable(),
  summary: nullable(),
  flags: object({
    permissions: Type.Boolean(),
    exposure: Type.Boolean(),
    destructive: Type.Boolean(),
    findings: count,
  }),
};

export const releaseSummaryBody = object(releaseSummaryFields);
export const releasesBody = object({ releases: Type.Array(releaseSummaryBody) });
export const rollbackRequestedBody = object({ target: releaseSummaryBody });
export const rolledBackBody = object({ restored: Type.Array(free) });
export const countsBody = Type.Record(Type.String(), count);

const logEntry = object({
  id: count,
  release_id: Type.String(),
  level: Type.String(),
  message: Type.String(),
  at: Type.String(),
});

export const releaseBody = object({
  ...releaseSummaryFields,
  manifest: free,
  report: free,
  previewUrl: nullable(),
  logs: Type.Array(logEntry),
});

export const releaseFileBody = object({
  binary: opt(Type.Boolean()),
  tooLarge: opt(Type.Boolean()),
  content: opt(Type.String()),
});

const auditEntry = object({
  id: count,
  at: Type.String(),
  actor: Type.String(),
  action: Type.String(),
  app_id: nullable(),
  release_id: nullable(),
  detail: free,
  hash: nullable(),
  actor_type: nullable(),
  actor_id: nullable(),
  ip: nullable(),
  request_id: nullable(),
});

const group = object({ id: Type.String(), name: Type.String() });

export const appsBody = object({
  groups: Type.Array(group),
  apps: Type.Array(
    object({
      id: Type.String(),
      name: Type.String(),
      status: Type.String(),
      group: nullable(),
      groupName: nullable(),
      version: nullable(),
      route: nullable(),
      hasIcon: Type.Boolean(),
      inReview: count,
      blocked: Type.Boolean(),
      updated_at: Type.String(),
    }),
  ),
});

export const appBody = object({
  app: object({
    id: Type.String(),
    name: Type.String(),
    group_id: nullable(),
    status: Type.String(),
    live_release_id: nullable(),
    created_at: Type.String(),
  }),
  manifest: free,
  releases: Type.Array(releaseSummaryBody),
  logs: Type.Array(logEntry),
  audit: Type.Array(auditEntry),
});

export const appSchemaBody = object({
  id: Type.String(),
  status: nullable(),
  version: nullable(),
  tables: dictionary,
  shared: dictionary,
});

const alert = object({
  id: count,
  at: Type.String(),
  app_id: Type.String(),
  release_id: nullable(),
  message: Type.String(),
  kind: nullable(),
  acknowledged_at: nullable(),
  acknowledged_by: nullable(),
});

export const activityBody = object({
  events: Type.Array(
    object({
      type: Type.String(),
      at: Type.String(),
      agent: Type.String(),
      release: opt(releaseSummaryBody),
      app: opt(object({ id: nullable(), name: nullable() })),
      version: opt(nullable()),
      reason: opt(nullable()),
    }),
  ),
  alerts: Type.Array(alert),
});

const appRef = { id: Type.String(), name: Type.String() };

export const tablesBody = object({
  apps: Type.Array(
    object({
      ...appRef,
      status: Type.String(),
      version: nullable(),
      hasIcon: Type.Boolean(),
      tables: Type.Array(
        object({
          name: Type.String(),
          physical: Type.String(),
          shared: Type.Boolean(),
          access: Type.String(),
          owner: Type.Unsafe<{ id: string; name: string } | null>({
            type: ['object', 'null'],
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          }),
          consumers: Type.Array(object({ ...appRef, access: Type.String() })),
          exposed: Type.Boolean(),
          crud: Type.Boolean(),
          rbac: object({ read: Type.Array(Type.String()), write: Type.Array(Type.String()) }),
          rows: nullableCount,
          columns: Type.Array(
            object({
              name: Type.String(),
              type: Type.String(),
              pk: Type.Boolean(),
              required: Type.Boolean(),
              to: nullable(),
            }),
          ),
        }),
      ),
      mcp: Type.Array(Type.String()),
      network: Type.Array(Type.String()),
    }),
  ),
});

export const commandsBody = object({
  commands: Type.Array(
    object({
      app: object(appRef),
      name: Type.String(),
      description: Type.String(),
      fields: Type.Array(object({ name: Type.String(), type: Type.String() })),
    }),
  ),
});

export const commandResultBody = object({ status: count, result: free });

export const setupStateBody = object({ required: Type.Boolean(), unlocked: Type.Boolean() });

export const settingsStateBody = object({
  mode: Type.String(),
  launchpad: object({
    name: Type.String(),
    title: Type.String(),
    welcome: Type.String(),
    loginMessage: Type.String(),
    accent: Type.String(),
    background: Type.String(),
    showGroups: Type.Boolean(),
    openMode: Type.String(),
    hasLogo: Type.Boolean(),
  }),
  identity: object({
    locked: Type.Boolean(),
    configured: Type.Boolean(),
    issuer: Type.String(),
    clientId: Type.String(),
    hasClientSecret: Type.Boolean(),
    scopes: Type.String(),
    groupsClaim: Type.String(),
    adminGroup: Type.String(),
    providerName: Type.String(),
    publicUrl: Type.String(),
    publicUrlLocked: Type.Boolean(),
  }),
  database: object({
    locked: Type.Boolean(),
    client: Type.String(),
    label: Type.String(),
    supported: Type.Boolean(),
    apps: count,
    tokens: count,
  }),
  setup: object({ completedAt: nullable() }),
});

export const identityTestedBody = object({
  ok: Type.Boolean(),
  error: opt(Type.String()),
  id: opt(Type.String()),
  loginUrl: opt(Type.String()),
});

export const identityResultBody = object({
  status: Type.String(),
  error: opt(Type.String()),
  user: opt(object({ name: Type.String(), email: nullable(), groups: Type.Array(Type.String()) })),
  adminGroup: opt(Type.String()),
});

export const databaseTestedBody = object({
  ok: Type.Boolean(),
  version: opt(Type.String()),
  apps: opt(nullableCount),
  error: opt(Type.String()),
});

export const settingsSavedBody = object({ ok: Type.Boolean(), restart: nullable() });
