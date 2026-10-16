/**
 * PERF-1: the DB connection budget must be bounded and configurable.
 *
 * Every long-lived pool is multiplied by the number of app instances, so each
 * pool must carry an explicit connection_limit (app: DB_CONNECTION_LIMIT,
 * owner: DB_OWNER_CONNECTION_LIMIT) instead of Prisma's unbounded default.
 */
import { describe, expect, it } from "vitest";
import { applyPoolParams, resolveConnectionLimit } from "../src/lib/prisma.js";

describe("applyPoolParams", () => {
  it("appends connection_limit + pool_timeout to a bare URL", () => {
    expect(applyPoolParams("postgresql://u:p@host:5432/coop", 10)).toBe(
      "postgresql://u:p@host:5432/coop?connection_limit=10&pool_timeout=10",
    );
  });

  it("appends with & when the URL already has a query string", () => {
    expect(applyPoolParams("postgresql://u:p@host:5432/coop?sslmode=require", 3)).toBe(
      "postgresql://u:p@host:5432/coop?sslmode=require&connection_limit=3&pool_timeout=10",
    );
  });

  it("never overrides a connection_limit the URL already pins", () => {
    const url = "postgresql://u:p@host:5432/coop?connection_limit=5";
    expect(applyPoolParams(url, 10)).toBe(url);
  });

  it("leaves an empty URL untouched", () => {
    expect(applyPoolParams("", 10)).toBe("");
  });
});

describe("resolveConnectionLimit", () => {
  it("uses a valid positive integer", () => {
    expect(resolveConnectionLimit("25", 10)).toBe(25);
  });

  it("falls back when unset, zero, negative, or non-numeric", () => {
    expect(resolveConnectionLimit(undefined, 10)).toBe(10);
    expect(resolveConnectionLimit("0", 10)).toBe(10);
    expect(resolveConnectionLimit("-4", 10)).toBe(10);
    expect(resolveConnectionLimit("abc", 10)).toBe(10);
  });
});
