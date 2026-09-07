export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function mdToTelegramHtml(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.replace(/\n$/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  return s;
}

const ERROR_LIMIT = 300;

function stripHtmlChars(s: string): string {
  return s.replace(/[<>&"']/g, " ").replace(/\s+/g, " ").trim();
}

export function friendlyError(raw: string): string {
  const line = stripHtmlChars(raw.split("\n")[0] ?? "").trim() || "unknown error";
  if (/failed query|insert into|select .* from|update .* set|sqlite/i.test(line)) {
    return "generation failed — opencode storage error. Try /new, and restart opencode if it keeps happening.";
  }
  if (/quota|insufficient|credit|billing/i.test(line)) {
    return `${line} — this model has no remaining quota. Pick another with /model.`;
  }
  if (/401|unauthorized|invalid api key|authentication/i.test(line)) {
    return `${line} — provider rejected the key. Check your credentials.`;
  }
  if (/429|rate limit|too many requests/i.test(line)) {
    return `${line} — rate limited, wait a moment and retry.`;
  }
  if (line.length > ERROR_LIMIT) return `${line.slice(0, ERROR_LIMIT)}…`;
  return line;
}

export function balancePre(chunks: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const c of chunks) {
    const opens = (c.match(/<pre>/g) ?? []).length;
    const closes = (c.match(/<\/pre>/g) ?? []).length;
    const openAtEnd: boolean = (inside ? 1 : 0) + opens - closes > 0;
    let part = inside ? "<pre>" + c : c;
    if (openAtEnd) part += "</pre>";
    inside = openAtEnd;
    out.push(part);
  }
  return out;
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
