# userData Store + Variable Interpolation — Design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)
**Repos touched:** `testomniac_types`, `testomniac_api`, `testomniac_runner_service`, `testomniac_runner`, `testomniac_extension`

## Problem

Login credentials are stored two ways today — `entityCredentials` (entity-scoped, what the
extension UI saves) and per-run `testCredentials` — both as plaintext columns. Worse, the
server-side login generator (`testomniac_api/src/generators/login.ts:181–192`) writes the
**real plaintext password** directly into the "correct login" step `value`, which is persisted
as `stepsJson` in `test_interactions`. So secrets leak into stored test data.

Separately, there is no general place to store per-environment data for scans beyond
credentials, and no way for interaction steps to reference such data.

## Goal

1. Introduce a per-environment `userData` JSON blob — a general store for "a lot of data,"
   with credentials as one well-known key.
2. Support variable references in interaction input using `{dotted.path}` syntax, resolved
   from `userData` **at execution time** so secrets never persist.
3. Migrate existing credentials into `userData.credential`; deprecate `entityCredentials`.
4. Restructure login generation to use `{credential.*}` variables (removing the persisted
   plaintext password), and authenticate the scan by executing those variable-driven login
   steps.

`userData.credential` shape (as requested):

```json
{ "credential": { "email": "myemail@email.com", "password": "mypassword" } }
```

Example login interaction steps (variables resolved at runtime):

1. Enter `{credential.email}` in the email text input
2. Enter `{credential.password}` in the password text input
3. Hover and click the "Log in" button

## Decisions (locked)

| Decision | Choice |
|---|---|
| Keying | One `userData` row per `testEnvironment` (product + entity implied by the FK chain) |
| Existing creds | Replace + migrate `entityCredentials` → `userData.credential`; deprecate `entityCredentials` |
| Login scope | Restructure login into variable-driven interaction steps |
| Missing variable | Fail the step with a clear error |
| Interpolation location | Execution time, in `testomniac_runner_service` (secrets never persisted) |
| Login bootstrap | Thin `performInitialLogin` that executes the generated variable login steps first |
| Login submit | Hover → click the detected submit button (fallback to `pressKey Enter`) |
| Spec scope | One combined spec across all five repos |

## Architecture (chosen approach)

Variables resolve at execution time in the runner. The login generator emits `{credential.*}`
placeholders; the runner fetches the raw `userData` blob into `RunConfig.userData` and
interpolates each action's `value`/`path` just before use. This is the only approach that
removes secrets from `stepsJson` (resolving server-side at generation would re-persist them).

### 1. Storage — `testomniac_api`

New Drizzle table in `src/db/schema.ts`:

```ts
export const userData = starterSchema.table(
  "user_data",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    testEnvironmentId: bigserial("test_environment_id", { mode: "number" })
      .references(() => testEnvironments.id, { onDelete: "cascade" })
      .notNull(),
    data: jsonb("data").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  table => ({
    envUnique: uniqueIndex("testomniac_user_data_env_unique").on(
      table.testEnvironmentId
    ),
  })
);
```

- Unique index created via manual SQL (per CLAUDE.md, indexes are managed manually) in
  addition to the Drizzle declaration.
- `postgres.js` returns `bigserial` as a string — `Number()` the `id`/`testEnvironmentId` in
  raw-SQL response mappings.

Routes (`src/routes/user-data.ts`, registered in `src/routes/index.ts`):

- `GET /api/v1/test-environments/:id/user-data` → `{ success, data: { testEnvironmentId, data } }`.
  Returns `{ data: {} }` if no row exists yet.
- `PUT /api/v1/test-environments/:id/user-data` with body `{ data: UserData }` → upsert
  (`onConflictDoUpdate` on `testEnvironmentId`), bumping `updatedAt`. Returns the stored blob.
- Both Bearer-authenticated and scoped: the environment must belong to the caller's entity
  (resolve via `testEnvironments → products → entity`), matching existing route auth patterns.

Migration (one-time, `src/scripts/` or a documented SQL step):

- For each `entityCredentials` row, find the environment(s) under that entity and set
  `user_data.data.credential = { email, username, password, twoFactorCode }` (upsert),
  preserving any existing keys in `data`. Migration is idempotent.
- After migration, `entityCredentials` is no longer read or written. Leave the table in place
  for a later drop (out of scope here).

### 2. Types — `testomniac_types`

```ts
export interface UserData {
  credential?: {
    email?: string;
    username?: string;
    password?: string;
    twoFactorCode?: string;
  };
  // Open-ended: room for additional per-environment data beyond credentials.
  [key: string]: unknown;
}
```

Add `UserData` to the package's exports.

### 3. Variable interpolation engine — `testomniac_runner_service`

New module `src/orchestrator/variable-resolver.ts`:

```ts
export class UnresolvedVariableError extends Error {
  constructor(public readonly variablePath: string) {
    super(`Unresolved variable: {${variablePath}}`);
    this.name = "UnresolvedVariableError";
  }
}

const VARIABLE_RE = /\{([a-zA-Z_][\w]*(?:\.[\w]+)*)\}/g;

/** Returns the variable paths referenced in a string (for logging/masking). */
export function findVariablePaths(input: string): string[] { /* matchAll VARIABLE_RE */ }

/**
 * Replace every {dotted.path} in `input` with the corresponding value from `userData`.
 * Throws UnresolvedVariableError if any referenced path is missing/undefined.
 * Strings containing no {path} token are returned unchanged. Stray `{`/`}` that do not
 * match the token grammar are left literal.
 */
export function resolveVariables(input: string, userData: UserData | undefined): string;
```

Resolution: split each token by `.`, walk `userData` object by key; missing/`undefined` leaf
→ `UnresolvedVariableError`. Non-string leaves are coerced with `String()`.

### 4. Executor wiring — `testomniac_runner_service`

- `RunConfig` (`src/orchestrator/types.ts`) gains `userData?: UserData`.
- In `prepareActionForReplay()` (or immediately before the action runs in the step loop),
  interpolate `action.value` and `action.path` through `resolveVariables(..., config.userData)`.
- An `UnresolvedVariableError` propagates as a step failure with the existing step-error path
  (respecting `continueOnFailure`), and the failure message names the missing variable.
- **Secret masking:** the executor's step logging logs the *pre-resolution* string (the literal
  `{credential.password}`), never the resolved value. `findVariablePaths` is used to confirm a
  value was templated so logs can show `<resolved {credential.password}>` rather than the secret.

### 5. Login generation — `testomniac_api/src/generators/login.ts`

- "Correct login" interaction steps use variables instead of literals:
  - email field → `value: "{credential.email}"`
  - password field → `value: "{credential.password}"`
- Submit: when `loginDetection.loginForm` exposes a submit button selector, the final step is
  `hover` then `click` on that button; otherwise fall back to `pressKey Enter`.
- Negative tests are unchanged in intent: invalid-email and wrong-password keep their literal
  bad values; where the *real* email is needed (e.g. wrong-password test), use
  `{credential.email}`.
- Gating no longer depends on having the plaintext password. The generator instead checks
  whether the environment's `userData.credential` indicates a credential exists — the API reads
  the `userData` row and passes booleans (`hasEmail`, `hasPassword`) into the generator. It
  still requires detected email/password fields. Secrets are never passed to the generator.

### 6. Login bootstrap + LoginManager — `testomniac_runner_service`

- Retire the bespoke field-finding logic in `LoginManager.executeEmailPasswordLogin`.
- `performInitialLogin()` becomes thin: navigate to the login URL, locate the email/password
  fields via the shared `detectLoginPage` (the same detector the generator uses — not a second
  heuristic), then build variable-valued steps — `type {credential.email}` → `type
  {credential.password}` → hover/click the submit button (fallback `pressKey Enter`) — and run
  them through the **same executor action path** that resolves variables against
  `config.userData`. Initial login and the generated login interaction thus share one
  mechanism; the only "field detection" left is `detectLoginPage`.
- `LoginManager` retains SSO handling and `detectSessionExpiry`; `reLogin()` re-runs the thin
  login steps.
- `RunConfig.credentials` / `entityCredentialId` are deprecated for login: gating and values
  come from `config.userData.credential`. Leave the fields in the type for one release to avoid
  breaking callers mid-rollout, but stop reading them.
- **Known limitation (documented):** the login surface runs at `priority 0` (first), so a
  protected page deep-linked without a redirect to `/login` could be crawled before auth. The
  thin `performInitialLogin` running first mitigates the common redirect-to-login case.

### 7. userData delivery to runners

- **Extension** (`testomniac_extension/src/background/index.ts`): replace the
  `GET /api/v1/entity-credentials/:id` fetch with `GET /api/v1/test-environments/:id/user-data`
  (using `run.testEnvironmentId`), and pass the blob as `RunConfig.userData`. Remove the
  `entityCredentialId`/`credentials` plumbing into `runTestRun`.
- **Server runner** (`testomniac_runner`): fetch userData by `testEnvironmentId` at scan start
  and pass `RunConfig.userData`, mirroring the prior credential fetch.
- The raw blob lives in memory only; it is never written to `chrome.storage`.

### 8. Extension UI — `testomniac_extension/src/sidepanel/SidePanel.tsx`

- Replace the credential create/list form and `entityCredentialId` selection with userData
  editing for the resolved environment:
  - A JSON editor (textarea with parse/validate) for the full `data` blob.
  - A convenience credential sub-form (email / password / username / 2FA) that reads and writes
    `data.credential`.
- Load via `GET .../user-data` after environment resolution; save via `PUT .../user-data`.
- `START_SCAN` no longer carries `entityCredentialId`; the background resolves userData itself.

## Variable syntax (reference)

- Token grammar: `{` + identifier + zero or more `.identifier` + `}`,
  i.e. `/\{([a-zA-Z_][\w]*(?:\.[\w]+)*)\}/`.
- A string may contain multiple tokens and surrounding literal text
  (`"Enter {credential.email} now"` → `"Enter myemail@email.com now"`).
- Tokens resolve by dot-path into `userData`. Missing path → step fails (no literal, no blank).
- Braces that don't match the grammar are left literal (so arbitrary `{`/`}` input is safe).

## Security

- **Improvement:** secrets are removed from persisted `stepsJson` (variables replace literals);
  the runner resolves them in memory only, and logs mask resolved values.
- **Unchanged:** `userData.data` jsonb is stored plaintext, same as the prior credential columns.
  Encryption-at-rest is a separate follow-up (encrypt on `PUT`, decrypt on read), out of scope.

## Testing

- **testomniac_runner_service (vitest):**
  - `variable-resolver.test.ts`: resolves single/multiple tokens; surrounding literal text;
    nested dot-paths; non-string leaf coercion; missing path throws `UnresolvedVariableError`;
    stray non-matching braces left literal; empty/no-token strings unchanged.
  - Executor: a fake adapter + `RunConfig.userData` asserting `adapter.type` receives the
    resolved value, and that an unresolved variable fails the step.
- **testomniac_api (vitest):**
  - `user-data` route: GET default `{}`, PUT upsert + read-back, entity-scoping/auth rejection.
  - `generators/login.ts`: correct-login steps contain `{credential.email}`/`{credential.password}`
    (never a literal secret); submit step is hover+click when a button selector exists, else Enter.
  - Migration: an `entityCredentials` row backfills `user_data.data.credential` idempotently.
- **testomniac_extension:** typecheck + manual (no test runner). Manual: edit userData, run a
  scan against a login page, confirm auth succeeds and no secret appears in stored steps/logs.

## Rollout

Per CLAUDE.md (published-npm deps; CI publishes on push; push_all needs an uncommitted change
to detect a repo; CI runs `test:unit` so browser tests must be excluded via the
`^(?!scanner service)` name filter):

1. `testomniac_types`: add `UserData`; publish; bump consumers.
2. `testomniac_runner_service`: variable resolver + executor + LoginManager; publish; bump.
3. `testomniac_api`: table, routes, migration, login generator; deploy/publish.
4. `testomniac_runner`: fetch userData → `RunConfig.userData`; publish.
5. `testomniac_extension`: UI + background; `bun install` the new deps; build.

Order matters: types first, then runner_service, then the consumers. Run the migration before
relying on userData for auth so existing credentials carry over.
