# userData Store + Variable Interpolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a per-environment `userData` JSON blob, let interaction input reference it via `{dotted.path}` variables resolved at runtime, migrate credentials into it, and restructure login generation to use `{credential.*}` variables so secrets never persist.

**Architecture:** A new `userData` table (one row per `testEnvironment`) holds an open-ended JSON blob with credentials at `data.credential`. A pure `resolveVariables` engine in `testomniac_runner_service` substitutes `{path}` tokens from `RunConfig.userData` at execution time. The login generator emits `{credential.*}` placeholders instead of literal secrets, and a thin `performInitialLogin` authenticates by running those variable-driven steps. Both runner hosts fetch the blob by `testEnvironmentId` and pass it through; the extension UI edits it.

**Tech Stack:** TypeScript, Bun, Vitest (runner_service + api), Drizzle ORM + PostgreSQL, Hono (api routes), React (extension), `@crxjs/vite-plugin`.

## Global Constraints

- Variable token grammar: `/\{([a-zA-Z_][\w]*(?:\.[\w]+)*)\}/` — only `{dotted.path}` is a variable; stray braces are left literal.
- Missing variable at execution → **fail the step** (throw `UnresolvedVariableError`), never type a literal placeholder or blank.
- Secrets must never be persisted in `stepsJson` — login steps carry `{credential.*}` placeholders only; resolution is runtime + in-memory.
- Executor logging masks resolved variable values (log the literal `{credential.password}`, never the resolved value).
- `userData` is keyed **one row per `testEnvironmentId`** (unique). `data.credential = { email?, username?, password?, twoFactorCode? }`.
- All `@sudobility/*` deps resolve from **published npm**; no local source aliases. CI publishes on push to `main`. `push_all.sh` only acts on a repo with an **uncommitted** change and its validation is **typecheck + build only** (it does NOT run tests) — CI runs the tests and is the publish gate.
- CI runs the full test command per repo (`vitest run` in runner_service; `bun test` in api). Any test needing a browser/live DB must be excluded from the CI test job (api/runner_service route+generator+resolver tests here are pure unit tests with fakes — no browser, no DB).
- `postgres.js` returns `bigserial`/int8 as strings — `Number()` id fields in raw-SQL response mappings; `.trim()` CHAR(N) comparisons.
- Rollout order (dependency): `testomniac_types` → `testomniac_runner_service` → `testomniac_api` → `testomniac_runner` → `testomniac_extension`. Run the migration before relying on userData for auth.
- `RunConfig.credentials` / `entityCredentialId` are deprecated but kept in the type for one release (unread).

---

### Task 1: Add `UserData` type (testomniac_types)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_types/src/index.ts` (add interface near `Credentials`, ~line 696)

**Interfaces:**
- Produces: `interface UserData { credential?: { email?: string; username?: string; password?: string; twoFactorCode?: string }; [key: string]: unknown }`

- [ ] **Step 1: Add the interface**

In `/Users/johnhuang/projects/testomniac_types/src/index.ts`, immediately above `export interface Credentials {` (line 696):

```ts
/**
 * Per-environment user data blob. Open-ended store; `credential` is the
 * well-known key consumed by login/auth. Variables in interaction input
 * (`{dotted.path}`) resolve against this object at execution time.
 */
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

- [ ] **Step 2: Typecheck**

Run: `cd /Users/johnhuang/projects/testomniac_types && bun run typecheck` (or `bunx tsc --noEmit` if no script)
Expected: PASS, no errors. `UserData` is exported (top-level `export interface` in the package entry).

- [ ] **Step 3: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_types
git add src/index.ts
git commit -m "feat: add UserData type

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Publish testomniac_types + propagate

**Files:** version fields across repos (automated by script).

This task's deliverable: `@sudobility/testomniac_types` published with `UserData`, and `runner_service`/`api`/`runner`/`extension` resolving the new version so later tasks can import it.

- [ ] **Step 1: Bump types version (uncommitted, so push_all detects it)**

Edit `/Users/johnhuang/projects/testomniac_types/package.json` `version` — increment the patch (e.g. `0.0.75` → `0.0.76`). Do NOT commit.

- [ ] **Step 2: Run push_all**

Run: `cd /Users/johnhuang/projects/testomniac_app && ./scripts/push_all.sh`
Expected: types published; `@sudobility/testomniac_types` range bumped in the consumer repos; "All Projects Processed Successfully".

- [ ] **Step 3: Verify CI published the new types version**

Run: `cd /Users/johnhuang/projects/testomniac_types && gh run list --limit 1`
Expected: latest CI/CD run `success`. If `failure`, open `gh run view <id> --log-failed`, fix, and re-run push_all (bump again uncommitted).

- [ ] **Step 4: Confirm npm + consumers**

Run: `curl -s https://registry.npmjs.org/@sudobility/testomniac_types | python3 -c "import sys,json;print(json.load(sys.stdin)['dist-tags']['latest'])"`
Expected: the new version. Then in `runner_service`, `api`, `runner`, `extension`, ensure `bun install` has the new types (push_all updates ranges; if a repo wasn't bumped, run `bun add @sudobility/testomniac_types@latest` there).

---

### Task 3: Variable resolver (testomniac_runner_service)

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/variable-resolver.ts`
- Test: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/variable-resolver.test.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/index.ts` (export)

**Interfaces:**
- Consumes: `UserData` from `@sudobility/testomniac_types` (Task 1).
- Produces:
  - `class UnresolvedVariableError extends Error { variablePath: string }`
  - `function findVariablePaths(input: string): string[]`
  - `function resolveVariables(input: string, userData: UserData | undefined): string`

- [ ] **Step 1: Write the failing test**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/variable-resolver.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  resolveVariables,
  findVariablePaths,
  UnresolvedVariableError,
} from "./variable-resolver";
import type { UserData } from "@sudobility/testomniac_types";

const data: UserData = {
  credential: { email: "me@example.com", password: "secret" },
  profile: { name: "Ada" },
  count: 3,
};

describe("findVariablePaths", () => {
  it("returns referenced dotted paths", () => {
    expect(findVariablePaths("Enter {credential.email} now")).toEqual([
      "credential.email",
    ]);
    expect(findVariablePaths("{a.b} and {c}")).toEqual(["a.b", "c"]);
    expect(findVariablePaths("no tokens")).toEqual([]);
  });
});

describe("resolveVariables", () => {
  it("replaces a single token", () => {
    expect(resolveVariables("{credential.email}", data)).toBe("me@example.com");
  });
  it("replaces tokens embedded in surrounding text and multiple tokens", () => {
    expect(
      resolveVariables("Hi {profile.name}, code {count}", data)
    ).toBe("Hi Ada, code 3");
  });
  it("coerces non-string leaves with String()", () => {
    expect(resolveVariables("{count}", data)).toBe("3");
  });
  it("leaves strings without tokens unchanged", () => {
    expect(resolveVariables("plain text", data)).toBe("plain text");
  });
  it("leaves stray non-matching braces literal", () => {
    expect(resolveVariables("a { b } {not-a-path!}", data)).toBe(
      "a { b } {not-a-path!}"
    );
  });
  it("throws UnresolvedVariableError for a missing path", () => {
    expect(() => resolveVariables("{credential.username}", data)).toThrowError(
      UnresolvedVariableError
    );
    try {
      resolveVariables("{nope.here}", data);
    } catch (e) {
      expect((e as UnresolvedVariableError).variablePath).toBe("nope.here");
    }
  });
  it("throws when userData is undefined but a token is present", () => {
    expect(() => resolveVariables("{credential.email}", undefined)).toThrowError(
      UnresolvedVariableError
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/variable-resolver.test.ts`
Expected: FAIL — `Cannot find module './variable-resolver'`.

- [ ] **Step 3: Write the implementation**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/variable-resolver.ts`:

```ts
import type { UserData } from "@sudobility/testomniac_types";

export class UnresolvedVariableError extends Error {
  constructor(public readonly variablePath: string) {
    super(`Unresolved variable: {${variablePath}}`);
    this.name = "UnresolvedVariableError";
  }
}

// Only `{identifier(.identifier)*}` is treated as a variable token.
const VARIABLE_RE = /\{([a-zA-Z_][\w]*(?:\.[\w]+)*)\}/g;

/** Variable paths referenced in `input` (deduped by appearance order). */
export function findVariablePaths(input: string): string[] {
  const paths: string[] = [];
  for (const match of input.matchAll(VARIABLE_RE)) {
    paths.push(match[1]);
  }
  return paths;
}

function lookup(userData: UserData | undefined, path: string): unknown {
  if (userData == null) return undefined;
  let cursor: unknown = userData;
  for (const key of path.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Replace every {dotted.path} token in `input` with its value from `userData`.
 * Strings with no token are returned unchanged. Missing/undefined leaf throws
 * UnresolvedVariableError. Non-string leaves are coerced with String().
 */
export function resolveVariables(
  input: string,
  userData: UserData | undefined
): string {
  return input.replace(VARIABLE_RE, (_full, path: string) => {
    const value = lookup(userData, path);
    if (value === undefined || value === null) {
      throw new UnresolvedVariableError(path);
    }
    return String(value);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/variable-resolver.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Export from index**

In `/Users/johnhuang/projects/testomniac_runner_service/src/index.ts`, add near the other orchestrator exports:

```ts
export {
  resolveVariables,
  findVariablePaths,
  UnresolvedVariableError,
} from "./orchestrator/variable-resolver";
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run typecheck`
Expected: PASS.

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/orchestrator/variable-resolver.ts src/orchestrator/variable-resolver.test.ts src/index.ts
git commit -m "feat: add {path} variable resolver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Executor interpolation + RunConfig.userData (testomniac_runner_service)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/types.ts` (add `userData`)
- Create: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/interpolate-action.ts`
- Test: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/interpolate-action.test.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts` (apply interpolation; pass userData)

**Interfaces:**
- Consumes: `resolveVariables` (Task 3); `RunConfig` (existing).
- Produces:
  - `RunConfig.userData?: UserData`
  - `function interpolateAction<T extends { value?: string; path?: string }>(action: T, userData: UserData | undefined): T` — returns a copy with `value`/`path` resolved.

**Secret-masking approach:** interpolation is applied *only* to the action passed into
`executeAction`. The `replayAction` variable used for logging and `stepExecutions` stays
**un-interpolated** (it keeps the `{credential.*}` tokens), so resolved secrets never reach a
log line or the stored step record. This satisfies spec §4 structurally — no separate masking
function is needed.

- [ ] **Step 1: Add `userData` to RunConfig**

In `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/types.ts`, add the import and field:

```ts
import type { Credentials, UserData } from "@sudobility/testomniac_types";
```

and inside `RunConfig`, after `credentials?: Credentials;`:

```ts
  /** Per-environment data blob; source for {path} variable interpolation. */
  userData?: UserData;
```

- [ ] **Step 2: Write the failing test**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/interpolate-action.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { interpolateAction } from "./interpolate-action";
import { UnresolvedVariableError } from "./variable-resolver";
import type { UserData } from "@sudobility/testomniac_types";

const userData: UserData = {
  credential: { email: "me@example.com", password: "secret" },
};

describe("interpolateAction", () => {
  it("resolves value and path, leaving other fields intact", () => {
    const out = interpolateAction(
      { value: "{credential.email}", path: "#email", description: "d" },
      userData
    );
    expect(out.value).toBe("me@example.com");
    expect(out.path).toBe("#email");
    expect(out.description).toBe("d");
  });
  it("resolves a variable inside the selector path", () => {
    const out = interpolateAction(
      { path: "[data-user='{credential.email}']" },
      userData
    );
    expect(out.path).toBe("[data-user='me@example.com']");
  });
  it("passes through actions with no tokens unchanged", () => {
    const out = interpolateAction({ value: "literal", path: "#x" }, userData);
    expect(out.value).toBe("literal");
  });
  it("does not mutate the input action", () => {
    const input = { value: "{credential.email}", path: "#email" };
    interpolateAction(input, userData);
    expect(input.value).toBe("{credential.email}"); // original untouched
  });
  it("throws UnresolvedVariableError on a missing variable", () => {
    expect(() =>
      interpolateAction({ value: "{credential.username}" }, userData)
    ).toThrowError(UnresolvedVariableError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/interpolate-action.test.ts`
Expected: FAIL — `Cannot find module './interpolate-action'`.

- [ ] **Step 4: Write the implementation**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/interpolate-action.ts`:

```ts
import type { UserData } from "@sudobility/testomniac_types";
import { resolveVariables } from "./variable-resolver";

/**
 * Return a shallow copy of `action` with `value` and `path` resolved against
 * userData. Throws UnresolvedVariableError if any referenced variable is
 * missing (caller surfaces this as a step failure). The input is not mutated,
 * so callers can keep the original (un-interpolated) action for logging.
 */
export function interpolateAction<
  T extends { value?: string; path?: string }
>(action: T, userData: UserData | undefined): T {
  const next: T = { ...action };
  if (typeof next.value === "string") {
    next.value = resolveVariables(next.value, userData);
  }
  if (typeof next.path === "string") {
    next.path = resolveVariables(next.path, userData);
  }
  return next;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/interpolate-action.test.ts`
Expected: PASS.

- [ ] **Step 6: Apply interpolation at the executeAction call sites only**

In `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/test-interaction-executor.ts`:

Add the import near the other local imports:

```ts
import { interpolateAction } from "./interpolate-action";
```

`replayAction = prepareActionForReplay(step.action)` is used both for logging /
`stepExecutions` AND for `executeAction`. Leave `replayAction` **un-interpolated** (so logs and
the stored step record keep the `{credential.*}` tokens — no resolved secrets are ever logged
or stored), and interpolate **only** the action handed to `executeAction`.

There are two `executeAction(adapter, replayAction, testRun)` call sites — the setup-replay loop
(currently line 370) and the main step loop (currently line 412). At **both**, replace:

```ts
        await executeAction(adapter, replayAction, testRun);
```

with:

```ts
        await executeAction(
          adapter,
          interpolateAction(replayAction, config.userData),
          testRun
        );
```

`config` is the `RunConfig` in scope in `executeTestInteraction`. An `UnresolvedVariableError`
thrown here propagates through the existing per-step `try/catch` (around line 411) as a step
error, respecting `continueOnFailure`; the error message names the missing variable. (The
setup-replay loop has its own `try/catch` that logs and skips — an unresolved variable there
fails just that replayed setup step, which is acceptable.)

- [ ] **Step 7: Run full runner_service test + typecheck + lint**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test && bun run typecheck && bun run lint`
Expected: all PASS. If prettier flags formatting, run `bun run lint:fix` and re-run.

- [ ] **Step 8: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/orchestrator/types.ts src/orchestrator/interpolate-action.ts src/orchestrator/interpolate-action.test.ts src/orchestrator/test-interaction-executor.ts
git commit -m "feat: interpolate {path} variables into action value/path at execution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Thin performInitialLogin + retire heuristic fill (testomniac_runner_service)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/login-manager.ts`
- Modify: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/runner.ts` (gate login on userData.credential)
- Test: `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/login-manager.test.ts`

**Interfaces:**
- Consumes: `resolveVariables` (Task 3); `interpolateAction` (Task 4); `RunConfig.userData` (Task 4); `detectLoginPage` (existing, `../scanner/login-detector`); `LoginConfig`.
- Produces: `LoginManager.performInitialLogin()` (unchanged signature) now builds variable-valued login steps from `detectLoginPage` and executes them; `buildLoginSteps(form, submitSelector?)` exported helper returning the step list with `{credential.*}` values.

- [ ] **Step 1: Write the failing test for buildLoginSteps**

Create `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/login-manager.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildLoginSteps } from "./login-manager";

describe("buildLoginSteps", () => {
  const form = {
    fields: [
      { type: "email", selector: "#email" },
      { type: "password", selector: "#password" },
    ],
  } as any;

  it("emits {credential.email} and {credential.password} type steps", () => {
    const steps = buildLoginSteps(form, "#submit");
    expect(steps[0]).toMatchObject({
      action: "type",
      selector: "#email",
      value: "{credential.email}",
    });
    expect(steps[1]).toMatchObject({
      action: "type",
      selector: "#password",
      value: "{credential.password}",
    });
  });

  it("hovers then clicks the submit button when given a selector", () => {
    const steps = buildLoginSteps(form, "#submit");
    expect(steps[2]).toMatchObject({ action: "hover", selector: "#submit" });
    expect(steps[3]).toMatchObject({ action: "click", selector: "#submit" });
  });

  it("falls back to pressKey Enter when no submit selector", () => {
    const steps = buildLoginSteps(form, undefined);
    const last = steps[steps.length - 1];
    expect(last).toMatchObject({ action: "pressKey", key: "Enter" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/login-manager.test.ts`
Expected: FAIL — `buildLoginSteps` is not exported.

- [ ] **Step 3: Implement buildLoginSteps + thin login, retire heuristic**

In `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/login-manager.ts`:

Add the exported step builder (near the top, after imports):

```ts
export interface LoginStep {
  action: "type" | "hover" | "click" | "pressKey";
  selector?: string;
  value?: string;
  key?: string;
}

/**
 * Build variable-driven login steps from a detected login form. Values use
 * {credential.*} placeholders resolved at execution time — no secrets here.
 */
export function buildLoginSteps(
  form: { fields: Array<{ type?: string; name?: string; selector?: string }> },
  submitSelector: string | undefined
): LoginStep[] {
  const emailField = form.fields.find(
    f =>
      f.type === "email" ||
      f.name?.toLowerCase().includes("email") ||
      f.name?.toLowerCase().includes("user")
  );
  const passwordField = form.fields.find(f => f.type === "password");

  const steps: LoginStep[] = [];
  if (emailField?.selector) {
    steps.push({
      action: "type",
      selector: emailField.selector,
      value: "{credential.email}",
    });
  }
  if (passwordField?.selector) {
    steps.push({
      action: "type",
      selector: passwordField.selector,
      value: "{credential.password}",
    });
  }
  if (submitSelector) {
    steps.push({ action: "hover", selector: submitSelector });
    steps.push({ action: "click", selector: submitSelector });
  } else {
    steps.push({ action: "pressKey", key: "Enter" });
  }
  return steps;
}
```

Replace the body of `executeEmailPasswordLogin(form)` (the heuristic field-find + fill, ~lines 157–229) so it delegates to `buildLoginSteps` and executes each step through the adapter, resolving `{credential.*}` against `this.config` credential values. Use this implementation:

```ts
  async executeEmailPasswordLogin(form: FormInfo | null): Promise<boolean> {
    if (!form) {
      logLogin("email-password:no-form");
      return false;
    }
    const userData = { credential: this.config.credential };
    const submitSelector = form.submitSelector ?? undefined;
    const steps = buildLoginSteps(form, submitSelector);
    logLogin("email-password:start", { stepCount: steps.length });
    try {
      for (const step of steps) {
        if (step.action === "type" && step.selector && step.value) {
          await this.adapter.type(
            step.selector,
            resolveVariables(step.value, userData)
          );
        } else if (step.action === "hover" && step.selector) {
          await this.adapter.hover(step.selector);
        } else if (step.action === "click" && step.selector) {
          await this.adapter.click(step.selector);
        } else if (step.action === "pressKey" && step.key) {
          await this.adapter.pressKey(step.key);
        }
      }
      await this.adapter.waitForNavigation({ timeout: 10000 }).catch(() => {});
      const success = await this.verifyLoginSuccess();
      logLogin("email-password:result", { success });
      return success;
    } catch (err) {
      logLogin("email-password:error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
```

Add the imports at the top of the file:

```ts
import { resolveVariables } from "./variable-resolver";
```

`LoginConfig` must carry the credential object. In `LoginManager`, set `this.config.credential` from the run config. Update the constructor wiring so `config.credential = { email, username, password, twoFactorCode }` is available (see Step 5 for where runner.ts populates it). If `FormInfo` has no `submitSelector` field, add an optional `submitSelector?: string` to its type where `FormInfo` is defined and have the login detector populate it from the form's submit button; if that is out of scope, pass `undefined` and rely on the `pressKey Enter` fallback (the fallback path must remain correct).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test src/orchestrator/login-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate login on userData.credential in runner.ts**

In `/Users/johnhuang/projects/testomniac_runner_service/src/orchestrator/runner.ts`, the login-manager setup block (~lines 287–322) currently keys off `config.credentials || config.entityCredentialId`. Change it to derive the credential from `config.userData?.credential` and build `LoginConfig` with `credential`:

Replace the condition `if (config.credentials || config.entityCredentialId) {` with:

```ts
    const credential = config.userData?.credential;
    if (credential || config.loginUrl) {
```

and inside, build the `loginConfig` so it includes `credential` and `loginUrl: config.loginUrl`, sourcing email/password from `credential` (no longer from `config.credentials`). Keep the existing `performInitialLogin()` call gated on `loginManager && (config.loginUrl || credential)`.

- [ ] **Step 6: Run full test + typecheck + lint**

Run: `cd /Users/johnhuang/projects/testomniac_runner_service && bun run test && bun run typecheck && bun run lint`
Expected: all PASS (run `lint:fix` if prettier complains).

- [ ] **Step 7: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_runner_service
git add src/orchestrator/login-manager.ts src/orchestrator/login-manager.test.ts src/orchestrator/runner.ts
git commit -m "feat: thin variable-driven performInitialLogin; retire heuristic fill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Publish runner_service + propagate

Same mechanics as Task 2.

- [ ] **Step 1: Bump runner_service version (uncommitted)** — edit `package.json` version, do not commit.
- [ ] **Step 2: Run push_all** — `cd /Users/johnhuang/projects/testomniac_app && ./scripts/push_all.sh`.
- [ ] **Step 3: Verify CI** — `cd /Users/johnhuang/projects/testomniac_runner_service && gh run list --limit 1` → `success`. On `failure`, `gh run view <id> --log-failed`, fix, re-run push_all (the new resolver/executor tests are pure unit tests, so CI's `vitest run` should pass).
- [ ] **Step 4: Confirm npm latest > prior** and that `api`, `runner`, `extension` resolve it (`bun add @sudobility/testomniac_runner_service@latest` in any repo push_all didn't bump). In the extension, also `rm -rf node_modules/.vite`.

---

### Task 7: userData table (testomniac_api)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/db/schema.ts` (add table)
- Modify: `/Users/johnhuang/projects/testomniac_api/src/db/index.ts` (export `userData` if it re-exports tables)
- Doc: record the unique-index SQL (indexes are managed manually per CLAUDE.md)

**Interfaces:**
- Produces: `userData` Drizzle table — columns `id`, `testEnvironmentId`, `data` (jsonb), `createdAt`, `updatedAt`; unique on `testEnvironmentId`.

- [ ] **Step 1: Add the table**

In `/Users/johnhuang/projects/testomniac_api/src/db/schema.ts`, after the `testEnvironments` table definition, add (the file already imports `jsonb` and `uniqueIndex`):

```ts
// =============================================================================
// User Data (per-environment JSON blob; credentials live at data.credential)
// =============================================================================

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

- [ ] **Step 2: Export from db barrel if applicable**

If `/Users/johnhuang/projects/testomniac_api/src/db/index.ts` re-exports tables (check how `entityCredentials` is exported there), add `userData` to the same export so `import { db, userData } from "../db"` works in routes.

Run: `grep -n "entityCredentials\|export \*\|export {" /Users/johnhuang/projects/testomniac_api/src/db/index.ts`
Then mirror that pattern for `userData`.

- [ ] **Step 3: Create the table + unique index in the database (manual SQL)**

Run against the database (psql or the project's SQL runner):

```sql
CREATE TABLE IF NOT EXISTS user_data (
  id BIGSERIAL PRIMARY KEY,
  test_environment_id BIGINT NOT NULL REFERENCES test_environments(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS testomniac_user_data_env_unique
  ON user_data (test_environment_id);
```

Expected: table + index created. (Coordinate with the DB owner; the DB is remote per CLAUDE.md.)

- [ ] **Step 4: Typecheck + commit**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run typecheck`
Expected: PASS.

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/db/schema.ts src/db/index.ts
git commit -m "feat: add user_data table (per-environment json blob)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: user-data routes (testomniac_api)

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_api/src/routes/user-data.ts`
- Create: `/Users/johnhuang/projects/testomniac_api/src/lib/user-data-helpers.ts` (pure helpers)
- Test: `/Users/johnhuang/projects/testomniac_api/src/lib/user-data-helpers.test.ts`
- Modify: `/Users/johnhuang/projects/testomniac_api/src/routes/index.ts` (register router)

**Interfaces:**
- Consumes: `UserData` (types); `userData` table (Task 7); `entityHelpers`/membership pattern from `entity-credentials.ts`.
- Produces:
  - `GET /api/v1/test-environments/:id/user-data` → `{ success, data: { testEnvironmentId, data } }`
  - `PUT /api/v1/test-environments/:id/user-data` (body `{ data }`) → upsert
  - `function credentialFlags(data: UserData): { hasEmail: boolean; hasPassword: boolean }` (used by the login generator, Task 9)

- [ ] **Step 1: Write the failing test for helpers**

Create `/Users/johnhuang/projects/testomniac_api/src/lib/user-data-helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { credentialFlags } from "./user-data-helpers";

describe("credentialFlags", () => {
  it("reports presence of email and password", () => {
    expect(
      credentialFlags({ credential: { email: "a@b.com", password: "x" } })
    ).toEqual({ hasEmail: true, hasPassword: true });
  });
  it("treats empty strings as absent", () => {
    expect(
      credentialFlags({ credential: { email: "", password: "" } })
    ).toEqual({ hasEmail: false, hasPassword: false });
  });
  it("handles missing credential object", () => {
    expect(credentialFlags({})).toEqual({ hasEmail: false, hasPassword: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun test src/lib/user-data-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helpers**

Create `/Users/johnhuang/projects/testomniac_api/src/lib/user-data-helpers.ts`:

```ts
import type { UserData } from "@sudobility/testomniac_types";

export function credentialFlags(data: UserData | null | undefined): {
  hasEmail: boolean;
  hasPassword: boolean;
} {
  const cred = data?.credential;
  return {
    hasEmail: !!cred?.email && cred.email.length > 0,
    hasPassword: !!cred?.password && cred.password.length > 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun test src/lib/user-data-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the route**

Create `/Users/johnhuang/projects/testomniac_api/src/routes/user-data.ts`. Resolve the environment → product → entity and reuse the membership check used in `entity-credentials.ts` (`entityHelpers.members.isMember`). Implement GET (default `{}`) and PUT (upsert on `testEnvironmentId`):

```ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { successResponse, errorResponse } from "@sudobility/testomniac_types";
import type { UserData } from "@sudobility/testomniac_types";
import { entityHelpers as helpers } from "../lib/entity-helpers";
import { db, userData, testEnvironments, products } from "../db";

type Variables = { userId: string; userEmail: string | null };
const userDataRouter = new Hono<{ Variables: Variables }>();

// Resolve the entity that owns a test environment, then check membership.
async function authorizeEnv(
  userId: string,
  testEnvironmentId: number
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const env = await db.query.testEnvironments.findFirst({
    where: eq(testEnvironments.id, testEnvironmentId),
  });
  if (!env) return { ok: false, status: 404 };
  const product = await db.query.products.findFirst({
    where: eq(products.id, env.productId),
  });
  const entityId = product?.entityId ?? product?.entity_id ?? null;
  if (!entityId) return { ok: false, status: 404 };
  const isMember = await helpers.members.isMember(entityId, userId);
  return isMember ? { ok: true } : { ok: false, status: 403 };
}

userDataRouter.get("/:id/user-data", async c => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const auth = await authorizeEnv(userId, id);
  if (!auth.ok) {
    return c.json(
      errorResponse(auth.status === 404 ? "Environment not found" : "Access denied"),
      auth.status
    );
  }
  const row = await db.query.userData.findFirst({
    where: eq(userData.testEnvironmentId, id),
  });
  return c.json(
    successResponse({ testEnvironmentId: id, data: (row?.data as UserData) ?? {} })
  );
});

userDataRouter.put("/:id/user-data", async c => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const auth = await authorizeEnv(userId, id);
  if (!auth.ok) {
    return c.json(
      errorResponse(auth.status === 404 ? "Environment not found" : "Access denied"),
      auth.status
    );
  }
  const body = await c.req.json<{ data: UserData }>();
  const [row] = await db
    .insert(userData)
    .values({ testEnvironmentId: id, data: body.data ?? {} })
    .onConflictDoUpdate({
      target: userData.testEnvironmentId,
      set: { data: body.data ?? {}, updatedAt: new Date() },
    })
    .returning();
  return c.json(
    successResponse({ testEnvironmentId: id, data: row.data as UserData })
  );
});

export default userDataRouter;
```

(If `products` exposes `entityId` only under one name, drop the `?? product?.entity_id` fallback — check the column name when implementing. The schema shows `entityId: text("entity_id")`.)

- [ ] **Step 6: Register the router**

In `/Users/johnhuang/projects/testomniac_api/src/routes/index.ts`, import `userDataRouter` and mount it on the authenticated `test-environments` path (next to line 104 `authRoutes.route("/test-environments", testEnvironmentsRouter);`):

```ts
authRoutes.route("/test-environments", userDataRouter);
```

(Hono merges multiple routers on the same base path; the `:id/user-data` sub-paths won't collide with existing `test-environments` routes.)

- [ ] **Step 7: Typecheck + commit**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run typecheck && bun test src/lib/user-data-helpers.test.ts`
Expected: PASS.

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/routes/user-data.ts src/lib/user-data-helpers.ts src/lib/user-data-helpers.test.ts src/routes/index.ts
git commit -m "feat: user-data GET/PUT routes (per-environment blob)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Login generator uses variables (testomniac_api)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_api/src/generators/login.ts`
- Test: `/Users/johnhuang/projects/testomniac_api/src/generators/login.test.ts`
- Modify: caller that passes `loginConfig` to `generateLoginTestInteractions` (`src/generators/page-analyzer.ts:617`) to pass credential flags instead of secrets.

**Interfaces:**
- Consumes: `credentialFlags` (Task 8); `userData` for the environment (read by the page-analyzer caller).
- Produces: login interactions whose "correct login" steps carry `{credential.email}`/`{credential.password}` and a hover→click submit (fallback Enter); no literal secrets.

- [ ] **Step 1: Write the failing test**

Create `/Users/johnhuang/projects/testomniac_api/src/generators/login.test.ts`. The generator is heavily I/O-coupled, so test the **step builder** that we extract. First the test (it drives extraction):

```ts
import { describe, it, expect } from "vitest";
import { buildCorrectLoginSteps } from "./login";

describe("buildCorrectLoginSteps", () => {
  const fields = { emailSelector: "#email", passwordSelector: "#password" };

  it("uses credential variables, never literal secrets", () => {
    const steps = buildCorrectLoginSteps(fields, "#submit");
    expect(steps[0]).toMatchObject({
      action: "type",
      selector: "#email",
      value: "{credential.email}",
    });
    expect(steps[1]).toMatchObject({
      action: "type",
      selector: "#password",
      value: "{credential.password}",
    });
    const serialized = JSON.stringify(steps);
    expect(serialized).not.toContain("password123");
  });

  it("hovers then clicks submit when a button selector exists", () => {
    const steps = buildCorrectLoginSteps(fields, "#submit");
    expect(steps[2]).toMatchObject({ action: "hover", selector: "#submit" });
    expect(steps[3]).toMatchObject({ action: "click", selector: "#submit" });
  });

  it("falls back to pressKey Enter without a submit selector", () => {
    const steps = buildCorrectLoginSteps(fields, undefined);
    expect(steps[steps.length - 1]).toMatchObject({
      action: "pressKey",
      key: "Enter",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun test src/generators/login.test.ts`
Expected: FAIL — `buildCorrectLoginSteps` not exported.

- [ ] **Step 3: Extract + implement the step builder, switch the generator to it**

In `/Users/johnhuang/projects/testomniac_api/src/generators/login.ts`, add the exported builder:

```ts
export interface GeneratedLoginStep {
  action: "type" | "hover" | "click" | "pressKey";
  selector?: string;
  value?: string;
  key?: string;
}

/** Correct-login steps using {credential.*} variables (no literal secrets). */
export function buildCorrectLoginSteps(
  fields: { emailSelector: string; passwordSelector: string },
  submitSelector: string | undefined
): GeneratedLoginStep[] {
  const steps: GeneratedLoginStep[] = [
    { action: "type", selector: fields.emailSelector, value: "{credential.email}" },
    {
      action: "type",
      selector: fields.passwordSelector,
      value: "{credential.password}",
    },
  ];
  if (submitSelector) {
    steps.push({ action: "hover", selector: submitSelector });
    steps.push({ action: "click", selector: submitSelector });
  } else {
    steps.push({ action: "pressKey", key: "Enter" });
  }
  return steps;
}
```

Replace the "Test 3: Correct login" `steps:` array (currently lines 181–193, the block using `loginConfig.email`/`loginConfig.password`) with:

```ts
        steps: buildCorrectLoginSteps(
          {
            emailSelector: emailField.selector,
            passwordSelector: passwordField.selector,
          },
          form.submitSelector
        ),
```

Replace the email value in the "wrong password" test (line 137, `value: loginConfig.email`) with `value: "{credential.email}"`. Leave the intentionally-wrong literals (`"not-an-email"`, `"incorrect_password_" + Date.now()`) as-is.

Change the gating condition `if (loginDetection.loginForm && loginConfig?.password) {` (line 55) to use credential flags instead of the secret:

```ts
  if (loginDetection.loginForm && context.credentialFlags?.hasPassword) {
```

and the inner conditions that used `loginConfig.email` (lines 118, 166) to `context.credentialFlags?.hasEmail`.

- [ ] **Step 4: Pass credentialFlags from the caller**

In `/Users/johnhuang/projects/testomniac_api/src/generators/page-analyzer.ts` (call site line 617) and the `AnalyzerContext` type (`src/generators/analyzer-types.ts`), add an optional `credentialFlags?: { hasEmail: boolean; hasPassword: boolean }` to the context, populated by reading the environment's `userData` (via `credentialFlags(userDataRow.data)` from Task 8) where the scan context is assembled. If the userData read is not readily available at that layer, compute the flags wherever `loginConfig` is currently sourced and attach to context. The generator must no longer receive `loginConfig.password`.

- [ ] **Step 5: Run test + typecheck**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun test src/generators/login.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/generators/login.ts src/generators/login.test.ts src/generators/page-analyzer.ts src/generators/analyzer-types.ts
git commit -m "feat: login generator emits {credential.*} variables + hover/click submit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Migrate entityCredentials → userData.credential (testomniac_api)

**Files:**
- Create: `/Users/johnhuang/projects/testomniac_api/src/scripts/migrate-credentials-to-userdata.ts`
- Test: `/Users/johnhuang/projects/testomniac_api/src/scripts/migrate-credentials-to-userdata.test.ts` (pure transform)

**Interfaces:**
- Produces: `function toUserDataCredential(row): UserData["credential"]` (pure) + a runnable migration that, for each `entityCredentials` row, upserts `data.credential` on every `user_data` row of environments under that entity, preserving existing `data` keys. Idempotent.

- [ ] **Step 1: Write the failing test for the transform**

Create `/Users/johnhuang/projects/testomniac_api/src/scripts/migrate-credentials-to-userdata.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toUserDataCredential, mergeCredential } from "./migrate-credentials-to-userdata";

describe("toUserDataCredential", () => {
  it("maps credential columns, dropping null/empty", () => {
    expect(
      toUserDataCredential({
        email: "a@b.com",
        username: null,
        password: "pw",
        twoFactorCode: null,
      })
    ).toEqual({ email: "a@b.com", password: "pw" });
  });
});

describe("mergeCredential", () => {
  it("sets credential without clobbering other data keys", () => {
    expect(
      mergeCredential({ profile: { x: 1 } }, { email: "a@b.com" })
    ).toEqual({ profile: { x: 1 }, credential: { email: "a@b.com" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun test src/scripts/migrate-credentials-to-userdata.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement transform + migration runner**

Create `/Users/johnhuang/projects/testomniac_api/src/scripts/migrate-credentials-to-userdata.ts`:

```ts
import type { UserData } from "@sudobility/testomniac_types";

type CredRow = {
  email: string | null;
  username: string | null;
  password: string | null;
  twoFactorCode: string | null;
};

export function toUserDataCredential(row: CredRow): UserData["credential"] {
  const cred: NonNullable<UserData["credential"]> = {};
  if (row.email) cred.email = row.email;
  if (row.username) cred.username = row.username;
  if (row.password) cred.password = row.password;
  if (row.twoFactorCode) cred.twoFactorCode = row.twoFactorCode;
  return cred;
}

export function mergeCredential(
  existing: UserData,
  credential: UserData["credential"]
): UserData {
  return { ...existing, credential };
}

// Runner (executed via `bun run src/scripts/migrate-credentials-to-userdata.ts`).
// Imports db lazily so the pure helpers above stay unit-testable without a DB.
export async function run(): Promise<void> {
  const { db, entityCredentials, userData, testEnvironments, products } =
    await import("../db");
  const { eq } = await import("drizzle-orm");
  const creds = await db.query.entityCredentials.findMany();
  for (const cred of creds) {
    const prods = await db.query.products.findMany({
      where: eq(products.entityId, cred.entityId),
    });
    for (const product of prods) {
      const envs = await db.query.testEnvironments.findMany({
        where: eq(testEnvironments.productId, product.id),
      });
      for (const env of envs) {
        const existingRow = await db.query.userData.findFirst({
          where: eq(userData.testEnvironmentId, env.id),
        });
        const merged = mergeCredential(
          (existingRow?.data as UserData) ?? {},
          toUserDataCredential(cred)
        );
        await db
          .insert(userData)
          .values({ testEnvironmentId: env.id, data: merged })
          .onConflictDoUpdate({
            target: userData.testEnvironmentId,
            set: { data: merged, updatedAt: new Date() },
          });
      }
    }
  }
}

if (import.meta.main) {
  run().then(
    () => process.exit(0),
    err => {
      console.error(err);
      process.exit(1);
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun test src/scripts/migrate-credentials-to-userdata.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit (do NOT run the migration yet — that happens in Task 14 after deploy)**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run typecheck`
Expected: PASS.

```bash
cd /Users/johnhuang/projects/testomniac_api
git add src/scripts/migrate-credentials-to-userdata.ts src/scripts/migrate-credentials-to-userdata.test.ts
git commit -m "feat: migration entityCredentials -> userData.credential

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(The API deploys via its own CI on push to main; ensure `bun test` / typecheck are green before relying on the deploy.)

---

### Task 11: Server runner passes userData (testomniac_runner)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_runner/src/orchestrator.ts` (fetch userData, pass `RunConfig.userData`)

**Interfaces:**
- Consumes: `RunConfig.userData` (Task 4, published in Task 6); the api `GET /test-environments/:id/user-data`.

- [ ] **Step 1: Fetch userData and pass it through**

In `/Users/johnhuang/projects/testomniac_runner/src/orchestrator.ts`, where `runTestRun(...)` is called (line ~109), add a fetch of userData by `testEnvironmentId` (when present) before the call, and pass it as `userData`. Use the existing `api` client / fetch pattern already used for run config. Concretely, before the `runTestRun` call:

```ts
    let userData: import("@sudobility/testomniac_types").UserData | undefined;
    if (options.testEnvironmentId) {
      try {
        const res = await fetch(
          `${config.apiUrl}/api/v1/test-environments/${options.testEnvironmentId}/user-data`,
          { headers: { "x-scanner-key": config.scannerApiKey } }
        );
        const json = await res.json();
        if (json?.success) userData = json.data?.data ?? undefined;
      } catch {
        // non-fatal: scan proceeds without variables (login steps will fail
        // the step if a {credential.*} is referenced)
      }
    }
```

and add `userData,` to the `RunConfig` object passed to `runTestRun`. (Match the actual auth header the scanner uses — check how this file authenticates other API reads; `x-scanner-key` per CLAUDE.md's `SCANNER_API_KEY`.) Confirm `options.testEnvironmentId` is available; if not, thread it from the run record like other run fields.

- [ ] **Step 2: Typecheck + commit**

Run: `cd /Users/johnhuang/projects/testomniac_runner && bun run typecheck`
Expected: PASS.

```bash
cd /Users/johnhuang/projects/testomniac_runner
git add src/orchestrator.ts
git commit -m "feat: fetch and pass userData into RunConfig

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Extension background passes userData (testomniac_extension)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_extension/src/background/index.ts`

**Interfaces:**
- Consumes: `RunConfig.userData` (Task 4); api `GET /test-environments/:id/user-data`.

- [ ] **Step 1: Replace the entity-credentials fetch with a userData fetch**

In `/Users/johnhuang/projects/testomniac_extension/src/background/index.ts`, the block around lines 823–874 fetches `/api/v1/entity-credentials/:id` and builds `credentialData`. Replace it with a fetch of the environment's userData (using `run.testEnvironmentId`):

```ts
    let userData: import('@sudobility/testomniac_runner_service').UserData | undefined;
    const envId = run.testEnvironmentId;
    if (envId) {
      try {
        const udRes = await fetch(
          `${apiUrl}/api/v1/test-environments/${envId}/user-data`,
          { headers: apiKey ? { 'x-api-key': apiKey } : {} }
        );
        const udJson = await udRes.json();
        if (udJson?.success) userData = udJson.data?.data ?? undefined;
      } catch (err) {
        ERR('Failed to fetch userData', err);
      }
    }
```

(`UserData` is re-exported from `@sudobility/testomniac_runner_service` per Task 3's index export, or import from `@sudobility/testomniac_types`; use whichever the extension already depends on.)

- [ ] **Step 2: Pass userData into runTestRun; drop credential plumbing**

In the `runTestRun(...)` config object (around line 905–912), replace `loginUrl`/`entityCredentialId`/`credentials` wiring with `userData`:

```ts
        loginUrl: resolvedLoginUrl,
        userData,
```

Remove the now-unused `credentialData`/`credentialId` variables and the `loginOptions.entityCredentialId`/`continueWithLogin` paths that only fed credentials. Keep `loginUrl` resolution.

- [ ] **Step 3: Type-check + commit**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run type-check && bun run lint`
Expected: PASS (remove any symbols lint flags as unused, e.g. the old `credentialData` type).

```bash
cd /Users/johnhuang/projects/testomniac_extension
git add src/background/index.ts
git commit -m "feat: background fetches userData and passes it to runTestRun

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Extension UI — userData editor (testomniac_extension)

**Files:**
- Modify: `/Users/johnhuang/projects/testomniac_extension/src/sidepanel/SidePanel.tsx`

**Interfaces:**
- Consumes: api `GET`/`PUT /test-environments/:id/user-data`; the resolved `testEnvironmentId` (from `POST /test-environments/resolve`, already called in the scan flow).

- [ ] **Step 1: Replace credential state + form with userData editing**

In `SidePanel.tsx`:
- Remove the `EntityCredentialOption`/credential list state (`credentials`, `selectedCredentialId`, `loadingCredentials`, `fetchCredentials`, the create-credential form block ~2059–2167) and the `entityCredentialId` wiring in `START_SCAN`.
- Add state: `const [userDataJson, setUserDataJson] = useState('{}')`, `const [userDataError, setUserDataError] = useState<string | null>(null)`, and convenience fields `credEmail`, `credPassword`.
- After the environment is resolved (when `testEnvironmentId` is known), fetch the blob:

```ts
const loadUserData = useCallback(async (testEnvironmentId: number) => {
  const res = await fetch(
    `${API_URL}/api/v1/test-environments/${testEnvironmentId}/user-data`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json();
  if (json?.success) {
    const data = json.data?.data ?? {};
    setUserDataJson(JSON.stringify(data, null, 2));
    setCredEmail(data.credential?.email ?? '');
    setCredPassword(data.credential?.password ?? '');
  }
}, [token]);
```

- [ ] **Step 2: Render the editor + credential sub-form + save**

Add UI (in the login/config section) with:
- a `<textarea>` bound to `userDataJson` (the full blob),
- a credential sub-form (email + password) that, on change, merges into the JSON,
- a "Save" button that parses the JSON (catching parse errors into `userDataError`), merges the credential sub-form into `data.credential`, and PUTs:

```ts
const saveUserData = async (testEnvironmentId: number) => {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(userDataJson || '{}');
  } catch (e) {
    setUserDataError('Invalid JSON');
    return;
  }
  if (credEmail || credPassword) {
    data.credential = { ...(data.credential as object), email: credEmail, password: credPassword };
  }
  const res = await fetch(
    `${API_URL}/api/v1/test-environments/${testEnvironmentId}/user-data`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data }),
    }
  );
  const json = await res.json();
  if (json?.success) {
    setUserDataError(null);
    setUserDataJson(JSON.stringify(json.data.data, null, 2));
  } else {
    setUserDataError(normalizeApiError(json, 'Failed to save user data'));
  }
};
```

- [ ] **Step 3: Type-check + lint + build**

Run: `cd /Users/johnhuang/projects/testomniac_extension && bun run type-check && bun run lint && bun run build`
Expected: all PASS, `dist/` built.

- [ ] **Step 4: Commit**

```bash
cd /Users/johnhuang/projects/testomniac_extension
git add src/sidepanel/SidePanel.tsx
git commit -m "feat: userData editor + credential sub-form in side panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Publish, run migration, end-to-end verification

**Files:** none (rollout + verification).

- [ ] **Step 1: Publish runner + propagate to extension**

For `testomniac_runner` and `testomniac_extension`, bump each `package.json` version (uncommitted) and run `cd /Users/johnhuang/projects/testomniac_app && ./scripts/push_all.sh`. Verify each repo's latest CI run is `success` (`gh run list --limit 1`); on failure, `gh run view <id> --log-failed`, fix, re-run. (Extension may not publish to npm but its commits must be pushed; `rm -rf node_modules/.vite` after dep bumps.)

- [ ] **Step 2: Confirm the API is deployed with the new routes + generator**

Run: `curl -s -o /dev/null -w "%{http_code}" "$API_URL/api/v1/test-environments/1/user-data"` (with a valid auth header)
Expected: `200` (or `403/404` for scoping) — not `404 route not found`.

- [ ] **Step 3: Run the credential migration (once)**

Run: `cd /Users/johnhuang/projects/testomniac_api && bun run src/scripts/migrate-credentials-to-userdata.ts`
Expected: completes without error; spot-check a `user_data` row has `data.credential` populated for an environment whose entity had a credential. Re-running is safe (idempotent).

- [ ] **Step 4: Verify variable resolution end-to-end (extension)**

Reload the extension (`chrome://extensions` off/on). For an environment with `userData.credential` set, scan a login page. Confirm:
- Login authenticates (the `Login: correct credentials` interaction succeeds).
- The stored interaction `stepsJson` for the correct-login test contains `{credential.email}`/`{credential.password}` — **not** the real password (inspect via the API/DB).
- The debug log shows `<resolved {credential.password}>`, never the secret.

- [ ] **Step 5: Verify failure behavior**

For an environment with **no** `credential` in userData, scan a login page. Confirm the correct-login step **fails** with an unresolved-variable error (not a blank/literal submission), per the chosen semantics.

---

## Notes for the implementer

- **Order is load-bearing:** Tasks 1–2 (types) and 3–6 (runner_service) must publish before the api/runner/extension tasks can import `UserData`/`RunConfig.userData`. Don't add local source aliases (CLAUDE.md).
- **push_all needs an uncommitted change** to detect a repo, and its validation is **typecheck + build only** — CI runs the tests and is the real publish gate. Keep new api/runner_service tests pure (no DB/browser) so CI's `bun test`/`vitest run` passes.
- **Secrets:** the whole point is that `stepsJson` never contains a real password. If you ever see a literal secret in a generated step, that's a bug — the value must be a `{credential.*}` token resolved only at runtime.
- **`FormInfo.submitSelector`:** Task 5/9 prefer a detected submit-button selector for hover→click. If the login detector doesn't expose one, the `pressKey Enter` fallback must remain correct; adding `submitSelector` to the detector is a reasonable small extension but keep the fallback.
- **Encryption at rest** for `userData.data` is explicitly out of scope (separate follow-up).
```
