# pocket-opencode — Design Spec

**Date:** 2026-09-02
**Status:** Approved (LO pre-approval granted 2026-09-02)

## Goal

A Telegram bot daemon that runs on LO's Windows 11 PC and gives full remote control of a local [opencode](https://opencode.ai) instance from a phone: send prompts, switch models/agents, adjust thinking effort, abort runaway sessions, inspect diffs and files — from anywhere, with zero exposed ports.

## Architecture

```
Telegram (phone)
   ↕  long-polling (outbound HTTPS only, no inbound ports)
pocket-opencode daemon (Bun + TypeScript, single process)
   ↕  localhost HTTP (opencode SDK)
opencode serve (spawned + supervised by the daemon)
```

One Bun process owns everything: the grammY bot, the opencode client, stream rendering, state. SQLite via `bun:sqlite`. Config via TOML.

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun ≥ 1.1 | single `.exe` builds, built-in SQLite, native TS |
| Language | TypeScript (strict) | opencode itself is TS; official SDK alignment |
| Telegram | grammY ^1 | best-in-class transformers/plugins for edit-rate-limited streaming |
| opencode | `@opencode-ai/sdk` (official) | ride opencode's own client instead of hand-rolled HTTP |
| Config | `smol-toml` | tiny TOML parser, no native deps |
| State | `bun:sqlite` | zero-dependency persistence, survives reboots |
| Tests | `bun test` | built-in runner, fast, no extra infra |

## Security Model

1. **Hard allowlist** — only Telegram user IDs in `config.toml` may interact; all others silently ignored (no reply, no log spam).
2. **Pairing** — first run prints a one-time pairing code to the daemon terminal; the allowlisted user must send it once before the bot accepts commands.
3. **No webhooks** — long-polling only. The PC opens zero inbound ports; works behind any NAT/CGNAT/firewall.
4. **Secrets hygiene** — `config.toml` and `*.db` are gitignored. The GitHub token LO provided in chat is NEVER written to any file.

## Config (`config.toml`)

```toml
telegram_token = "..."          # from @BotFather
opencode_port = 4096            # port for opencode serve
db_path = "state.db"            # relative to project root

[[projects]]
name = "main"
path = "C:\\Users\\Admin\\Downloads\\pocket-opencode"   # or any repo

# allowed Telegram user IDs (owner fills after first /start attempt prints their ID in daemon log)
[[allow]]
id = 123456789
```

If `[[allow]]` is empty, the daemon logs the Telegram user ID of any sender and ignores them — self-service onboarding without weakening the gate.

## State (`state.db`, bun:sqlite)

- `pairing(chat_id INTEGER PRIMARY KEY, paired_at TEXT)` — rows exist once paired
- `active_project(user_id INTEGER PRIMARY KEY, project TEXT)` — per-user cwd
- `session(user_id INTEGER, project TEXT, session_id TEXT, PRIMARY KEY(user_id, project))` — resumable opencode session per project
- `overrides(user_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(user_id, key))` — model/agent/thinking overrides

## Module Boundaries & Exact Interfaces

All exports under `src/`. These signatures are contractual — tasks reference them verbatim.

### `src/config.ts`
```ts
export interface Project { name: string; path: string }
export interface AppConfig {
  telegramToken: string
  allowedUserIds: number[]
  opencodePort: number
  dbPath: string
  projects: Project[]
}
export class ConfigError extends Error {}
export function loadConfig(path?: string): AppConfig
```
Throws `ConfigError` with a human-readable message on missing token, bad TOML, or duplicate project names.

### `src/state.ts`
```ts
export interface StateStore {
  isPaired(userId: number): boolean
  setPairing(userId: number): void
  getActiveProject(userId: number): string | null
  setActiveProject(userId: number, name: string): void
  getSession(userId: number, project: string): string | null
  setSession(userId: number, project: string, sessionId: string): void
  getOverride(userId: number, key: OverrideKey): string | null
  setOverride(userId: number, key: OverrideKey, value: string): void
  clearOverride(userId: number, key: OverrideKey): void
}
export type OverrideKey = "model" | "agent" | "thinking"
export function openState(dbPath: string): StateStore
```

### `src/opencode/client.ts`
```ts
export interface ModelInfo { id: string; name: string }
export interface AgentInfo { name: string; description?: string }
export interface TextPart { type: "text"; text: string }
export class OpencodeClient {
  constructor(port: number)
  ensureRunning(): Promise<void>        // spawn `opencode serve --port N` if /doc (health) fails; supervise & restart on exit
  health(): Promise<boolean>
  createSession(directory: string, title?: string): Promise<string>   // returns session id
  prompt(sessionId: string, parts: TextPart[]): Promise<void>         // async send; output arrives via events
  abort(sessionId: string): Promise<void>
  listModels(): Promise<ModelInfo[]>
  listAgents(): Promise<AgentInfo[]>
  getDiff(directory: string): Promise<string>
  undo(sessionId: string): Promise<void>
}
```
All opencode API knowledge lives in this file. If the SDK shape drifts across opencode versions, this is the only file that changes.

### `src/opencode/stream.ts`
```ts
export interface OpencodeEvent { type: string; properties?: Record<string, unknown> }
export function subscribeEvents(port: number, onEvent: (e: OpencodeEvent) => void): () => void  // returns unsubscribe
export class StreamRenderer {
  constructor(edit: (text: string) => Promise<void>, opts?: { minIntervalMs?: number; maxLen?: number })
  push(delta: string): Promise<void>    // coalesces edits to ≥1.2s apart; truncates with "(truncated)" past maxLen
  finalize(): Promise<void>             // final full edit
}
```
`subscribeEvents` opens an SSE connection to `http://127.0.0.1:<port>/event`, auto-reconnects on drop with 2s backoff.

### `src/telegram/format.ts`
```ts
export function chunk(text: string, limit?: number): string[]   // default limit 3900; splits on line boundaries
export function escapeHtml(s: string): string
```

### `src/telegram/bot.ts`
```ts
export function createBot(cfg: AppConfig, state: StateStore, client: OpencodeClient): Bot
```
Wires: allowlist middleware (silent drop), pairing gate, command handlers, plain-text → prompt relay, approval callback routing.

### `src/telegram/approvals.ts`
```ts
export class ApprovalStore {
  resolve(id: string, approved: boolean): boolean   // true if id was pending
  add(id: string, sessionId: string, question: string): void
}
export function registerApprovalHandlers(bot: Bot, store: ApprovalStore): void
```
Permission requests from opencode events → Telegram message with ✅/❌ inline buttons; 5-minute expiry.

### `src/main.ts`
Boot order: `loadConfig` → `openState` → `new OpencodeClient` → `ensureRunning` → `subscribeEvents` (routes stream deltas + approval events) → `createBot` → `bot.start()` (long-polling). Graceful SIGINT: abort active session, close DB, exit 0.

## Commands

| Command | Behavior |
|---|---|
| plain text | sent as prompt to active session; output streams into one message |
| `/status` | active project, session id, model/agent/thinking overrides, busy state |
| `/new [title]` | create fresh session for active project |
| `/model` | inline keyboard list → tap to set override |
| `/agent` | inline keyboard list → tap to set override |
| `/think low\|medium\|high\|max` | set thinking override |
| `/cd` | inline keyboard of projects → switch active project |
| `/stop` | abort current session run |
| `/undo` | revert last opencode change in active session |
| `/diff` | last 3500 chars of `git diff` from opencode |
| `/files` | file tree of active project (top 2 levels, truncated) |

## Error Handling Matrix

| Failure | Behavior |
|---|---|
| opencode not running / dies | daemon restarts `opencode serve`, notifies user in chat |
| Telegram edit flood (429) | StreamRenderer coalesces edits ≥1.2s apart, backs off on 429 |
| Output > 4096 chars | chunked into multiple messages |
| opencode API version drift | contained in `client.ts`; descriptive error surfaced to chat |
| Bot crashes | Bun process manager restart; SQLite state makes resume seamless |
| Non-allowlisted user | silently ignored |
| Unpaired allowlisted user | prompted for pairing code |

## Testing Strategy

- `bun test`, colocated `*.test.ts`.
- `OpencodeClient` is mocked in bot tests via its interface (no live server needed).
- StreamRenderer tested with a fake `edit` fn capturing call timing/text.
- Format/state/config tested as pure units.
- One integration smoke test: boot main.ts against a stub HTTP server pretending to be opencode.

## Out of Scope (YAGNI)

- Voice messages, group chat support, multi-user beyond allowlist, webhook mode, Docker packaging, remote opencode (non-localhost).
