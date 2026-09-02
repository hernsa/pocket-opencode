import { describe, test, expect } from "bun:test";
import { StreamRenderer } from "./stream";

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
