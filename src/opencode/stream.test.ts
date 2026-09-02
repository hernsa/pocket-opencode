import { describe, test, expect } from "bun:test";
import { StreamRenderer, subscribeEvents, type OcEvent } from "./stream";

function makeRenderer(extra = {}) {
  const edits: string[] = [];
  let t = 0;
  const r = new StreamRenderer({
    edit: (s) => { edits.push(s); },
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
    expect(edits[edits.length - 1]).toBe("…" + "z".repeat(49));
  });
});

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

    const sub = subscribeEvents(server.port!, (e) => received.push(e));

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

  test("sends custom headers with the event request", async () => {
    const probe = { auth: null as string | null };
    const received: OcEvent[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/event") return new Response("nf", { status: 404 });
        probe.auth = req.headers.get("authorization");
        const body = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              new TextEncoder().encode('data: {"type":"session.idle","properties":{"sessionID":"s9"}}\n\n')
            );
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const sub = subscribeEvents(server.port!, (e) => received.push(e), {
      headers: { Authorization: "Basic dXNlcjpwdw==" },
    });
    for (let i = 0; i < 100 && received.length < 1; i++) await Bun.sleep(50);
    expect(received.length).toBe(1);
    expect(probe.auth).toBe("Basic dXNlcjpwdw==");
    sub.unsubscribe();
    server.stop(true);
  }, 10000);

  test("connects with directory query param", async () => {
    const probe = { dir: null as string | null };
    const received: OcEvent[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/event") return new Response("nf", { status: 404 });
        probe.dir = url.searchParams.get("directory");
        const body = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              new TextEncoder().encode('data: {"type":"session.idle","properties":{}}\n\n')
            );
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const sub = subscribeEvents(server.port!, (e) => received.push(e), {
      directory: "C:/Users/Admin/Downloads",
    });
    for (let i = 0; i < 100 && received.length < 1; i++) await Bun.sleep(50);
    expect(received.length).toBe(1);
    expect(probe.dir).toBe("C:/Users/Admin/Downloads");
    sub.unsubscribe();
    server.stop(true);
  }, 10000);
});
