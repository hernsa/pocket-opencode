# pocket-opencode

A Telegram bot daemon that runs on your Windows PC and lets you drive the local [opencode](https://opencode.ai) agent from your phone: send prompts, switch models/agents/projects, watch responses stream into a single Telegram message, approve tool permissions, and inspect diffs — all with zero open ports (Telegram long polling only).

## How it works

```
Telegram (your phone)
   │  long polling
   ▼
pocket-opencode daemon (Bun + grammY)
   │  HTTP + SSE (localhost only)
   ▼
opencode serve --port 4096
   ▼
your projects
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- `opencode` CLI on your PATH (`opencode --version` works)
- A Telegram bot token (create a bot via [@BotFather](https://t.me/BotFather))
- Your Telegram user ID (get it from [@userinfobot](https://t.me/userinfobot))

## Setup

1. `bun install`
2. `Copy-Item config.toml.example config.toml` (PowerShell) and fill in:
   - your bot token from @BotFather
   - your numeric Telegram user ID under `[[allow]]`
   - your project name/path under `[[projects]]`
3. `bun run start`

On first start the daemon prints a **6-digit pairing code** in the terminal and the bot replies "Pairing required" to any message. Send `/pair <code>` in Telegram once — the bot is then bound to that chat. Only user IDs in `[[allow]]` are ever processed; everyone else is silently ignored.

## Commands

| Command | Action |
|---------|--------|
| *(plain text)* | send a prompt to opencode in the active project |
| `/status` | active project, session, model/agent/thinking overrides, opencode health |
| `/new` | start a fresh opencode session |
| `/model` | pick a model (inline keyboard) |
| `/agent` | pick an agent (inline keyboard) |
| `/think <low\|medium\|high\|max>` | store a thinking-level preference |
| `/cd` | switch project (inline keyboard; sessions kept per project) |
| `/stop` | abort the current run |
| `/undo` | revert opencode's last change |
| `/diff` | show changed files (+additions/-deletions) |

## Streaming

opencode emits `message.part.updated` SSE events; the daemon coalesces deltas (~1.2 s cadence) and edits one Telegram message in place — no message spam. `session.idle` finalizes the message; `permission.updated` surfaces an Allow/Deny inline keyboard wired to opencode's permission API.

## Thinking levels

`/think` stores your preference and shows it in `/status`. The opencode SDK (1.18.x) does not expose a thinking/reasoning parameter on prompts, so it is applied best-effort wherever opencode supports it.

## Security notes

- Hard allowlist: user IDs not in `[[allow]]` are dropped before any processing.
- First-run pairing code gates chat control (printed once to the terminal).
- opencode is talked to over `127.0.0.1` only; nothing listens on external interfaces.
- `config.toml` (contains your bot token) is gitignored; `*.db` state files too.

## Run

```
bun run start
```

Ctrl+C stops the daemon gracefully (bot stops, SQLite closes).
