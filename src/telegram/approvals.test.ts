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
