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
  bundle.bot.api.config.use(((_prev: unknown, method: string, payload: unknown) => {
    sent.push({ method, args: payload });
    if (method === "getMe") {
      return { ok: true, result: { id: 42, is_bot: true, first_name: "TestBot", username: "testbot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } };
    }
    if (method === "sendMessage") return { ok: true, result: { message_id: 777, date: 0, chat: { id: 1, type: "private" } } };
    return { ok: true, result: true };
  }) as never);
}

function textUpdate(userId: number, chatId: number, text: string): Update {
  const cmdLen = text.split(/\s+/)[0].length;
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      date: 0,
      text,
      entities: text.startsWith("/")
        ? [{ offset: 0, length: cmdLen, type: "bot_command" }]
        : undefined,
      chat: { id: chatId, type: "private", first_name: "T" },
      from: { id: userId, is_bot: false, first_name: "T" },
    },
  } as unknown as Update;
}

async function makeSetup() {
  const client = makeClient();
  const state = makeState();
  const cfg = makeCfg();
  const prints: string[] = [];
  const bundle = createBot(cfg, state, client, { print: (s) => prints.push(s) });
  intercept(bundle);
  await bundle.bot.init();
  sent.length = 0;
  return { client, state, cfg, prints, bundle };
}

let ctx: Awaited<ReturnType<typeof makeSetup>>;

beforeEach(async () => {
  sent.length = 0;
  ctx = await makeSetup();
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
    expect(sent.some((s) => s.method === "sendMessage" && JSON.stringify(s.args).includes("Pairing required"))).toBe(true);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/pair 000000"));
    expect(sent.some((s) => JSON.stringify(s.args).includes("Wrong code"))).toBe(true);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, `/pair ${ctx.bundle.pairingCode}`));
    expect(sent.some((s) => JSON.stringify(s.args).includes("Paired"))).toBe(true);
  });
});

describe("bot prompt relay", () => {
  test("plain text creates session, streams deltas, finalizes on idle", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "fix the bug"));
    expect(ctx.client.calls.some((c) => c.startsWith("createSession:C:/code/web"))).toBe(true);
    expect(ctx.client.calls.some((c) => c.startsWith("prompt:sess-1:fix the bug"))).toBe(true);
    expect(sent.some((s) => JSON.stringify(s.args).includes("working on web"))).toBe(true);

    ctx.bundle.handleEvent({ type: "message.part.updated", properties: { part: { sessionID: "sess-1", type: "text" }, delta: "hello " } });
    ctx.bundle.handleEvent({ type: "message.part.updated", properties: { part: { sessionID: "sess-1", type: "text" }, delta: "world" } });
    expect(sent.filter((s) => s.method === "editMessageText").length).toBeGreaterThanOrEqual(1);
    ctx.bundle.handleEvent({ type: "session.idle", properties: { sessionID: "sess-1" } });
    expect(sent.some((s) => JSON.stringify(s.args).includes("done"))).toBe(true);
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
    expect(sent.some((s) => JSON.stringify(s.args).includes("boom"))).toBe(true);
  });

  test("session.error unwraps nested error.data.message (opencode shape)", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "go"));
    ctx.bundle.handleEvent({
      type: "session.error",
      properties: {
        sessionID: "sess-1",
        error: { name: "APIError", data: { message: "pre-consume quota failed", statusCode: 403 } },
      },
    });
    expect(sent.some((s) => JSON.stringify(s.args).includes("pre-consume quota failed"))).toBe(true);
  });
});

describe("bot commands", () => {
  test("/status reports health and overrides", async () => {
    ctx.state.setPairing(111);
    ctx.state.setOverride(111, "thinking", "high");
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/status"));
    const msg = sent.find((s) => JSON.stringify(s.args).includes("project: web"));
    expect(msg).toBeDefined();
    expect(JSON.stringify(msg!.args)).toContain("thinking: high");
    expect(JSON.stringify(msg!.args)).toContain("opencode: up");
  });

  test("/think validates values", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/think bogus"));
    expect(sent.some((s) => JSON.stringify(s.args).includes("Usage"))).toBe(true);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/think high"));
    expect(ctx.state.getOverride(111, "thinking")).toBe("high");
  });

  test("/diff formats changes", async () => {
    ctx.state.setPairing(111);
    ctx.state.setSession(111, "web", "sess-1");
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/diff"));
    expect(sent.some((s) => JSON.stringify(s.args).includes("+2/-1 a.ts"))).toBe(true);
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
    expect(sent.some((s) => JSON.stringify(s.args).includes("created"))).toBe(true);
  });
});

describe("bot model picker", () => {
  test("/model shows one button per provider, then that provider's models", async () => {
    ctx.state.setPairing(111);
    ctx.client.listModels = async () => [
      { providerID: "openai", modelID: "gpt-5" },
      { providerID: "openai", modelID: "gpt-4o" },
      { providerID: "chatbai", modelID: "glm-5.3-flash" },
    ];
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "/model"));
    const kbMsg = sent.find((s) => s.method === "sendMessage" && JSON.stringify(s.args).includes("Pick a provider"));
    expect(kbMsg).toBeDefined();
    const kb = JSON.stringify(kbMsg!.args);
    expect(kb).toContain("openai");
    expect(kb).toContain("chatbai");
    expect(kb).not.toContain("gpt-5");

    const cb: Update = {
      update_id: 9,
      callback_query: {
        id: "c1",
        from: { id: 111, is_bot: false, first_name: "T" } as never,
        data: "prov:openai",
        chat_instance: "ci",
        message: { message_id: 777, date: 0, chat: { id: 111, type: "private" }, from: { id: 42, is_bot: true, first_name: "B" } } as never,
      },
    } as unknown as Update;
    await ctx.bundle.bot.handleUpdate(cb);
    const modelsMsg = sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").find((s) => JSON.stringify(s.args).includes("openai/gpt-5"));
    expect(modelsMsg).toBeDefined();
    expect(JSON.stringify(modelsMsg!.args)).toContain("openai/gpt-4o");
  });
});

describe("bot resilience", () => {  test("relay replies with error instead of crashing when createSession fails", async () => {
    const client = makeClient();
    client.createSession = async () => { throw new Error("opencode api error: HTTP 401"); };
    const state = makeState();
    const cfg = makeCfg();
    const bundle = createBot(cfg, state, client, { print: () => {} });
    intercept(bundle);
    await bundle.bot.init();
    sent.length = 0;
    state.setPairing(111);
    await bundle.bot.handleUpdate(textUpdate(111, 111, "hello there"));
    expect(sent.some((s) => JSON.stringify(s.args).includes("could not reach opencode"))).toBe(true);
  });

  test("bot.catch swallows command errors so polling survives", async () => {
    const client = makeClient();
    client.createSession = async () => { throw new Error("opencode api error: HTTP 500"); };
    const state = makeState();
    const cfg = makeCfg();
    const bundle = createBot(cfg, state, client, { print: () => {} });
    intercept(bundle);
    await bundle.bot.init();
    sent.length = 0;
    state.setPairing(111);
    await expect(bundle.bot.handleUpdate(textUpdate(111, 111, "/new"))).resolves.toBeUndefined();
    expect(sent.some((s) => JSON.stringify(s.args).includes("could not reach opencode"))).toBe(true);
  });
});

describe("bot streaming last mile (real opencode shape)", () => {
  test("message.part.updated without delta renders part.text (real v1.18.6 shape)", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "what model are u"));
    ctx.bundle.handleEvent({
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: { type: "text", text: "I am Muse Spark 1.2, built by Meta.", sessionID: "sess-1" },
      },
    });
    const edit = sent.find((s) => s.method === "editMessageText");
    expect(edit).toBeDefined();
    expect(JSON.stringify(edit!.args)).toContain("Muse Spark");
  });

  test("message.part.updated with delta still appends (legacy shape)", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "go"));
    ctx.bundle.handleEvent({
      type: "message.part.updated",
      properties: { part: { sessionID: "sess-1", type: "text" }, delta: "hello " },
    });
    expect(sent.some((s) => s.method === "editMessageText")).toBe(true);
  });

  test("non-text parts (reasoning/step-start) do not render", async () => {
    ctx.state.setPairing(111);
    await ctx.bundle.bot.handleUpdate(textUpdate(111, 111, "go"));
    const before = sent.filter((s) => s.method === "editMessageText").length;
    ctx.bundle.handleEvent({
      type: "message.part.updated",
      properties: { sessionID: "sess-1", part: { type: "reasoning", text: "thinking..." } },
    });
    ctx.bundle.handleEvent({
      type: "message.part.updated",
      properties: { sessionID: "sess-1", part: { type: "step-start" } },
    });
    const after = sent.filter((s) => s.method === "editMessageText").length;
    expect(after).toBe(before);
  });
});
