import { beforeEach, describe, expect, it, vi } from "vitest";

type InsertCall = { values?: Record<string, unknown>; set?: unknown };

const hoisted = vi.hoisted(() => ({
  insertCalls: [] as InsertCall[],
  info: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(async () => {}),
  batchResult: [] as unknown[],
  batchFails: false,
}));

vi.mock("next-axiom", () => ({
  Logger: class {
    info = hoisted.info;
    error = hoisted.error;
    flush = hoisted.flush;
  },
}));

vi.mock("@/db/schema", () => {
  const chain = (rec: InsertCall) => ({
    values: (v: Record<string, unknown>) => {
      rec.values = v;
      return {
        onConflictDoUpdate: (o: { set: unknown }) => {
          rec.set = o.set;
          hoisted.insertCalls.push(rec);
          return { returning: () => ({ kind: "insert" }) };
        },
      };
    },
  });
  return {
    mcpRateLimit: { id: "id", count: "count" },
    db: {
      insert: () => chain({}),
      select: () => ({ from: () => ({ where: () => ({ kind: "select" }) }) }),
      batch: async () => {
        if (hoisted.batchFails) {
          throw new Error("db down");
        }
        return hoisted.batchResult;
      },
    },
  };
});

import {
  bucharestDay,
  formatAccountReadLine,
  listRequestId,
  recordAccountRead,
} from "./account-read";

beforeEach(() => {
  hoisted.insertCalls.length = 0;
  hoisted.info.mockClear();
  hoisted.error.mockClear();
  hoisted.batchFails = false;
});

describe("bucharestDay", () => {
  it("uses the Bucharest calendar date, not UTC", () => {
    expect(bucharestDay(new Date("2026-11-17T22:30:00Z"))).toBe(20261118);
    expect(bucharestDay(new Date("2026-11-17T21:30:00Z"))).toBe(20261117);
  });

  it("follows summer time", () => {
    expect(bucharestDay(new Date("2026-07-10T21:30:00Z"))).toBe(20260711);
  });
});

describe("formatAccountReadLine", () => {
  it("keeps the field order and encodes values", () => {
    const line = formatAccountReadLine({
      userId: "u 1",
      kind: "list",
      id: "a=b",
      n: 10,
      via: "search",
      ip: null,
      nDay: 12,
      n10m: 15,
    });
    expect(line).toBe(
      "account_read site=sicap.ai userId=u%201 plan= kind=list id=a%3Db n=10 via=search ip= nDay=12 n10m=15 threshold=- action=log",
    );
  });

  it("writes the ip when present", () => {
    const line = formatAccountReadLine({
      userId: "u",
      kind: "mcp",
      id: "x",
      n: 1,
      via: "mcp",
      ip: "1.2.3.4",
      nDay: 1,
      n10m: 1,
    });
    expect(line).toContain(" ip=1.2.3.4 ");
  });
});

describe("listRequestId", () => {
  const base = { query: "q", filters: { a: 1, b: 2 }, page: 1, perPage: 10 };

  it("returns 16 hex chars, stable across key order", () => {
    const id = listRequestId(base);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(listRequestId({ ...base, filters: { b: 2, a: 1 } })).toBe(id);
  });

  it("changes with the inputs", () => {
    expect(listRequestId({ ...base, page: 2 })).not.toBe(listRequestId(base));
  });
});

describe("recordAccountRead", () => {
  it("increments both counters by n and logs one line", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T22:30:00Z"));
    hoisted.batchResult = [[{ count: 25 }], [{ count: 7 }], [{ count: 3 }]];

    await recordAccountRead({
      userId: "u1",
      kind: "list",
      id: "abc",
      n: 5,
      via: "search",
      ip: "9.9.9.9",
    });

    const bucket = Math.floor(Date.now() / 600_000);
    expect(hoisted.insertCalls.map((c) => c.values?.id)).toEqual([
      "u1:r:d:20261118",
      `u1:r:t:${bucket}`,
    ]);
    expect(hoisted.insertCalls.map((c) => c.values?.count)).toEqual([5, 5]);
    expect(hoisted.insertCalls[0]?.values?.windowStart).toBe(20261118);
    expect(hoisted.info).toHaveBeenCalledTimes(1);
    expect(hoisted.info.mock.calls[0]?.[0]).toBe(
      "account_read site=sicap.ai userId=u1 plan= kind=list id=abc n=5 via=search ip=9.9.9.9 nDay=25 n10m=10 threshold=- action=log",
    );
    vi.useRealTimers();
  });

  it("never throws when the database fails", async () => {
    hoisted.batchFails = true;
    await expect(
      recordAccountRead({ userId: "u1", kind: "mcp", id: "x", n: 1, via: "mcp" }),
    ).resolves.toBeUndefined();
    expect(hoisted.error).toHaveBeenCalled();
    expect(hoisted.info).not.toHaveBeenCalled();
  });
});
