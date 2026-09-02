import { describe, expect, test } from "bun:test";
import { APP_VERSION } from "./version";

describe("version", () => {
  test("exports APP_VERSION 0.1.0", () => {
    expect(APP_VERSION).toBe("0.1.0");
  });
});
