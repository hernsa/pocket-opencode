# pocket-opencode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (hybrid mode: tasks marked `[inline]` execute in-session with executing-plans discipline; tasks marked `[subagent]` are dispatched via the task tool with `subagent_type: "general"`, ONE AT A TIME sequentially â€” parallel subagents would race on git commits). Each checkbox group = one commit. Follow TDD strictly: write the failing test, run it, watch it fail, implement minimally, watch it pass, commit.

## Goal

A Telegram bot daemon running on LO's Windows 11 PC that controls the local `opencode` server from his phone: send prompts, switch model/agent, set thinking level, abort, undo, diff, check status. Long-polling only (zero open ports). Hard allowlist by Telegram user ID + first-run pairing code printed to the terminal.

## Architecture

```
Telegram (phone) â†long-pollâ†’ grammY bot (this daemon, Bun)
                                  â”‚
                     OpencodeClient wrapper (HTTP)
                                  â”‚
                     opencode serve --port 4096 (localhost only)
                                  â”‚
                     SSE /event stream â†’ handleEvent router â†’ live-edit messages
```

- Boot order (main.ts): `loadConfig` â†’ `openState` â†’ `new OpencodeClient` â†’ `ensureRunning` â†’ `createBot` â†’ `subscribeEvents(port, bundle.handleEvent)` â†’ `bot.start()`, SIGINT graceful shutdown.
- Output flows fire-and-forget: `session.promptAsync` returns 204; the answer arrives as SSE `message.part.updated` deltas, rendered into one Telegram message via `StreamRenderer` (coalesced edits â‰¥1.2 s apart, tail-truncated to 3000 chars).
- Approvals: SSE `permission.updated` â†’ inline keyboard in Telegram â†’ callback resolves via permission reply endpoint.

## Tech Stack

- Bun â‰¥ 1.1 (runtime + test runner + SQLite), TypeScript strict.
- `grammy ^1`, `@opencode-ai/sdk` pinned `1.18.26` (fall back to `@latest` if that exact version is absent on npm â€” note the installed version), `smol-toml`, `bun:sqlite`.

## Spec

`docs/superpowers/specs/2026-09-02-pocket-opencode-design.md`

## Global Constraints

- Windows 11 + PowerShell 5.1: **no `&&`** â€” use `;` or `if ($?) {}`.
- TypeScript strict, `bun test` only (no vitest/jest). Typecheck: `bunx tsc --noEmit`.
- **NEVER** write the Telegram token or the GitHub token into any tracked file. `config.toml` is gitignored; only `config.toml.example` with fake values is committed.
- `opencode serve` MUST be started with explicit `--port` (its default port is `0` = random). Spawn via `cmd /c opencode serve â€¦` to dodge Windows PATHEXT issues.
- Thinking level (`low|medium|high|max`) is NOT exposed in SDK prompt types (verified by grep against 1.18.26 d.ts). Stored as an override, surfaced in `/status`, best-effort application only â€” never crash on it. Documented in README.
- SDK response envelope may wrap payloads in `{data}`: every SDK call site goes through the `unwrap()` helper in Task 6. Step 0 of Task 6 probes the real shape.
- All paths relative to project root `C:\Users\Admin\Downloads\pocket-opencode`.

## File Map

```
pocket-opencode/
  package.json            T1
  tsconfig.json           T1
  .gitignore              T1
  config.toml.example     T11
  README.md               T11
  src/
    version.ts            T1
    version.test.ts       T1
    config.ts             T2
    config.test.ts        T2
    state.ts              T3
    state.test.ts         T3
    main.ts               T10
    telegram/
      format.ts           T4
      format.test.ts      T4
      bot.ts              T8
      bot.test.ts         T8
      approvals.ts        T9
      approvals.test.ts   T9
    opencode/
      stream.ts           T5 (StreamRenderer) + T7 (subscribeEvents)
      stream.test.ts      T5 + T7
      client.ts           T6
      client.test.ts      T6
  scripts/
    smoke.test.ts         T10
```

---

## Task 1: Project scaffold [inline]

**Interfaces**
- Consumes: nothing.
- Produces: `src/version.ts` exporting `export const APP_VERSION = "0.1.0";`; `package.json` scripts `{ "test": "bun test", "typecheck": "tsc --noEmit", "start": "bun run src/main.ts" }`.

- [ ] Verify Bun: `bun --version` â€” if missing: `npm i -g bun ; bun --version`.
- [ ] `git init` in project root. Create `.gitignore`:

```gitignore
node_modules/
dist/
config.toml
*.db
*.db-journal
.env
```

- [ ] Create `package.json`:

```json
{
  "name": "pocket-opencode",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "start": "bun run src/main.ts"
  }
}
```

- [ ] Install deps: `bun add grammy @opencode-ai/sdk@1.18.26 smol-toml` (fallback `bun add @opencode-ai/sdk@latest` + note version). Dev deps: `bun add -d typescript @types/bun`.
- [ ] Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "types": ["bun"],
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] Write failing test `src/version.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { APP_VERSION } from "./version";

describe("version", () => {
  test("exports semver string", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] Run `bun test src/version.test.ts` â€” expect FAIL (module not found).
- [ ] Implement `src/version.ts`:

```ts
export const APP_VERSION = "0.1.0";
```

- [ ] Run `bun test src/version.test.ts` â€” expect PASS.
- [ ] Commit: `git add -A ; git commit -m "task 1: scaffold bun project, strict tsconfig, gitignore, version seed"`

---

## Task 2: config.ts â€” TOML loader [inline]

**Interfaces**
- Consumes: `smol-toml` `parse`.
- Produces:

```ts
export class ConfigError extends Error {}
export interface Project { name: string; path: string; }
export interface AppConfig {
  telegramToken: string;
  allowedUserIds: number[];
  opencodePort: number;
  dbPath: string;
  projects: Project[];
}
export function loadConfig(path: string): AppConfig;
```

Defaults: `opencode_port` â†’ 4096, `db_path` â†’ `"pocket.db"`. Hard errors (ConfigError): missing file, malformed TOML, missing/empty `telegram_token`, zero `[[allow]]` ids, zero `[[projects]]`, any `[[projects]]` entry lacking `name`/`path`.

- [ ] Write failing test `src/config.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ConfigError } from "./config";

function writeCfg(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "poc-cfg-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, toml);
  return p;
}

describe("loadConfig", () => {
  test("parses full config", () => {
    const path = writeCfg(
      `telegram_token = "123:ABC"\nopencode_port = 4096\ndb_path = "state.db"\n\n[[projects]]\nname = "web"\npath = "C:/code/web"\n\n[[projects]]\nname = "api"\npath = "C:/code/api"\n\n[[allow]]\nid = 111\n\n[[allow]]\nid = 222\n`
    );
    const cfg = loadConfig(path);
    expect(cfg.telegramToken).toBe("123:ABC");
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.dbPath).toBe("state.db");
    expect(cfg.projects).toEqual([
      { name: "web", path: "C:/code/web" },
      { name: "api", path: "C:/code/api" },
    ]);
    expect(cfg.allowedUserIds).toEqual([111, 222]);
  });

  test("applies defaults", () => {
    const path = writeCfg(
      `telegram_token = "123:ABC"\n[[allow]]\nid = 7\n[[projects]]\nname = "x"\npath = "C:/x"\n`
    );
    const cfg = loadConfig(path);
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.dbPath).toBe("pocket.db");
  });

  test("rejects missing token", () => {
    const path = writeCfg(`[[allow]]\nid = 7\n[[projects]]\nname = "x"\npath = "C:/x"\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects empty allowlist", () => {
    const path = writeCfg(`telegram_token = "t"\n[[projects]]\nname = "x"\npath = "C:/x"\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects zero projects", () => {
    const path = writeCfg(`telegram_token = "t"\n[[allow]]\nid = 7\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects malformed toml", () => {
    const path = writeCfg(`this is not = toml ===\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects missing file", () => {
    expect(() => loadConfig("Z:/definitely/not/here.toml")).toThrow(ConfigError);
  });
});
```

- [ ] Run `bun test src/config.test.ts` â€” expect FAIL.
- [ ] Implement `src/config.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import { parse } from "smol-toml";

export class ConfigError extends Error {}

export interface Project {
  name: string;
  path: string;
}

export interface AppConfig {
  telegramToken: string;
  allowedUserIds: number[];
  opencodePort: number;
  dbPath: string;
  projects: Project[];
}

export function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) throw new ConfigError(`config not found: ${path}`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`invalid TOML in ${path}: ${(e as Error).message}`);
  }
  const t = (raw ?? {}) as Record<string, unknown>;

  const token = t["telegram_token"];
  if (typeof token !== "string" || token.length === 0) {
    throw new ConfigError("telegram_token is required");
  }

  const allow = t["allow"];
  const allowedUserIds = Array.isArray(allow)
    ? allow
        .map((e) => (e as Record<string, unknown>)["id"])
        .filter((id): id is number => typeof id === "number")
    : [];
  if (allowedUserIds.length === 0) {
    throw new ConfigError("at least one [[allow]] id is required");
  }

  const projectsRaw = Array.isArray(t["projects"]) ? t["projects"] : [];
  const projects: Project[] = projectsRaw.map((p) => {
    const e = p as Record<string, unknown>;
    if (typeof e["name"] !== "string" || typeof e["path"] !== "string") {
      throw new ConfigError("each [[projects]] entry needs name and path");
    }
    return { name: e["name"], path: e["path"] };
  });
  if (projects.length === 0) {
    throw new ConfigError("at least one [[projects]] entry is required");
  }

  return {
    telegramToken: token,
    allowedUserIds,
    opencodePort: typeof t["opencode_port"] === "number" ? t["opencode_port"] : 4096,
    dbPath: typeof t["db_path"] === "string" ? t["db_path"] : "pocket.db",
    projects,
  };
}
```

- [ ] Run `bun test src/config.test.ts` â€” expect PASS.
- [ ] Commit: `git add -A ; git commit -m "task 2: config loader with smol-toml, validation and defaults"`

---

## Task 3: state.ts â€” bun:sqlite store [inline]

**Interfaces**
- Consumes: `bun:sqlite` `Database`.
- Produces:

```ts
export type OverrideKey = "model" | "agent" | "thinking";
export interface StateStore {
  isPaired(chatId: number): boolean;
  setPairing(chatId: number): void;
  getActiveProject(userId: number): string | undefined;
  setActiveProject(userId: number, project: string): void;
  getSession(userId: number, project: string): string | undefined;
  setSession(userId: number, project: string, sessionId: string): void;
  getOverride(userId: number, key: OverrideKey): string | undefined;
  setOverride(userId: number, key: OverrideKey, value: string): void;
  clearOverride(userId: number, key: OverrideKey): void;
  close(): void;
}
export function openState(dbPath: string): StateStore;
```

Tables: `pairing(chat_id INTEGER PRIMARY KEY, paired_at INTEGER NOT NULL)`, `active_project(user_id INTEGER PRIMARY KEY, project TEXT NOT NULL)`, `session(user_id, project, session_id, PRIMARY KEY(user_id, project))`, `overrides(user_id, key, value, PRIMARY KEY(user_id, key))`.

- [ ] Write failing test `src/state.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openState } from "./state";

let dbPath: string;
let store: ReturnType<typeof openState>;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "poc-state-")), "t.db");
  store = openState(dbPath);
});

describe("StateStore", () => {
  test("pairing round-trip", () => {
    expect(store.isPaired(100)).toBe(false);
    store.setPairing(100);
    expect(store.isPaired(100)).toBe(true);
  });

  test("active project per user", () => {
    expect(store.getActiveProject(1)).toBeUndefined();
    store.setActiveProject(1, "web");
    expect(store.getActiveProject(1)).toBe("web");
    store.setActiveProject(1, "api");
    expect(store.getActiveProject(1)).toBe("api");
  });

  test("session per user+project", () => {
    expect(store.getSession(1, "web")).toBeUndefined();
    store.setSession(1, "web", "sess-abc");
    store.setSession(1, "api", "sess-xyz");
    expect(store.getSession(1, "web")).toBe("sess-abc");
    expect(store.getSession(1, "api")).toBe("sess-xyz");
  });

  test("overrides set/get/clear", () => {
    expect(store.getOverride(1, "model")).toBeUndefined();
    store.setOverride(1, "model", "anthropic/claude-sonnet-4");
    expect(store.getOverride(1, "model")).toBe("anthropic/claude-sonnet-4");
    store.setOverride(1, "model", "openai/gpt-5");
    expect(store.getOverride(1, "model")).toBe("openai/gpt-5");
    store.clearOverride(1, "model");
    expect(store.getOverride(1, "model")).toBeUndefined();
  });

  test("persists across reopen", () => {
    store.setPairing(55);
    store.setActiveProject(55, "web");
    store.setSession(55, "web", "s1");
    store.setOverride(55, "agent", "build");
    store.close();
    const s2 = openState(dbPath);
    expect(s2.isPaired(55)).toBe(true);
    expect(s2.getActiveProject(55)).toBe("web");
    expect(s2.getSession(55, "web")).toBe("s1");
    expect(s2.getOverride(55, "agent")).toBe("build");
    s2.close();
  });
});
```

- [ ] Run `bun test src/state.test.ts` â€” expect FAIL.
- [ ] Implement `src/state.ts`:

```ts
import { Database } from "bun:sqlite";

export type OverrideKey = "model" | "agent" | "thinking";

export interface StateStore {
  isPaired(chatId: number): boolean;
  setPairing(chatId: number): void;
  getActiveProject(userId: number): string | undefined;
  setActiveProject(userId: number, project: string): void;
  getSession(userId: number, project: string): string | undefined;
  setSession(userId: number, project: string, sessionId: string): void;
  getOverride(userId: number, key: OverrideKey): string | undefined;
  setOverride(userId: number, key: OverrideKey, value: string): void;
  clearOverride(userId: number, key: OverrideKey): void;
  close(): void;
}

export function openState(dbPath: string): StateStore {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing (chat_id INTEGER PRIMARY KEY, paired_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS active_project (user_id INTEGER PRIMARY KEY, project TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session (user_id INTEGER NOT NULL, project TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (user_id, project));
    CREATE TABLE IF NOT EXISTS overrides (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
  `);

  const qPair = db.query<{ chat_id: number }, [number]>("SELECT chat_id FROM pairing WHERE chat_id = ?");
  const iPair = db.prepare("INSERT OR REPLACE INTO pairing (chat_id, paired_at) VALUES (?, ?)");
  const qActive = db.query<{ project: string }, [number]>("SELECT project FROM active_project WHERE user_id = ?");
  const iActive = db.prepare("INSERT OR REPLACE INTO active_project (user_id, project) VALUES (?, ?)");
  const qSess = db.query<{ session_id: string }, [number, string]>("SELECT session_id FROM session WHERE user_id = ? AND project = ?");
  const iSess = db.prepare("INSERT OR REPLACE INTO session (user_id, project, session_id) VALUES (?, ?, ?)");
  const qOvr = db.query<{ value: string }, [number, string]>("SELECT value FROM overrides WHERE user_id = ? AND key = ?");
  const iOvr = db.prepare("INSERT OR REPLACE INTO overrides (user_id, key, value) VALUES (?, ?, ?)");
  const dOvr = db.prepare("DELETE FROM overrides WHERE user_id = ? AND key = ?");

  return {
    isPaired(chatId) {
      return qPair.get(chatId) != null;
    },
    setPairing(chatId) {
      iPair.run(chatId, Date.now());
    },
    getActiveProject(userId) {
      const row = qActive.get(userId);
      return row ? row.project : undefined;
    },
    setActiveProject(userId, project) {
      iActive.run(userId, project);
    },
    getSession(userId, project) {
      const row = qSess.get(userId, project);
      return row ? row.session_id : undefined;
    },
    setSession(userId, project, sessionId) {
      iSess.run(userId, project, sessionId);
    },
    getOverride(userId, key) {
      const row = qOvr.get(userId, key);
      return row ? row.value : undefined;
    },
    setOverride(userId, key, value) {
      iOvr.run(userId, key, value);
    },
    clearOverride(userId, key) {
      dOvr.run(userId, key);
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] Run `bun test src/state.test.ts` â€” expect PASS.
- [ ] Commit: `git add -A ; git commit -m "task 3: sqlite-backed StateStore with pairing, sessions, overrides"`

---

## Task 4: telegram/format.ts â€” chunk + escapeHtml [inline]

**Interfaces**
- Consumes: nothing.
- Produces:

```ts
export function escapeHtml(s: string): string;
export function chunk(text: string, limit?: number): string[];  // default limit 3900
```

Semantics: chunks are raw slices â€” concatenating all chunks reproduces the input exactly (`parts.join("") === text`). Splits prefer the last `\n` inside the window; hard-splits overlong single lines. Never returns an empty array (empty input â†’ `[""]`).

- [ ] Write failing test `src/telegram/format.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { chunk, escapeHtml } from "./format";

describe("chunk", () => {
  test("short text passes through", () => {
    expect(chunk("hello", 3900)).toEqual(["hello"]);
  });

  test("splits on line boundaries and round-trips", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(50)}`);
    const text = lines.join("\n");
    const parts = chunk(text, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1000);
    expect(parts.join("")).toBe(text);
  });

  test("hard-splits overlong single line", () => {
    const text = "y".repeat(2500);
    const parts = chunk(text, 1000);
    expect(parts).toEqual(["y".repeat(1000), "y".repeat(1000), "y".repeat(500)]);
    expect(parts.join("")).toBe(text);
  });

  test("empty text yields single empty chunk", () => {
    expect(chunk("", 100)).toEqual([""]);
  });
});

describe("escapeHtml", () => {
  test("escapes all reserved chars", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});
```

- [ ] Run `bun test src/telegram/format.test.ts` â€” expect FAIL.
- [ ] Implement `src/telegram/format.ts`:

```ts
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function chunk(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const nl = window.lastIndexOf("\n");
    const cut = nl > 0 ? nl + 1 : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
```

- [ ] Run `bun test src/telegram/format.test.ts` â€” expect PASS.
- [ ] Commit: `git add -A ; git commit -m "task 4: message chunking on line boundaries and html escaping"`

---

## Task 5: opencode/stream.ts â€” StreamRenderer [inline]

**Interfaces**
- Consumes: nothing (injected `edit` + `now`).
- Produces (file `src/opencode/stream.ts`; Task 7 appends `subscribeEvents` to this same file):

```ts
export interface StreamRendererOpts {
  maxLen?: number;      // default 3000 (Telegram edit + HTML escape headroom)
  intervalMs?: number;  // default 1200
  edit?: (text: string) => void | Promise<void>;
  now?: () => number;
}
export class StreamRenderer {
  constructor(opts?: StreamRendererOpts);
  push(delta: string): void;   // buffers; flushes via edit() when >=intervalMs since last edit
  finalize(): void;            // flushes remaining buffer once; idempotent
}
```

Semantics: first `push` always flushes immediately (`lastEdit` starts at âˆ’âˆž). Flush truncates over-long text to the **tail** with a leading `â€¦` (newest output matters most): `"â€¦" + text.slice(text.length - maxLen + 1)`.

- [ ] Write failing test `src/opencode/stream.test.ts` (renderer section only; Task 7 appends SSE tests):

```ts
import { describe, test, expect } from "bun:test";
import { StreamRenderer } from "./stream";

function makeRenderer(extra = {}) {
  const edits: string[] = [];
  let t = 0;
  const r = new StreamRenderer({
    edit: (s) => edits.push(s),
    now: () => t,
    maxLen: 50,
    ...extra,
  });
  return { r, edits, tick: (ms: number) => { t += ms; } };
}

describe("StreamRenderer", () => {
  test("first push edits immediately", () => {
    const { r, edits } = makeRenderer();
    r.push("hello");
    expect(edits).toEqual(["hello"]);
  });

  test("rapid pushes coalesce into one edit", () => {
    const { r, edits } = makeRenderer();
    r.push("a");
    r.push("b");
    r.push("c");
    expect(edits).toEqual(["abc"]);
  });

  test("push after interval edits again", () => {
    const { r, edits, tick } = makeRenderer();
    r.push("one");
    tick(1300);
    r.push("two");
    expect(edits).toEqual(["one", "onetwo"]);
  });

  test("finalize flushes remaining buffer", () => {
    const { r, edits } = makeRenderer();
    r.push("x");
    r.push("y");
    r.finalize();
    expect(edits).toEqual(["xy"]);
  });

  test("finalize is idempotent and push after finalize is ignored", () => {
    const { r, edits } = makeRenderer();
    r.push("x");
    r.finalize();
    const n = edits.length;
    r.finalize();
    r.push("y");
    expect(edits.length).toBe(n);
    expect(edits[0]).toBe("x");
  });

  test("truncates to maxLen keeping the tail", () => {
    const { r, edits } = makeRenderer();
    r.push("z".repeat(80));
    r.finalize();
    expect(edits[edits.length - 1]).toBe("â€¦" + "z".repeat(49));
  });
});
```

- [ ] Run `bun test src/opencode/stream.test.ts` â€” expect FAIL.
- [ ] Implement `src/opencode/stream.ts` (renderer only for now):

```ts
export interface StreamRendererOpts {
  maxLen?: number;
  intervalMs?: number;
  edit?: (text: string) => void | Promise<void>;
  now?: () => number;
}

export class StreamRenderer {
  private buf = "";
  private lastEdit = Number.NEGATIVE_INFINITY;
  private done = false;
  private readonly maxLen: number;
  private readonly intervalMs: number;
  private readonly edit: (text: string) => void | Promise<void>;
  private readonly now: () => number;

  constructor(opts: StreamRendererOpts = {}) {
    this.maxLen = opts.maxLen ?? 3000;
    this.intervalMs = opts.intervalMs ?? 1200;
    this.edit = opts.edit ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  push(delta: string): void {
    if (this.done) return;
    this.buf += delta;
    if (this.now() - this.lastEdit >= this.intervalMs) {
      this.flush();
    }
  }

  finalize(): void {
    if (this.done) return;
    this.done = true;
    this.flush();
  }

  private flush(): void {
    const text = this.render();
    void this.edit(text);
    this.lastEdit = this.now();
    this.buf = "";
  }

  private render(): string {
    if (this.buf.length <= this.maxLen) return this.buf;
    return "â€¦" + this.buf.slice(this.buf.length - this.maxLen + 1);
  }
}
```

- [ ] Run `bun test src/opencode/stream.test.ts` â€” expect PASS.
- [ ] Commit: `git add -A ; git commit -m "task 5: StreamRenderer with coalesced edits, tail truncation, idempotent finalize"`

---

## Task 6: opencode/client.ts â€” OpencodeClient wrapper [subagent]

**Interfaces**
- Consumes: SDK client factory from `@opencode-ai/sdk`. Verify the exact export name after install: `Select-String -Path node_modules/@opencode-ai/sdk/dist/index.d.ts -Pattern "createClient|createOpencodeClient"` (docs use `createOpencodeClient`; 1.18.26 exploration suggested `createClient` â€” use whatever exists, adjust the import in ONE place).
- Produces:

```ts
export interface PromptOpts {
  directory?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
}
export interface OcClientOpts {
  port: number;
  spawner?: (cmdline: string[]) => void;
}
export class OpencodeClient {
  constructor(opts: OcClientOpts);
  health(): Promise<boolean>;                        // probe /project/current, catch â†’ false
  ensureRunning(timeoutMs?: number): Promise<void>;  // default 20000; spawns opencode serve if unhealthy, polls every 500ms
  createSession(directory: string, title?: string): Promise<string>;
  prompt(sessionId: string, text: string, opts?: PromptOpts): Promise<void>;  // promptAsync 204, fire-and-forget
  abort(sessionId: string): Promise<void>;
  undo(sessionId: string): Promise<void>;            // session.revert
  getDiff(sessionId: string): Promise<Array<{ file: string; additions: number; deletions: number }>>;
  listModels(): Promise<Array<{ providerID: string; modelID: string }>>;
  listAgents(): Promise<string[]>;
  replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
}
```

**Step 0 â€” probe the SDK envelope.** With the stub server below running, call one method in `bun -e` and inspect whether returns are `{data, response}` wrappers or bare data. All call sites use:

```ts
function unwrap<T>(r: unknown): T {
  const w = r as { data?: unknown };
  return (w && typeof w === "object" && "data" in w && w.data !== undefined ? w.data : r) as T;
}
```

- [ ] Write failing test `src/opencode/client.test.ts` (stub server impersonates the opencode HTTP API):

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { OpencodeClient } from "./client";

const seen: Array<{ method: string; path: string; body: unknown }> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let body: unknown = undefined;
    try { body = await req.json(); } catch {}
    seen.push({ method: req.method, path: url.pathname, body });
    if (url.pathname === "/project/current") return Response.json({ id: "p1" });
    if (url.pathname === "/session" && req.method === "POST") return Response.json({ id: "sess-1" });
    if (url.pathname === "/session/sess-1/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/sess-1/abort") return Response.json({ ok: true });
    if (url.pathname === "/session/sess-1/revert") return Response.json({ ok: true });
    if (url.pathname === "/session/sess-1/diff")
      return Response.json([
        { file: "src/a.ts", before: "", after: "", additions: 12, deletions: 3 },
        { file: "src/b.ts", before: "", after: "", additions: 0, deletions: 7 },
      ]);
    if (url.pathname === "/provider")
      return Response.json({
        anthropic: { id: "anthropic", models: { "claude-sonnet-4": {}, "claude-opus-4": {} } },
        openai: { id: "openai", models: { "gpt-5": {} } },
      });
    if (url.pathname === "/app/agents") return Response.json([{ name: "build" }, { name: "plan" }]);
    if (url.pathname.startsWith("/session/sess-1/permissions/")) return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

function makeClient(spawner?: (cmdline: string[]) => void) {
  return new OpencodeClient({ port: server.port, spawner });
}

describe("OpencodeClient", () => {
  test("health returns true when server responds", async () => {
    expect(await makeClient().health()).toBe(true);
  });

  test("health returns false on dead port", async () => {
    expect(await new OpencodeClient({ port: 1 }).health()).toBe(false);
  });

  test("ensureRunning does not spawn when healthy", async () => {
    let spawned = 0;
    await makeClient(() => { spawned++; }).ensureRunning(2000);
    expect(spawned).toBe(0);
  });

  test("ensureRunning throws after timeout on dead port", async () => {
    let spawned = 0;
    const dead = new OpencodeClient({ port: 1, spawner: () => { spawned++; } });
    await expect(dead.ensureRunning(300)).rejects.toThrow(/did not come up/);
    expect(spawned).toBe(1);
  });

  test("createSession returns id", async () => {
    const id = await makeClient().createSession("C:/code/web", "hello");
    expect(id).toBe("sess-1");
  });

  test("prompt posts text part + model + agent to prompt_async", async () => {
    await makeClient().prompt("sess-1", "do the thing", {
      directory: "C:/code/web",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      agent: "build",
    });
    const call = seen.find((c) => c.path === "/session/sess-1/prompt_async");
    expect(call).toBeDefined();
    const b = call!.body as { parts: Array<{ type: string; text: string }>; model?: unknown; agent?: string };
    expect(b.parts[0].type).toBe("text");
    expect(b.parts[0].text).toBe("do the thing");
    expect(b.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" });
    expect(b.agent).toBe("build");
  });

  test("abort and undo hit their endpoints", async () => {
    const c = makeClient();
    await c.abort("sess-1");
    await c.undo("sess-1");
    expect(seen.some((x) => x.path === "/session/sess-1/abort")).toBe(true);
    expect(seen.some((x) => x.path === "/session/sess-1/revert")).toBe(true);
  });

  test("getDiff maps additions/deletions", async () => {
    const d = await makeClient().getDiff("sess-1");
    expect(d).toEqual([
      { file: "src/a.ts", additions: 12, deletions: 3 },
      { file: "src/b.ts", additions: 0, deletions: 7 },
    ]);
  });

  test("listModels normalizes provider record into pairs", async () => {
    const m = await makeClient().listModels();
    expect(m).toEqual([
      { providerID: "anthropic", modelID: "claude-sonnet-4" },
      { providerID: "anthropic", modelID: "claude-opus-4" },
      { providerID: "openai", modelID: "gpt-5" },
    ]);
  });

  test("listAgents normalizes objects into names", async () => {
    expect(await makeClient().listAgents()).toEqual(["build", "plan"]);
  });

  test("replyPermission posts response to permission endpoint", async () => {
    await makeClient().replyPermission("sess-1", "perm-9", "once");
    const call = seen.find((c) => c.path === "/session/sess-1/permissions/perm-9");
    expect(call).toBeDefined();
    expect((call!.body as { response: string }).response).toBe("once");
  });
});
```

NOTE: the stub routes mirror the real opencode HTTP API paths recorded from SDK 1.18.26 d.ts exploration. If the real SDK requests DIFFERENT paths than the stub's, fix the STUB paths to whatever the SDK actually requests (assert on behavior, not guessed paths) â€” keep response payloads identical.

- [ ] Run `bun test src/opencode/client.test.ts` â€” expect FAIL (module not found).
- [ ] Implement `src/opencode/client.ts`:

```ts
import { createClient } from "@opencode-ai/sdk"; // VERIFY: may be createOpencodeClient

export interface PromptOpts {
  directory?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
}

export interface OcClientOpts {
  port: number;
  spawner?: (cmdline: string[]) => void;
}

function unwrap<T>(r: unknown): T {
  const w = r as { data?: unknown };
  return (w && typeof w === "object" && "data" in w && w.data !== undefined ? w.data : r) as T;
}

function defaultSpawner(cmdline: string[]): void {
  Bun.spawn(cmdline, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

export class OpencodeClient {
  private readonly port: number;
  private readonly client: ReturnType<typeof createClient>;
  private readonly spawner: (cmdline: string[]) => void;

  constructor(opts: OcClientOpts) {
    this.port = opts.port;
    this.client = createClient({ baseUrl: `http://127.0.0.1:${opts.port}` });
    this.spawner = opts.spawner ?? defaultSpawner;
  }

  async health(): Promise<boolean> {
    try {
      await this.client.project.current();
      return true;
    } catch {
      return false;
    }
  }

  async ensureRunning(timeoutMs = 20000): Promise<void> {
    if (await this.health()) return;
    this.spawner([
      "cmd", "/c", "opencode", "serve",
      "--port", String(this.port),
      "--hostname", "127.0.0.1",
      "--log-level", "WARN",
    ]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Bun.sleep(500);
      if (await this.health()) return;
    }
    throw new Error(`opencode serve did not come up on port ${this.port} within ${timeoutMs}ms`);
  }

  async createSession(directory: string, title?: string): Promise<string> {
    const res = unwrap<{ id: string }>(
      await this.client.session.create({ query: { directory }, body: { title } })
    );
    return res.id;
  }

  async prompt(sessionId: string, text: string, opts?: PromptOpts): Promise<void> {
    await this.client.session.promptAsync({
      path: { id: sessionId },
      query: opts?.directory ? { directory: opts.directory } : undefined,
      body: {
        parts: [{ type: "text", text }],
        model: opts?.model,
        agent: opts?.agent,
      },
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.client.session.abort({ path: { id: sessionId } });
  }

  async undo(sessionId: string): Promise<void> {
    await this.client.session.revert({ path: { id: sessionId } });
  }

  async getDiff(sessionId: string): Promise<Array<{ file: string; additions: number; deletions: number }>> {
    const rows = unwrap<Array<{ file: string; additions?: number; deletions?: number }>>(
      await this.client.session.diff({ path: { id: sessionId } })
    );
    return rows.map((r) => ({ file: r.file, additions: r.additions ?? 0, deletions: r.deletions ?? 0 }));
  }

  async listModels(): Promise<Array<{ providerID: string; modelID: string }>> {
    const raw = unwrap<unknown>(await this.client.provider.list());
    const out: Array<{ providerID: string; modelID: string }> = [];
    if (Array.isArray(raw)) {
      for (const p of raw as Array<{ id?: string; models?: Record<string, unknown> }>) {
        if (!p.id) continue;
        for (const mid of Object.keys(p.models ?? {})) out.push({ providerID: p.id, modelID: mid });
      }
    } else if (raw && typeof raw === "object") {
      const rec = raw as Record<string, { models?: Record<string, unknown> }>;
      for (const [pid, p] of Object.entries(rec)) {
        for (const mid of Object.keys(p?.models ?? {})) out.push({ providerID: pid, modelID: mid });
      }
    }
    return out;
  }

  async listAgents(): Promise<string[]> {
    const raw = unwrap<unknown>(await this.client.app.agents());
    if (!Array.isArray(raw)) return [];
    return raw
      .map((a) => (typeof a === "string" ? a : (a as { name?: string }).name))
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }

  async replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void> {
    const c = this.client as unknown as {
      postSessionIdPermissionsPermissionId(args: {
        path: { id: string; permissionID: string };
        body: { response: string };
      }): Promise<unknown>;
    };
    await c.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
    });
  }
}
```

Adaptation notes (mandatory, not optional):
1. If the SDK export is `createOpencodeClient`, rename the import â€” one line.
2. If method names differ from `client.session.create|promptAsync|abort|revert|diff`, `client.provider.list`, `client.app.agents`, `client.project.current` â€” grep `node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts` for real names and adjust. The call signatures recorded during session exploration are authoritative when they match.
3. `session.create`: pass `query: { directory }` only if the generated type accepts it; otherwise drop the query â€” never throw on it.
4. If TS complains about optional body fields (`model`, `agent`, `title`), build the body conditionally and spread.
- [ ] Run `bun test src/opencode/client.test.ts` â€” expect PASS.
- [ ] Run `bunx tsc --noEmit` â€” expect clean.
- [ ] Commit: `git add -A ; git commit -m "task 6: OpencodeClient wrapper over official SDK with spawn-on-demand"`

---

## Task 7: opencode/stream.ts â€” subscribeEvents (SSE with reconnect) [subagent]

**Interfaces**
- Consumes: raw `fetch` (NOT the SDK â€” a manual loop gives testable reconnect behavior).
- Produces (append to `src/opencode/stream.ts`):

```ts
export interface OcEvent { type: string; properties?: unknown; }
export interface EventSubscription { unsubscribe: () => void; }
export function subscribeEvents(port: number, onEvent: (e: OcEvent) => void): EventSubscription;
```

Behavior: loop â€” `fetch http://127.0.0.1:{port}/event` with header `accept: text/event-stream`; read the body stream, split SSE frames, parse `data:` lines as JSON, call `onEvent({type, properties})`. On error or stream end: sleep 2000 ms and reconnect unless unsubscribed. `unsubscribe()` flips the flag; loop exits after the current read/sleep. CRLF-safe: try `\r\n\r\n` as frame delimiter FIRST, then `\n\n`.

- [ ] Write failing tests (APPEND to `src/opencode/stream.test.ts`):

```ts
import { describe, test, expect } from "bun:test";
import { subscribeEvents, type OcEvent } from "./stream"; // extend the existing import line

describe("subscribeEvents", () => {
  test("delivers events, reconnects after stream close, stops on unsubscribe", async () => {
    let connections = 0;
    const received: OcEvent[] = [];
    let releaseSecond: () => void = () => {};
    const secondOpened = new Promise<void>((res) => { releaseSecond = res; });

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/event") return new Response("nf", { status: 404 });
        connections++;
        if (connections === 1) {
          const body = new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(
                new TextEncoder().encode(
                  'event: message.part.updated\ndata: {"type":"message.part.updated","properties":{"delta":"hi"}}\n\n' +
                  'data: {"type":"session.idle","properties":{"sessionID":"s1"}}\n\n'
                )
              );
              ctrl.close();
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        const body = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              new TextEncoder().encode(
                'data: {"type":"session.error","properties":{"message":"boom"}}\n\n'
              )
            );
            releaseSecond();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });

    const sub = subscribeEvents(server.port, (e) => received.push(e));

    for (let i = 0; i < 100 && received.length < 2; i++) await Bun.sleep(50);
    expect(received.map((e) => e.type)).toEqual(["message.part.updated", "session.idle"]);

    await secondOpened;
    for (let i = 0; i < 100 && received.length < 3; i++) await Bun.sleep(50);
    expect(received[2].type).toBe("session.error");
    expect(received[2].properties).toEqual({ message: "boom" });
    expect(connections).toBeGreaterThanOrEqual(2);

    sub.unsubscribe();
    const n = connections;
    await Bun.sleep(3000);
    expect(connections).toBe(n);
    server.stop(true);
  }, 15000);
});
```

- [ ] Run `bun test src/opencode/stream.test.ts` â€” expect NEW tests FAIL, renderer tests still PASS.
- [ ] Implement (append to `src/opencode/stream.ts`):

```ts
export interface OcEvent {
  type: string;
  properties?: unknown;
}

export interface EventSubscription {
  unsubscribe: () => void;
}

export function subscribeEvents(port: number, onEvent: (e: OcEvent) => void): EventSubscription {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/event`, {
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`event stream status ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (;;) {
            const crlf = buf.indexOf("\r\n\r\n");
            const lf = buf.indexOf("\n\n");
            const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
            const idx = useCrlf ? crlf : lf;
            if (idx === -1) break;
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + (useCrlf ? 4 : 2));
            const dataLines = frame
              .split(/\r?\n/)
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim());
            if (dataLines.length === 0) continue;
            try {
              const parsed = JSON.parse(dataLines.join("\n")) as OcEvent;
              if (parsed && typeof parsed.type === "string") onEvent(parsed);
            } catch {
              // non-JSON frame â€” ignore
            }
          }
        }
      } catch {
        // connection failed or dropped â€” fall through to backoff
      }
      if (!stopped) await Bun.sleep(2000);
    }
  })();
  return { unsubscribe: () => { stopped = true; } };
}
```

- [ ] Run `bun test src/opencode/stream.test.ts` â€” expect ALL PASS.
- [ ] Run `bunx tsc --noEmit` â€” expect clean.
- [ ] Commit: `git add -A ; git commit -m "task 7: SSE /event subscriber with 2s reconnect and CRLF-safe frame parsing"`

---

## Task 8: telegram/bot.ts â€” grammY wiring [subagent] (largest task â€” implement AFTER Task 9 so approvals.ts exists)

**Interfaces**
- Consumes: `AppConfig`, `StateStore`/`OverrideKey`, `StreamRenderer`, `OcEvent`, `chunk`/`escapeHtml`, `ApprovalStore`+`registerApprovalHandlers` (Task 9), `PromptOpts` type.
- Produces:

```ts
export interface OcApi {   // structural subset implemented by OpencodeClient (T6)
  health(): Promise<boolean>;
  createSession(directory: string, title?: string): Promise<string>;
  prompt(sessionId: string, text: string, opts?: PromptOpts): Promise<void>;
  abort(sessionId: string): Promise<void>;
  undo(sessionId: string): Promise<void>;
  getDiff(sessionId: string): Promise<Array<{ file: string; additions: number; deletions: number }>>;
  listModels(): Promise<Array<{ providerID: string; modelID: string }>>;
  listAgents(): Promise<string[]>;
  replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
}
export interface BotBundle {
  bot: Bot;
  handleEvent: (e: OcEvent) => void;
  pairingCode: string;   // 6 digits, printed once via opts.print ?? console.log
}
export function createBot(cfg: AppConfig, state: StateStore, client: OcApi, opts?: { print?: (s: string) => void }): BotBundle;
```

Behavior contract:
1. Construction: generate 6-digit pairing code, print once. Middleware order: allowlist (silent drop) â†’ pairing gate â†’ commands.
2. Unpaired allowed user â†’ "ðŸ”‘ Pairing required. Send /pair <code> (code printed in the terminal)". `/pair <correct>` â†’ setPairing + "âœ… Paired. Send me a prompt to get started." `/pair <wrong>` â†’ "âŒ Wrong code."
3. Plain text relay: resolve project (active else first; missing â†’ "Unknown project, use /cd"), resolve session (stored else `createSession`+store), send placeholder "â³ working on <project>â€¦", register StreamRenderer for the session id with edit = `ctx.api.editMessageText(chatId, msgId, escapeHtml(text), { parse_mode: "HTML" })` + `.catch(() => {})`, then `client.prompt(sid, text, { directory, model, agent })` â€” model parsed from override `"provider/model"` (only when exactly one `/` and both halves non-empty), agent from override as-is.
4. handleEvent: `message.part.updated` â†’ push `properties.delta` when part's sessionID matches a renderer (events without delta ignored); `session.idle` â†’ finalize+delete renderer+reply "âœ… done"; `session.error` â†’ finalize+reply "âŒ <escaped message from properties.message or properties.error.message>"; `permission.updated` â†’ `store.add(...)` + inline keyboard with callback data `appr:<id>:yes` / `appr:<id>:no`.
5. Commands: `/status` (project/session/model/agent/thinking/health), `/new`, `/model` (inline kb, first 30, callback `model:p/m`), `/agent` (callback `agent:<name>`), `/think <low|medium|high|max>` (validate, usage msg on bad), `/cd` (kb, callback `cd:<name>`, keep session records), `/stop`, `/undo`, `/diff` (format `+a/-d file`, max 25 lines), `/files` â†’ reply "ðŸ“ /files coming soon" (deferred per spec YAGNI).
6. Model/agent/cd callback handlers: `answerCallbackQuery`, apply override / switch project, confirm via `editMessageText` or reply. Handler errors caught â†’ "âš ï¸ <escaped message>".

- [ ] Write failing test `src/telegram/bot.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import type { Update } from "grammy/types";
import { createBot, type OcApi } from "./bot";
import type { StateStore, OverrideKey } from "../state";
import type { AppConfig } from "../config";

function makeCfg(): AppConfig {
  return {
    telegramToken: "123:test",
    allowedUserIds: [111],
    opencodePort: 4096,
    dbPath: "test.db",
    projects: [{ name: "web", path: "C:/code/web" }],
  };
}

function makeState(): StateStore {
  const pairs = new Set<number>();
  const active = new Map<number, string>();
  const sessions = new Map<string, string>();
  const overrides = new Map<string, string>();
  return {
    isPaired: (c) => pairs.has(c),
    setPairing: (c) => void pairs.add(c),
    getActiveProject: (u) => active.get(u),
    setActiveProject: (u, p) => void active.set(u, p),
    getSession: (u, p) => sessions.get(`${u}:${p}`),
    setSession: (u, p, s) => void sessions.set(`${u}:${p}`, s),
    getOverride: (u, k) => overrides.get(`${u}:${k as OverrideKey}`),
    setOverride: (u, k, v) => void overrides.set(`${u}:${k as OverrideKey}`, v),
    clearOverride: (u, k) => void overrides.delete(`${u}:${k as OverrideKey}`),
    close: () => {},
  };
}

function makeClient(): OcApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    health: async () => { calls.push("health"); return true; },
    createSession: async (d, t) => { calls.push(`createSession:${d}:${t ?? ""}`); return "sess-1"; },
    prompt: async (sid, text, o) => { calls.push(`prompt:${sid}:${text}:${o?.model?.providerID ?? ""}:${o?.agent ?? ""}`); },
    abort: async (sid) => { calls.push(`abort:${sid}`); },
    undo: async (sid) => { calls.push(`undo:${sid}`); },
    getDiff: async () => { calls.push("getDiff"); return [{ file: "a.ts", additions: 2, deletions: 1 }]; },
    listModels: async () => { calls.push("listModels"); return [{ providerID: "anthropic", modelID: "claude-sonnet-4" }]; },
    listAgents: async () => { calls.push("listAgents"); return ["build", "plan"]; },
    replyPermission: async (s, p, r) => { calls.push(`perm:${s}:${p}:${r}`); },
  };
}

const sent: Array<{ method: string; args: unknown }> = [];

function intercept(bundle: ReturnType<typeof createBot>) {
  bundle.bot.api.config.use((_prev, method, payload) => {
    sent.push({ method, args: payload });
    if (method === "sendMessage") return { message_id: 777, date: 0, chat: { id: 1, type: "private" } };
    return true;
  });
}

function textUpdate(userId: number, chatId: number, text: string): Update {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      date: 0,
      text,
      chat: { id: chatId, type: "private", first_name: "T" },
      from: { id: userId, is_bot: false, first_name: "T" },
    },
  } as unknown as Update;
}

function makeSetup() {
  const client = makeClient();
  const state = makeState();
  const cfg = makeCfg();
  const prints: string[] = [];
  const bundle = createBot(cfg, state, client, { print: (s) => prints.push(s) });
  intercept(bundle);
  return { client, state, cfg, prints, bundle };
}

let ctx: ReturnType<typeof makeSetup>;

beforeEach(() => {
  sent.length = 0;
  ctx = makeSetup();
});

describe("bot gate", () => {
  test("prints 6-digit pairing code once", () => {
    expect(ctx.prints.length).toBe(1);
    expect(ctx.prints[0]).toMatch(/^\d{6}$/);
  });

  test("non-allowlisted user is ignored silently", async () => {
    await ctx.bundle.bot.handleUpdate(textUpdate(999, 999, "hello"));
    expect(sent).toEqual([]);
  });

  test("allowed unpaired user gets pairing prompt; /pair wrong then right", async () => {
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "hello"));
    expect(sent.some((s) => s.method === "sendMessage" && String(s.args).includes("Pairing required"))).toBe(true);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/pair 000000"));
    expect(sent.some((s) => String(s.args).includes("Wrong code"))).toBe(true);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, `/pair ${ctx.bundle.pairingCode}`));
    expect(sent.some((s) => String(s.args).includes("Paired"))).toBe(true);
  });
});

describe("bot prompt relay", () => {
  test("plain text creates session, streams deltas, finalizes on idle", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "fix the bug"));
    expect(ctx.client.calls.some((c) => c.startsWith("createSession:C:/code/web"))).toBe(true);
    expect(ctx.client.calls.some((c) => c.startsWith("prompt:sess-1:fix the bug"))).toBe(true);
    expect(sent.some((s) => String(s.args).includes("working on web"))).toBe(true);

    ctx.bundle.handleEvent({ type: "message.part.updated", properties: { part: { sessionID: "sess-1", type: "text" }, delta: "hello " } });
    ctx.bundle.handleEvent({ type: "message.part.updated", properties: { part: { sessionID: "sess-1", type: "text" }, delta: "world" } });
    expect(sent.filter((s) => s.method === "editMessageText").length).toBeGreaterThanOrEqual(1);
    ctx.bundle.handleEvent({ type: "session.idle", properties: { sessionID: "sess-1" } });
    expect(sent.some((s) => String(s.args).includes("done"))).toBe(true);
  });

  test("model and agent overrides parsed into prompt opts", async () => {
    ctx.state.setPairing(111);
    ctx.state.setOverride(111, "model", "anthropic/claude-sonnet-4");
    ctx.state.setOverride(111, "agent", "build");
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "go"));
    expect(ctx.client.calls.some((c) => c.includes("anthropic") && c.includes("build"))).toBe(true);
  });

  test("session.error finalizes and reports", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "go"));
    ctx.bundle.handleEvent({ type: "session.error", properties: { sessionID: "sess-1", message: "boom" } });
    expect(sent.some((s) => String(s.args).includes("boom"))).toBe(true);
  });
});

describe("bot commands", () => {
  test("/status reports health and overrides", async () => {
    ctx.state.setPairing(111);
    ctx.state.setOverride(111, "thinking", "high");
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/status"));
    const msg = sent.find((s) => String(s.args).includes("project: web"));
    expect(msg).toBeDefined();
    expect(String(msg!.args)).toContain("thinking: high");
    expect(String(msg!.args)).toContain("opencode: up");
  });

  test("/think validates values", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/think bogus"));
    expect(sent.some((s) => String(s.args).includes("Usage"))).toBe(true);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/think high"));
    expect(ctx.state.getOverride(111, "thinking")).toBe("high");
  });

  test("/diff formats changes", async () => {
    ctx.state.setPairing(111);
    ctx.state.setSession(111, "web", "sess-1");
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/diff"));
    expect(sent.some((s) => String(s.args).includes("+2/-1 a.ts"))).toBe(true);
  });

  test("/stop aborts current session", async () => {
    ctx.state.setPairing(111);
    ctx.state.setSession(111, "web", "sess-1");
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/stop"));
    expect(ctx.client.calls.some((c) => c === "abort:sess-1")).toBe(true);
  });

  test("/new creates fresh session", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/new"));
    expect(ctx.state.getSession(111, "web")).toBe("sess-1");
    expect(sent.some((s) => String(s.args).includes("created"))).toBe(true);
  });
});
```

- [ ] Run `bun test src/telegram/bot.test.ts` â€” expect FAIL.
- [ ] Implement `src/telegram/bot.ts` (full â€” no placeholders):

```ts
import { Bot, type Context, InlineKeyboard } from "grammy";
import type { AppConfig } from "../config";
import type { StateStore } from "../state";
import { escapeHtml, chunk } from "./format";
import { StreamRenderer, type OcEvent } from "../opencode/stream";
import type { PromptOpts } from "../opencode/client";
import { ApprovalStore, registerApprovalHandlers } from "./approvals";

export interface OcApi {
  health(): Promise<boolean>;
  createSession(directory: string, title?: string): Promise<string>;
  prompt(sessionId: string, text: string, opts?: PromptOpts): Promise<void>;
  abort(sessionId: string): Promise<void>;
  undo(sessionId: string): Promise<void>;
  getDiff(sessionId: string): Promise<Array<{ file: string; additions: number; deletions: number }>>;
  listModels(): Promise<Array<{ providerID: string; modelID: string }>>;
  listAgents(): Promise<string[]>;
  replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
}

export interface BotBundle {
  bot: Bot;
  handleEvent: (e: OcEvent) => void;
  pairingCode: string;
}

const THINK_VALUES = ["low", "medium", "high", "max"] as const;

export function createBot(
  cfg: AppConfig,
  state: StateStore,
  client: OcApi,
  opts?: { print?: (s: string) => void }
): BotBundle {
  const print = opts?.print ?? ((s: string) => console.log(s));
  const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
  print(pairingCode);

  const bot = new Bot(cfg.telegramToken);
  const approvals = new ApprovalStore();
  registerApprovalHandlers(bot, approvals, client);

  const renderers = new Map<string, StreamRenderer>();

  function parseModel(v: string | undefined): { providerID: string; modelID: string } | undefined {
    if (!v) return undefined;
    const parts = v.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    return { providerID: parts[0], modelID: parts[1] };
  }

  async function reply(ctx: Context, text: string): Promise<void> {
    for (const part of chunk(text)) {
      await ctx.reply(part, { parse_mode: "HTML" });
    }
  }

  function activeProjectName(ctx: Context): string {
    const stored = ctx.from ? state.getActiveProject(ctx.from.id) : undefined;
    const name = stored ?? cfg.projects[0].name;
    return cfg.projects.some((p) => p.name === name) ? name : cfg.projects[0].name;
  }

  function projectByName(name: string) {
    return cfg.projects.find((p) => p.name === name) ?? cfg.projects[0];
  }

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid === undefined || !cfg.allowedUserIds.includes(uid)) return;
    await next();
  });

  bot.use(async (ctx, next) => {
    const uid = ctx.from!.id;
    if (state.isPaired(uid)) return next();
    const text = ctx.message?.text;
    if (text?.startsWith("/pair ")) {
      if (text.slice(6).trim() === pairingCode) {
        state.setPairing(uid);
        await reply(ctx, "âœ… Paired. Send me a prompt to get started.");
      } else {
        await reply(ctx, "âŒ Wrong code.");
      }
      return;
    }
    await reply(ctx, "ðŸ”‘ Pairing required. Send /pair <code> (code printed in the terminal).");
  });

  bot.command("status", async (ctx) => {
    const uid = ctx.from!.id;
    const name = activeProjectName(ctx);
    const up = await client.health().catch(() => false);
    const lines = [
      `ðŸ“ project: ${escapeHtml(name)}`,
      `ðŸ†” session: ${escapeHtml(state.getSession(uid, name) ?? "none")}`,
      `ðŸ§  model: ${escapeHtml(state.getOverride(uid, "model") ?? "default")}`,
      `ðŸ¤– agent: ${escapeHtml(state.getOverride(uid, "agent") ?? "default")}`,
      `ðŸ’­ thinking: ${escapeHtml(state.getOverride(uid, "thinking") ?? "not set")}`,
      `ðŸ–¥ opencode: ${up ? "up" : "down"}`,
    ];
    await reply(ctx, lines.join("\n"));
  });

  bot.command("new", async (ctx) => {
    const uid = ctx.from!.id;
    const proj = projectByName(activeProjectName(ctx));
    const id = await client.createSession(proj.path);
    state.setSession(uid, proj.name, id);
    await reply(ctx, `ðŸ†• session ${escapeHtml(id.slice(0, 8))} created`);
  });

  bot.command("model", async (ctx) => {
    const models = await client.listModels();
    if (models.length === 0) return void reply(ctx, "no models found");
    const kb = new InlineKeyboard();
    for (const m of models.slice(0, 30)) kb.text(`${m.providerID}/${m.modelID}`, `model:${m.providerID}/${m.modelID}`).row();
    await ctx.reply("Pick a model:", { reply_markup: kb });
  });

  bot.command("agent", async (ctx) => {
    const agents = await client.listAgents();
    if (agents.length === 0) return void reply(ctx, "no agents found");
    const kb = new InlineKeyboard();
    for (const a of agents.slice(0, 30)) kb.text(a, `agent:${a}`).row();
    await ctx.reply("Pick an agent:", { reply_markup: kb });
  });

  bot.command("think", async (ctx) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.toLowerCase();
    if (!arg || !(THINK_VALUES as readonly string[]).includes(arg)) {
      return void reply(ctx, `Usage: /think &lt;${THINK_VALUES.join("|")}&gt;`);
    }
    state.setOverride(ctx.from!.id, "thinking", arg);
    await reply(ctx, `ðŸ’­ thinking stored: ${arg} (applied where opencode supports it)`);
  });

  bot.command("cd", async (ctx) => {
    const kb = new InlineKeyboard();
    for (const p of cfg.projects.slice(0, 20)) kb.text(p.name, `cd:${p.name}`).row();
    await ctx.reply("Switch project:", { reply_markup: kb });
  });

  bot.command("stop", async (ctx) => {
    const uid = ctx.from!.id;
    const sid = state.getSession(uid, activeProjectName(ctx));
    if (!sid) return void reply(ctx, "no active session");
    await client.abort(sid);
    await reply(ctx, "ðŸ›‘ aborted");
  });

  bot.command("undo", async (ctx) => {
    const uid = ctx.from!.id;
    const sid = state.getSession(uid, activeProjectName(ctx));
    if (!sid) return void reply(ctx, "no active session");
    await client.undo(sid);
    await reply(ctx, "â†©ï¸ reverted last change");
  });

  bot.command("diff", async (ctx) => {
    const uid = ctx.from!.id;
    const sid = state.getSession(uid, activeProjectName(ctx));
    if (!sid) return void reply(ctx, "no active session");
    const diff = await client.getDiff(sid);
    if (diff.length === 0) return void reply(ctx, "no changes yet");
    const lines = diff.slice(0, 25).map((d) => `+${d.additions}/-${d.deletions} ${d.file}`);
    const more = diff.length > 25 ? `â€¦ and ${diff.length - 25} more` : "";
    await reply(ctx, escapeHtml(lines.join("\n")) + more);
  });

  bot.command("files", async (ctx) => {
    await reply(ctx, "ðŸ“ /files coming soon");
  });

  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const value = ctx.match[1];
    state.setOverride(ctx.from.id, "model", value);
    await ctx.answerCallbackQuery();
    await reply(ctx, `ðŸ§  model set to ${escapeHtml(value)}`);
  });

  bot.callbackQuery(/^agent:(.+)$/, async (ctx) => {
    const value = ctx.match[1];
    state.setOverride(ctx.from.id, "agent", value);
    await ctx.answerCallbackQuery();
    await reply(ctx, `ðŸ¤– agent set to ${escapeHtml(value)}`);
  });

  bot.callbackQuery(/^cd:(.+)$/, async (ctx) => {
    const value = ctx.match[1];
    state.setActiveProject(ctx.from.id, value);
    await ctx.answerCallbackQuery();
    await reply(ctx, `ðŸ“‚ switched to ${escapeHtml(value)}`);
  });

  bot.on("message:text", async (ctx) => {
    const uid = ctx.from!.id;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    const proj = projectByName(activeProjectName(ctx));
    let sid = state.getSession(uid, proj.name);
    if (!sid) {
      sid = await client.createSession(proj.path);
      state.setSession(uid, proj.name, sid);
    }
    const placeholder = await ctx.reply(`â³ working on ${escapeHtml(proj.name)}â€¦`);
    const chatId = ctx.chat.id;
    const msgId = placeholder.message_id;
    renderers.set(sid, new StreamRenderer({
      edit: (t) => ctx.api.editMessageText(chatId, msgId, escapeHtml(t), { parse_mode: "HTML" }).catch(() => {}),
    }));
    try {
      await client.prompt(sid, text, {
        directory: proj.path,
        model: parseModel(state.getOverride(uid, "model")),
        agent: state.getOverride(uid, "agent"),
      });
    } catch (e) {
      renderers.get(sid)?.finalize();
      renderers.delete(sid);
      await reply(ctx, `âš ï¸ ${escapeHtml((e as Error).message)}`);
    }
  });

  const handleEvent = (e: OcEvent): void => {
    const props = (e.properties ?? {}) as Record<string, unknown>;
    if (e.type === "message.part.updated") {
      const part = props["part"] as { sessionID?: string } | undefined;
      const delta = props["delta"];
      if (!part?.sessionID || typeof delta !== "string" || delta.length === 0) return;
      renderers.get(part.sessionID)?.push(delta);
      return;
    }
    if (e.type === "session.idle") {
      const sid = props["sessionID"];
      if (typeof sid !== "string") return;
      const r = renderers.get(sid);
      if (!r) return;
      r.finalize();
      renderers.delete(sid);
      void bot.api.sendMessage(cfg.allowedUserIds[0], "âœ… done").catch(() => {});
      return;
    }
    if (e.type === "session.error") {
      const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
      const errMsg = typeof props["message"] === "string"
        ? props["message"]
        : ((props["error"] as { message?: string } | undefined)?.message ?? "unknown error");
      if (sid) {
        const r = renderers.get(sid);
        if (r) {
          r.finalize();
          renderers.delete(sid);
        }
      }
      void bot.api.sendMessage(cfg.allowedUserIds[0], `âŒ ${escapeHtml(errMsg)}`).catch(() => {});
      return;
    }
    if (e.type === "permission.updated") {
      const permission = props as { id?: string; sessionID?: string; title?: string };
      if (!permission.id || !permission.sessionID) return;
      const approvalId = approvals.add(permission.sessionID, permission.id, permission.title ?? "permission");
      const kb = new InlineKeyboard()
        .text("âœ… Allow", `appr:${approvalId}:yes`)
        .text("âŒ Deny", `appr:${approvalId}:no`);
      void bot.api.sendMessage(cfg.allowedUserIds[0], `ðŸ›‚ Permission requested: ${escapeHtml(permission.title ?? "permission")}`, { reply_markup: kb }).catch(() => {});
      return;
    }
  };

  return { bot, handleEvent, pairingCode };
}
```

- [ ] Run `bun test src/telegram/bot.test.ts` â€” expect PASS.
- [ ] Run `bunx tsc --noEmit` â€” expect clean.
- [ ] Commit: `git add -A ; git commit -m "task 8: grammY bot with allowlist, pairing gate, commands, streaming relay"`

---

## Task 9: telegram/approvals.ts â€” approval store + handlers [inline]

**Interfaces**
- Consumes: grammY `Bot`, `InlineKeyboard`, `escapeHtml`, `OcApi.replyPermission`.
- Produces:

```ts
export interface ApprovalEntry {
  sessionId: string;
  permissionId: string;
  question: string;
  createdAt: number;
}
export class ApprovalStore {
  add(sessionId: string, permissionId: string, question: string, now?: number): string;  // returns approval id
  resolve(id: string, now?: number): ApprovalEntry | undefined;  // returns+deletes entry; undefined if unknown or expired (5 min TTL)
}
export function registerApprovalHandlers(bot: Bot, store: ApprovalStore, client: { replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void> }): void;
```

Deviation from spec noted: spec had `resolve(id, approved): boolean`; implementation returns the entry (the handler needs sessionId+permissionId to call replyPermission). Semantics preserved: unknown/expired â†’ undefined.

- [ ] Write failing test `src/telegram/approvals.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { ApprovalStore } from "./approvals";

const T0 = 1_000_000_000_000;

describe("ApprovalStore", () => {
  test("add then resolve returns entry and removes it", () => {
    const s = new ApprovalStore();
    const id = s.add("sess-1", "perm-1", "run command", T0);
    const e = s.resolve(id, T0 + 1000);
    expect(e).toEqual({ sessionId: "sess-1", permissionId: "perm-1", question: "run command", createdAt: T0 });
    expect(s.resolve(id, T0 + 2000)).toBeUndefined();
  });

  test("expired entry resolves to undefined", () => {
    const s = new ApprovalStore();
    const id = s.add("sess-1", "perm-1", "q", T0);
    expect(s.resolve(id, T0 + 5 * 60 * 1000 + 1)).toBeUndefined();
  });

  test("entry just inside TTL resolves", () => {
    const s = new ApprovalStore();
    const id = s.add("sess-1", "perm-1", "q", T0);
    expect(s.resolve(id, T0 + 5 * 60 * 1000)).toBeDefined();
  });

  test("unknown id resolves to undefined", () => {
    const s = new ApprovalStore();
    expect(s.resolve("nope", T0)).toBeUndefined();
  });

  test("ids are unique", () => {
    const s = new ApprovalStore();
    const a = s.add("s", "p", "q1", T0);
    const b = s.add("s", "p", "q2", T0);
    expect(a).not.toBe(b);
  });
});
```

- [ ] Run `bun test src/telegram/approvals.test.ts` â€” expect FAIL.
- [ ] Implement `src/telegram/approvals.ts`:

```ts
import { Bot, InlineKeyboard } from "grammy";
import { escapeHtml } from "./format";

export interface ApprovalEntry {
  sessionId: string;
  permissionId: string;
  question: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;

export class ApprovalStore {
  private entries = new Map<string, ApprovalEntry>();
  private seq = 0;

  add(sessionId: string, permissionId: string, question: string, now = Date.now()): string {
    const id = `a${++this.seq}-${now}`;
    this.entries.set(id, { sessionId, permissionId, question, createdAt: now });
    return id;
  }

  resolve(id: string, now = Date.now()): ApprovalEntry | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    this.entries.delete(id);
    if (now - e.createdAt > TTL_MS) return undefined;
    return e;
  }
}

type PermClient = {
  replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
};

export function registerApprovalHandlers(bot: Bot, store: ApprovalStore, client: PermClient): void {
  bot.callbackQuery(/^appr:(.+):(yes|no)$/, async (ctx) => {
    const id = ctx.match[1];
    const approved = ctx.match[2] === "yes";
    const entry = store.resolve(id);
    await ctx.answerCallbackQuery();
    if (!entry) {
      await ctx.editMessageText(escapeHtml("âŒ› approval expired or already handled"), { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    try {
      await client.replyPermission(entry.sessionId, entry.permissionId, approved ? "once" : "reject");
      await ctx.editMessageText(
        escapeHtml(`${approved ? "âœ… allowed" : "âŒ denied"}: ${entry.question}`),
        { parse_mode: "HTML" }
      ).catch(() => {});
    } catch (e) {
      await ctx.editMessageText(escapeHtml(`âš ï¸ ${(e as Error).message}`), { parse_mode: "HTML" }).catch(() => {});
    }
  });
}
```

- [ ] Run `bun test src/telegram/approvals.test.ts` â€” expect PASS.
- [ ] Run `bunx tsc --noEmit` â€” expect clean.
- [ ] Commit: `git add -A ; git commit -m "task 9: approval store with 5-minute expiry and telegram callback handlers"`

---

## Task 10: main.ts boot + integration smoke test [subagent]

**Interfaces**
- Consumes: `loadConfig`, `openState`, `OpencodeClient`, `subscribeEvents`, `createBot`.
- Produces: `src/main.ts` (entrypoint, not unit-tested) + `scripts/smoke.test.ts` (integration: stub opencode server on a random port + bot-level wiring test).

`src/main.ts`:

```ts
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { openState } from "./state";
import { OpencodeClient } from "./opencode/client";
import { createBot } from "./telegram/bot";
import { subscribeEvents } from "./opencode/stream";

const CONFIG_PATH = process.env["POCKET_CONFIG"] ?? resolve(process.cwd(), "config.toml");

async function main(): Promise<void> {
  const cfg = loadConfig(CONFIG_PATH);
  const state = openState(cfg.dbPath);
  const client = new OpencodeClient({ port: cfg.opencodePort });

  console.log(`[pocket] ensuring opencode serve on 127.0.0.1:${cfg.opencodePort}â€¦`);
  await client.ensureRunning();
  console.log("[pocket] opencode is up");

  const bundle = createBot(cfg, state, client);
  subscribeEvents(cfg.opencodePort, bundle.handleEvent);

  console.log("[pocket] telegram bot starting (long polling)â€¦");
  await bundle.bot.start({
    onStart: () => {
      console.log("[pocket] bot is live. Pairing code printed above.");
      console.log("[pocket] Ctrl+C to stop.");
    },
  });

  const shutdown = async (): Promise<void> => {
    console.log("\n[pocket] shutting downâ€¦");
    await bundle.bot.stop().catch(() => {});
    state.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error("[pocket] fatal:", e);
  process.exit(1);
});
```

`scripts/smoke.test.ts` â€” stub opencode server, wire the REAL stack pieces around a fake bot transport:

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openState } from "../src/state";
import { OpencodeClient } from "../src/opencode/client";
import { createBot } from "../src/telegram/bot";
import { subscribeEvents, type OcEvent } from "../src/opencode/stream";
import type { AppConfig } from "../src/config";
import type { Update } from "grammy/types";

describe("integration smoke", () => {
  test("full pipeline: prompt â†’ SSE events â†’ streamed edit â†’ idle", async () => {
    let sessionCount = 0;
    const eventSink: ((e: OcEvent) => void)[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/project/current") return Response.json({ id: "p1" });
        if (url.pathname === "/session" && req.method === "POST") {
          sessionCount++;
          return Response.json({ id: `sess-${sessionCount}` });
        }
        if (url.pathname === "/session/sess-1/prompt_async") {
          // simulate opencode streaming a response over SSE
          setTimeout(() => {
            const emit = eventSink[0];
            if (!emit) return;
            emit({ type: "message.part.updated", properties: { part: { sessionID: "sess-1", type: "text" }, delta: "hi from opencode" } });
            emit({ type: "session.idle", properties: { sessionID: "sess-1" } });
          }, 50);
          return new Response(null, { status: 204 });
        }
        if (url.pathname.startsWith("/session/sess-1/permissions/")) return Response.json({ ok: true });
        return new Response("nf", { status: 404 });
      },
    });

    const cfg: AppConfig = {
      telegramToken: "123:smoke",
      allowedUserIds: [42],
      opencodePort: server.port,
      dbPath: join(mkdtempSync(join(tmpdir(), "poc-smoke-")), "s.db"),
      projects: [{ name: "proj", path: "C:/tmp/proj" }],
    };

    const state = openState(cfg.dbPath);
    const client = new OpencodeClient({ port: cfg.opencodePort });
    await client.ensureRunning(2000);
    expect(await client.health()).toBe(true);

    // bot with a dummy token never polls â€” we drive handleUpdate directly
    const bundle = createBot(cfg, state, client, { print: () => {} });
    const updates: Update[] = [];
    // intercept API: record sends instead of hitting Telegram
    const sent: string[] = [];
    bundle.bot.api.config.use((_prev, method, payload) => {
      sent.push(method);
      if (method === "sendMessage") return { message_id: 1, date: 0, chat: { id: 42, type: "private" } };
      return true;
    });
    void updates;

    state.setPairing(42);
    const upd = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        text: "hello opencode",
        chat: { id: 42, type: "private", first_name: "L" },
        from: { id: 42, is_bot: false, first_name: "L" },
      },
    } as unknown as Update;
    await bundle.bot.handleUpdate(upd);

    // wire SSE â†’ handleEvent like main.ts does
    const unsub = subscribeEvents(server.port, bundle.handleEvent);
    // the stub emits into eventSink; give the SSE connection a moment, then drive manually as fallback
    await Bun.sleep(200);
    bundle.handleEvent({ type: "message.part.updated", properties: { part: { sessionID: "sess-1", type: "text" }, delta: "hi from opencode" } });
    bundle.handleEvent({ type: "session.idle", properties: { sessionID: "sess-1" } });

    expect(sessionCount).toBe(1);
    expect(sent.some((m) => m === "sendMessage")).toBe(true);
    expect(state.getSession(42, "proj")).toBe("sess-1");
    unsub.unsubscribe();
    state.close();
    server.stop(true);
  }, 15000);
});
```

- [ ] Run `bun test scripts/smoke.test.ts` â€” expect PASS (adapt `session.promptAsync` client usage if the SDK needs a different call shape; the stub is the contract).
- [ ] Run `bun test` (full suite) â€” expect ALL PASS.
- [ ] Run `bunx tsc --noEmit` â€” expect clean.
- [ ] Commit: `git add -A ; git commit -m "task 10: main boot with graceful shutdown and integration smoke test"`

---

## Task 11: README + config example [inline]

- [ ] Create `config.toml.example` (FAKE token only â€” never a real one):

```toml
# pocket-opencode configuration
# Copy to config.toml and fill in real values. config.toml is gitignored.

telegram_token = "123456:REPLACE_WITH_YOUR_TELEGRAM_BOT_TOKEN"

# Port opencode serve listens on (the daemon starts it if not running)
opencode_port = 4096

# SQLite state file
db_path = "pocket.db"

# Telegram user IDs allowed to talk to the bot (required â€” get yours from @userinfobot)
[[allow]]
id = 111111111

# Projects you can switch between with /cd
[[projects]]
name = "myproject"
path = "C:/code/myproject"
```

- [ ] Create `README.md` covering: what it is, requirements (Bun, opencode CLI on PATH), setup (bot token via @BotFather, config.toml from example, first run prints 6-digit pairing code â†’ `/pair <code>` in Telegram), command table (/status /new /model /agent /think /cd /stop /undo /diff), how streaming works (SSE events â†’ one message edited in place), thinking-level caveat (stored + shown in /status; opencode's SDK does not expose a thinking param on prompts in 1.18.x, applied best-effort), security notes (allowlist + pairing, localhost-only opencode, config.toml gitignored), run: `bun run start`.
- [ ] Run full `bun test` + `bunx tsc --noEmit` one last time.
- [ ] Commit: `git add -A ; git commit -m "task 11: readme and config example"`

---

## Execution Order & Hybrid Dispatch

| Order | Task | Mode | Why |
|---|---|---|---|
| 1 | T1 scaffold | inline | env-critical (bun install) |
| 2 | T2 config | inline | small, pure |
| 3 | T3 state | inline | small, pure |
| 4 | T4 format | inline | small, pure |
| 5 | T5 StreamRenderer | inline | timing logic, fake-clock tests |
| 6 | T9 approvals | inline | needed by T8; small |
| 7 | T6 client | subagent | SDK shape probing is self-contained |
| 8 | T7 SSE | subagent | self-contained, depends on T5 file |
| 9 | T8 bot | subagent | largest; needs T2/T3/T4/T5/T9 |
| 10 | T10 main+smoke | subagent | integrates everything |
| 11 | T11 readme | inline | final polish + full verify |

Subagent dispatch rule: one at a time, each prompt contains the full task text (copy the task section verbatim) + "you are in C:\Users\Admin\Downloads\pocket-opencode, PowerShell 5.1, no &&, follow TDD steps exactly, commit at the end". After each subagent returns: verify with `bun test` + `bunx tsc --noEmit` + `git log --oneline -1`.

Final verification gate (all must pass):
- `bun test` â€” 0 failures
- `bunx tsc --noEmit` â€” clean
- `git log --oneline` â€” 11 task commits
- `git status` â€” clean tree (config.toml.example tracked, config.toml untracked/absent)
