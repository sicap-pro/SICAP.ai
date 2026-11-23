import { beforeEach, describe, expect, it, vi } from "vitest";

type InsertCall = { id: string; userId: string; windowStart: number; count: number };

const hoisted = vi.hoisted(() => ({
  insertCalls: [] as InsertCall[],
  batches: [] as number[],
  batchResult: [] as unknown[],
}));

vi.mock("@/db/schema", () => ({
  mcpRateLimit: { id: "id", count: "count" },
  db: {
    insert: () => ({
      values: (v: InsertCall) => {
        hoisted.insertCalls.push(v);
        return { onConflictDoUpdate: () => ({ returning: () => ({ kind: "insert" }) }) };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ kind: "select" }) }) }),
    batch: async (statements: unknown[]) => {
      hoisted.batches.push(statements.length);
      return hoisted.batchResult;
    },
  },
}));

import {
  chargeCredits,
  creditsFor,
  enforceRateLimit,
  limitInstructions,
  RateLimitError,
  type Reservation,
  releaseCredits,
  retryAfterSeconds,
} from "./rate-limit";

const NOW = Date.parse("2026-11-23T18:30:15Z");
const MINUTE = Math.floor(NOW / 60_000);
const DAY = Math.floor(NOW / 86_400_000);
const MONTH = 2026 * 12 + 10;

const row = (key: "minute" | "day" | "month" | "held", count: number): InsertCall => {
  const ids = {
    minute: `u1:${MINUTE}`,
    day: `u1:c:d:${DAY}`,
    month: `u1:c:m:${MONTH}`,
    held: `u1:c:h:${MINUTE}`,
  };
  const starts = { minute: MINUTE, day: DAY, month: MONTH, held: MINUTE };
  return { id: ids[key], userId: "u1", windowStart: starts[key], count };
};

// What the batch in enforceRateLimit returns: calls this minute and credits held this minute
// (both after this call's additions), credits held in the minute before, settled day, settled
// month. A row that does not exist yet reads as an empty list.
const state = (s: {
  minute?: number;
  held: number;
  heldBefore?: number;
  day?: number;
  month?: number;
}) => [
  [{ count: s.minute ?? 1 }],
  [{ count: s.held }],
  s.heldBefore === undefined ? [] : [{ count: s.heldBefore }],
  s.day === undefined ? [] : [{ count: s.day }],
  s.month === undefined ? [] : [{ count: s.month }],
];

const rejection = async (maxCredits: number, result: unknown[]): Promise<RateLimitError> => {
  hoisted.batchResult = result;
  const err = await enforceRateLimit("u1", maxCredits, NOW).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RateLimitError);
  return err as RateLimitError;
};

const held = (credits: number): Reservation => ({ now: NOW, credits });

beforeEach(() => {
  hoisted.insertCalls.length = 0;
  hoisted.batches.length = 0;
  hoisted.batchResult = [];
});

describe("creditsFor", () => {
  it("charges one credit per record, at least one", () => {
    expect(creditsFor(13)).toBe(13);
    expect(creditsFor(1)).toBe(1);
    expect(creditsFor(0)).toBe(1);
    expect(creditsFor(Number.NaN)).toBe(1);
  });
});

describe("retryAfterSeconds", () => {
  it("waits for the next minute", () => {
    expect(retryAfterSeconds("minute", NOW)).toBe(45);
  });

  it("waits for the next UTC midnight", () => {
    expect(retryAfterSeconds("day", NOW)).toBe(5 * 3600 + 29 * 60 + 45);
  });

  it("waits for the first of the next UTC month, across a year end", () => {
    expect(retryAfterSeconds("month", NOW)).toBe(7 * 86_400 + 5 * 3600 + 29 * 60 + 45);
    expect(retryAfterSeconds("month", Date.parse("2026-12-31T23:59:00Z"))).toBe(60);
  });

  it("waits a few seconds when other calls hold the credits", () => {
    expect(retryAfterSeconds("busy", NOW)).toBe(3);
  });
});

describe("enforceRateLimit", () => {
  it("counts the call and holds its credits, without touching day or month", async () => {
    hoisted.batchResult = state({ held: 50 });
    await expect(enforceRateLimit("u1", 50, NOW)).resolves.toEqual(held(50));
    expect(hoisted.insertCalls).toEqual([row("minute", 1), row("held", 50)]);
    expect(hoisted.batches).toEqual([5]);
  });

  it("passes while settled credits are under the allowance", async () => {
    // 99 settled, 50 held by this call: the last response may run over.
    hoisted.batchResult = state({ minute: 60, held: 50, day: 99, month: 999 });
    await expect(enforceRateLimit("u1", 50, NOW)).resolves.toEqual(held(50));
  });

  it("rejects when the day is used up, and drops the hold", async () => {
    const err = await rejection(50, state({ held: 50, day: 100, month: 100 }));
    expect(err.window).toBe("day");
    expect(err.message).toContain("100 credite pe zi");
    expect(hoisted.insertCalls.slice(2)).toEqual([row("held", -50)]);
    expect(hoisted.batches).toEqual([5, 1]);
  });

  it("rejects on the month ahead of the day", async () => {
    const err = await rejection(1, state({ held: 1, day: 100, month: 1000 }));
    expect(err.window).toBe("month");
    expect(err.message).toContain("1000 credite pe lună");
  });

  it("rejects the 61st call in a minute", async () => {
    const err = await rejection(1, state({ minute: 61, held: 1 }));
    expect(err.window).toBe("minute");
  });

  it("asks for a retry when calls still running hold the credits that are left", async () => {
    // 60 settled, another call holds 50, this one asks for 1: not used up, only busy.
    const err = await rejection(1, state({ held: 51, day: 60, month: 60 }));
    expect(err.window).toBe("busy");
    expect(err.message).not.toContain("api.sicap.ai");
    expect(hoisted.insertCalls.slice(2)).toEqual([row("held", -1)]);
  });

  it("counts credits held since the minute before", async () => {
    const err = await rejection(1, state({ held: 1, heldBefore: 50, day: 60, month: 60 }));
    expect(err.window).toBe("busy");
  });

  it("ignores a hold row that went negative", async () => {
    // A hold dropped twice left -50 in the minute before: it must not hide the other call.
    const err = await rejection(1, state({ held: 51, heldBefore: -50, day: 60, month: 60 }));
    expect(err.window).toBe("busy");
  });

  it("passes when the credits held by other calls still fit", async () => {
    hoisted.batchResult = state({ held: 100, day: 40, month: 40 });
    await expect(enforceRateLimit("u1", 50, NOW)).resolves.toEqual(held(50));
  });
});

describe("releaseCredits", () => {
  it("drops the hold and charges nothing", async () => {
    await releaseCredits("u1", held(20));
    expect(hoisted.insertCalls).toEqual([row("held", -20)]);
  });
});

describe("chargeCredits", () => {
  it("adds the real cost to day and month and drops the hold", async () => {
    hoisted.batchResult = [[{ count: 13 }], [{ count: 13 }], [{ count: 0 }]];
    await expect(chargeCredits("u1", held(50), 13)).resolves.toEqual({
      credits: 13,
      reached: null,
    });
    expect(hoisted.insertCalls).toEqual([row("day", 13), row("month", 13), row("held", -50)]);
  });

  it("charges one credit for an empty result", async () => {
    hoisted.batchResult = [[{ count: 1 }], [{ count: 1 }], [{ count: 0 }]];
    await expect(chargeCredits("u1", held(10), 0)).resolves.toEqual({ credits: 1, reached: null });
    expect(hoisted.insertCalls.map((c) => c.count)).toEqual([1, 1, -10]);
  });

  it("reports the window on the call whose charge crosses it, month ahead of day", async () => {
    hoisted.batchResult = [[{ count: 100 }], [{ count: 400 }], [{ count: 0 }]];
    await expect(chargeCredits("u1", held(50), 50)).resolves.toEqual({
      credits: 50,
      reached: "day",
    });
    hoisted.batchResult = [[{ count: 120 }], [{ count: 1000 }], [{ count: 0 }]];
    await expect(chargeCredits("u1", held(50), 50)).resolves.toEqual({
      credits: 50,
      reached: "month",
    });
  });

  it("stays quiet when an earlier charge already crossed the window", async () => {
    hoisted.batchResult = [[{ count: 149 }], [{ count: 149 }], [{ count: 0 }]];
    await expect(chargeCredits("u1", held(50), 49)).resolves.toEqual({
      credits: 49,
      reached: null,
    });
  });
});

describe("limitInstructions", () => {
  it("tells the agent to stop, inform the user and point to the paid API plans", () => {
    const text = limitInstructions("day", NOW);
    expect(text).toContain("allowance for this day is used up");
    expect(text).toContain("resets at 2026-11-24T00:00:00.000Z");
    expect(text).toContain("Tell the user");
    expect(text).toContain("https://api.sicap.ai/pricing");
    expect(limitInstructions("month", NOW)).toContain("resets at 2026-12-01T00:00:00.000Z");
  });

  it("only asks for a pause on the minute window", () => {
    const text = limitInstructions("minute", NOW);
    expect(text).toContain("Wait 45 seconds");
    expect(text).not.toContain("api.sicap.ai");
    expect(limitInstructions("minute", NOW + 44_000)).toContain("Wait 1 second,");
  });

  it("asks for a short pause and a retry when the account is busy", () => {
    const text = limitInstructions("busy", NOW);
    expect(text).toContain("Wait 3 seconds, then retry this call");
    expect(text).not.toContain("Tell the user");
    expect(text).not.toContain("api.sicap.ai");
  });
});
