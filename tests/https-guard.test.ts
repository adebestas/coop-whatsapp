import { describe, expect, it } from "vitest";

import { isInsecureRequest } from "../src/lib/http-guards.js";

describe("HTTPS enforcement guard", () => {
  it("allows the health probe over plain HTTP (container-local checks)", () => {
    expect(isInsecureRequest("/health", undefined)).toBe(false);
    expect(isInsecureRequest("/health?verbose=1", undefined)).toBe(false);
  });

  it("rejects other plain-HTTP requests", () => {
    expect(isInsecureRequest("/webhook", undefined)).toBe(true);
    expect(isInsecureRequest("/api/admin/members", "http")).toBe(true);
  });

  it("allows HTTPS requests", () => {
    expect(isInsecureRequest("/webhook", "https")).toBe(false);
  });
});
