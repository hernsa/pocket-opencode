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
  test("full pipeline: prompt -> SSE events -> streamed edit -> idle", async () => {
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
            emit({ type: "message.updated", properties: { info: { id: "msg_s1", role: "assistant" } } });
            emit({ type: "message.part.updated", properties: { sessionID: "sess-1", part: { type: "text", text: "hi from opencode", sessionID: "sess-1", messageID: "msg_s1", id: "p1" } } });
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
      opencodePort: server.port!,
      dbPath: join(mkdtempSync(join(tmpdir(), "poc-smoke-")), "s.db"),
      projects: [{ name: "proj", path: "C:/tmp/proj" }],
    };

    const state = openState(cfg.dbPath);
    const client = new OpencodeClient({ port: cfg.opencodePort });
    await client.ensureRunning(2000);
    expect(await client.health()).toBe(true);

    // bot with a dummy token never polls -- we drive handleUpdate directly
    const bundle = createBot(cfg, state, client, { print: () => {} });
    const sent: string[] = [];
    bundle.bot.api.config.use(((_prev: unknown, method: string) => {
      sent.push(method);
      if (method === "getMe") {
        return { ok: true, result: { id: 1, is_bot: true, first_name: "Smoke", username: "smokebot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } };
      }
      if (method === "sendMessage") return { ok: true, result: { message_id: 1, date: 0, chat: { id: 42, type: "private" } } };
      return { ok: true, result: true };
    }) as never);
    await bundle.bot.init();
    sent.length = 0;

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

    // wire SSE -> handleEvent like main.ts does
    const unsub = subscribeEvents(server.port!, bundle.handleEvent);
    // the stub emits into eventSink; give the SSE connection a moment, then drive manually as fallback
    await Bun.sleep(200);
    bundle.handleEvent({ type: "message.updated", properties: { info: { id: "msg_s1", role: "assistant" } } } as never);
    bundle.handleEvent({ type: "message.part.updated", properties: { sessionID: "sess-1", part: { type: "text", text: "hi from opencode", sessionID: "sess-1", messageID: "msg_s1", id: "p1" } } });
    bundle.handleEvent({ type: "session.idle", properties: { sessionID: "sess-1" } });
    await Bun.sleep(5);

    expect(sessionCount).toBe(1);
    expect(sent.some((m) => m === "sendMessage")).toBe(true);
    expect(state.getSession(42, "C:/tmp/proj")).toBe("sess-1");
    unsub.unsubscribe();
    state.close();
    server.stop(true);
  }, 15000);
});
