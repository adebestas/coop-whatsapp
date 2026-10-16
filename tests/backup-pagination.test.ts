/**
 * PERF-2: the backup must be COMPLETE. The old reader used a fixed
 * `findMany({ take: 50_000 })`, so any larger table was silently truncated.
 * fetchAllBatched pages through every row via a PK cursor.
 */
import { describe, expect, it } from "vitest";
import { fetchAllBatched } from "../src/services/backup.js";

interface Row {
  id: string;
}
interface BatchArgs {
  take: number;
  skip?: number;
  cursor?: { id: string };
  orderBy: { id: "asc" };
}

function fakeTable(total: number) {
  const rows: Row[] = Array.from({ length: total }, (_, i) => ({
    id: String(i + 1).padStart(6, "0"),
  }));
  const calls: BatchArgs[] = [];
  const fetch = async (args: BatchArgs): Promise<Row[]> => {
    calls.push(args);
    let start = 0;
    if (args.cursor) {
      start = rows.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0);
    }
    return rows.slice(start, start + args.take);
  };
  return { fetch, calls, rows };
}

describe("fetchAllBatched", () => {
  it("reads the whole table across pages (no truncation)", async () => {
    const { fetch, rows } = fakeTable(5);
    const got = await fetchAllBatched(fetch, 2);
    expect(got.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(got).toHaveLength(5);
  });

  it("uses a keyset cursor after the first page", async () => {
    const { fetch, calls } = fakeTable(5);
    await fetchAllBatched(fetch, 2);
    expect(calls[0].cursor).toBeUndefined();
    expect(calls[1].cursor).toEqual({ id: "000002" });
    expect(calls[1].skip).toBe(1);
  });

  it("stops cleanly when the row count is an exact multiple of the page size", async () => {
    const { fetch } = fakeTable(4);
    const got = await fetchAllBatched(fetch, 2);
    expect(got).toHaveLength(4);
  });

  it("handles an empty table", async () => {
    const { fetch } = fakeTable(0);
    expect(await fetchAllBatched(fetch, 2)).toEqual([]);
  });
});
