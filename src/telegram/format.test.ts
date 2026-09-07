import { describe, test, expect } from "bun:test";
import { chunk, escapeHtml, mdToTelegramHtml, balancePre, friendlyError } from "./format";

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

describe("mdToTelegramHtml", () => {
  test("fenced code becomes pre with escaped content", () => {
    expect(mdToTelegramHtml("```ts\nconst a = 1 < 2;\n```")).toBe("<pre>const a = 1 &lt; 2;</pre>");
  });

  test("inline code becomes code", () => {
    expect(mdToTelegramHtml("run `bun test` now")).toBe("run <code>bun test</code> now");
  });

  test("bold becomes b", () => {
    expect(mdToTelegramHtml("**hello** world")).toBe("<b>hello</b> world");
  });

  test("italic becomes i", () => {
    expect(mdToTelegramHtml("a *soft* word")).toBe("a <i>soft</i> word");
  });

  test("unclosed markers stay literal", () => {
    expect(mdToTelegramHtml("weird ** mixed ` stuff")).toBe("weird ** mixed ` stuff");
  });

  test("html inside constructs is escaped", () => {
    expect(mdToTelegramHtml("**<script>**")).toBe("<b>&lt;script&gt;</b>");
  });

  test("fence with language tag still works", () => {
    expect(mdToTelegramHtml("```python\nprint('x')\n```")).toBe("<pre>print(&#39;x&#39;)</pre>");
  });

  test("plain text passes through escaped only", () => {
    expect(mdToTelegramHtml("a & b")).toBe("a &amp; b");
  });
});

describe("friendlyError", () => {
  const sqlDump =
    'Failed query: insert into "part" ("id", "message_id", "session_id", "time_created", "time_updated", "data") values (?, ?, ?, ?, ?, ?) on conflict ("part"."id") do update set "time_updated" = ?, "data" = ?params: prt_07ca0ae3e001pFKx6qXISZE1z0,msg_07c9e9547001p70xKSnqV03dCm,ses_f91c973a9ffedxx4QlB7rX5snR,1788797300286,1788797300290,{"type":"step-start"},1788797300290,{"type":"step-start"}';

  test("sql/query failures become a friendly line", () => {
    const out = friendlyError(sqlDump);
    expect(out).not.toContain("insert into");
    expect(out).not.toContain("prt_");
    expect(out).toContain("storage");
  });

  test("quota / 403 shaped with hint", () => {
    const out = friendlyError("pre-consume quota failed (403)");
    expect(out).toContain("quota");
    expect(out.toLowerCase()).toContain("model");
  });

  test("auth / 401 shaped with hint", () => {
    const out = friendlyError("401 Unauthorized");
    expect(out.toLowerCase()).toContain("unauthorized");
  });

  test("short human message passes through", () => {
    expect(friendlyError("boom")).toBe("boom");
  });

  test("long message is truncated", () => {
    const out = friendlyError("x".repeat(500));
    expect(out.length).toBeLessThanOrEqual(320);
  });

  test("output contains no raw html-dangerous chars", () => {
    const out = friendlyError(sqlDump);
    expect(out).not.toMatch(/[<>&"']/);
  });
});

describe("balancePre", () => {
  test("closes pre at chunk end and reopens in next", () => {
    expect(balancePre(["<pre>abc", "def</pre>"])).toEqual(["<pre>abc</pre>", "<pre>def</pre>"]);
  });

  test("no-op without open pre", () => {
    expect(balancePre(["one", "two"])).toEqual(["one", "two"]);
  });

  test("multiple sequential fences split across chunks", () => {
    const out = balancePre(["<pre>a</pre> <pre>b", "c</pre> tail"]);
    expect(out).toEqual(["<pre>a</pre> <pre>b</pre>", "<pre>c</pre> tail"]);
  });
});
