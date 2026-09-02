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
