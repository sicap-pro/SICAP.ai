import { sql } from "drizzle-orm";
import { db, mcpRateLimit } from "@/db/schema";

const MINUTE_LIMIT = 60; // calls per minute: stops runaway agent loops
// Credits follow https://api.sicap.ai/pricing: one credit per contract returned, at least one
// per call. The allowances are the free API plan's, so the MCP is not a larger free tier.
const DAY_CREDITS = 100;
const MONTH_CREDITS = 1000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const BUSY_RETRY_MS = 3000;

/** `busy` is not a used-up window: calls still running hold the credits that are left. */
export type RateLimitWindow = "minute" | "day" | "month" | "busy";

const HIGHER_LIMITS = "Pentru limite mai mari folosește https://api.sicap.ai/";
const CREDIT_UNIT = "1 credit = 1 contract returnat";
const API_PRICING_URL = "https://api.sicap.ai/pricing";

const MESSAGES: Record<RateLimitWindow, string> = {
  minute: `Limită depășită: maxim ${MINUTE_LIMIT} apeluri pe minut. Încetinește ritmul. ${HIGHER_LIMITS}`,
  day: `Limită zilnică depășită: maxim ${DAY_CREDITS} credite pe zi (${CREDIT_UNIT}). Încearcă din nou mâine (UTC). ${HIGHER_LIMITS}`,
  month: `Limită lunară depășită: maxim ${MONTH_CREDITS} credite pe lună (${CREDIT_UNIT}). Limita se resetează la începutul lunii următoare (UTC). ${HIGHER_LIMITS}`,
  busy: "Alte apeluri ale acestui cont sunt încă în curs și rețin creditele rămase. Așteaptă câteva secunde și încearcă din nou.",
};

export class RateLimitError extends Error {
  readonly window: RateLimitWindow;

  constructor(window: RateLimitWindow) {
    super(MESSAGES[window]);
    this.name = "RateLimitError";
    this.window = window;
  }
}

/** Credits one tool call costs: one per record returned, at least one. */
export function creditsFor(n: number): number {
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

// Epoch ms at which a rejected call can be sent again. Day and month reset on UTC.
function resetAt(window: RateLimitWindow, now: number): number {
  if (window === "busy") {
    return now + BUSY_RETRY_MS;
  }
  if (window === "month") {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  const size = window === "day" ? DAY_MS : MINUTE_MS;
  return (Math.floor(now / size) + 1) * size;
}

/** Seconds until a call rejected on this window can be sent again. */
export function retryAfterSeconds(window: RateLimitWindow, now = Date.now()): number {
  return Math.max(1, Math.ceil((resetAt(window, now) - now) / 1000));
}

/**
 * What the calling agent should do about a rejected call or a used-up window. It goes into
 * the tool result, in English like the tool descriptions, because the agent reads it and then
 * writes to the user in the user's language. For the day and month windows it asks the agent
 * to stop calling and to point the user to the paid API plans. The other two only ask for a
 * pause.
 */
export function limitInstructions(window: RateLimitWindow, now = Date.now()): string {
  if (window === "minute" || window === "busy") {
    const wait = retryAfterSeconds(window, now);
    const pause = `Wait ${wait} ${wait === 1 ? "second" : "seconds"}`;
    return window === "minute"
      ? `Too many calls in one minute. ${pause}, then continue.`
      : `Other SICAP calls from this account are still running and hold the credits that are left. ${pause}, then retry this call, and send SICAP calls one at a time.`;
  }
  const reset = new Date(resetAt(window, now)).toISOString();
  return `The free SICAP.ai MCP allowance for this ${window} is used up (${DAY_CREDITS} credits a day, ${MONTH_CREDITS} a month, 1 credit = 1 contract returned). It resets at ${reset}. Do not call SICAP tools again before then. Tell the user this now, in their language, and tell them that the SICAP API has paid plans with higher limits: ${API_PRICING_URL}`;
}

// Row ids in `mcp_rate_limit`. The month index is year * 12 + month, on UTC. `held` rows are
// per minute, so credits held by a call that never settled stop counting after two minutes.
function windowsAt(userId: string, now: number) {
  const date = new Date(now);
  const minute = Math.floor(now / MINUTE_MS);
  const day = Math.floor(now / DAY_MS);
  const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
  return {
    minute: { id: `${userId}:${minute}`, windowStart: minute },
    day: { id: `${userId}:c:d:${day}`, windowStart: day },
    month: { id: `${userId}:c:m:${month}`, windowStart: month },
    held: { id: `${userId}:c:h:${minute}`, windowStart: minute },
    heldBefore: { id: `${userId}:c:h:${minute - 1}`, windowStart: minute - 1 },
  };
}

const addTo = (userId: string, row: { id: string; windowStart: number }, amount: number) =>
  db
    .insert(mcpRateLimit)
    .values({ id: row.id, userId, windowStart: row.windowStart, count: amount })
    .onConflictDoUpdate({
      target: mcpRateLimit.id,
      set: { count: sql`${mcpRateLimit.count} + ${amount}` },
    })
    .returning({ count: mcpRateLimit.count });

const read = (id: string) =>
  db
    .select({ count: mcpRateLimit.count })
    .from(mcpRateLimit)
    .where(sql`${mcpRateLimit.id} = ${id}`);

/** Credits held for one call in flight. */
export interface Reservation {
  now: number;
  credits: number;
}

/**
 * Per-user limiter backed by Turso. It counts calls per minute, and credits per UTC day and
 * per UTC month. The day and month rows hold settled credits only. Credits of calls still
 * running are held in a per-minute row, so parallel calls see each other.
 *
 * Call it before the tool runs with the most credits the call can cost. One batch adds one to
 * the minute counter, holds those credits, and reads the day and month counters. The call is
 * rejected with a `RateLimitError` when the day or month is used up, when the minute has too
 * many calls, or (`busy`) when calls still running hold the credits that are left. Otherwise
 * it passes, so an account can end a window at most one response over the allowance. After
 * the tool returns, `chargeCredits` adds the real cost and drops the hold; if the tool fails,
 * `releaseCredits` drops it. This approximates the credit ledger of the public API. It is not
 * exact metering.
 */
export async function enforceRateLimit(
  userId: string,
  maxCredits = 1,
  now = Date.now(),
): Promise<Reservation> {
  const reservation: Reservation = { now, credits: creditsFor(maxCredits) };
  const rows = windowsAt(userId, now);

  const [[minuteRow], [heldRow], heldBefore, dayRows, monthRows] = await db.batch([
    addTo(userId, rows.minute, 1),
    addTo(userId, rows.held, reservation.credits),
    read(rows.heldBefore.id),
    read(rows.day.id),
    read(rows.month.id),
  ]);
  const day = dayRows[0]?.count ?? 0;
  const month = monthRows[0]?.count ?? 0;
  // Each row is floored at zero, so a hold dropped twice cannot hide the holds of other calls.
  const heldNow = Math.max(reservation.credits, heldRow?.count ?? reservation.credits);
  const heldByOthers = heldNow - reservation.credits + Math.max(0, heldBefore[0]?.count ?? 0);

  // Longest wait first, so the message names the one that applies.
  let window: RateLimitWindow | null = null;
  if (month >= MONTH_CREDITS) {
    window = "month";
  } else if (day >= DAY_CREDITS) {
    window = "day";
  } else if (minuteRow && minuteRow.count > MINUTE_LIMIT) {
    window = "minute";
  } else if (day + heldByOthers >= DAY_CREDITS || month + heldByOthers >= MONTH_CREDITS) {
    window = "busy";
  }
  if (window) {
    // Best effort: a hold that stays behind stops counting after two minutes.
    await releaseCredits(userId, reservation).catch(() => {});
    throw new RateLimitError(window);
  }
  return reservation;
}

/** Drops the hold of a call that was rejected or whose tool failed. Nothing is charged. */
export async function releaseCredits(userId: string, reservation: Reservation): Promise<void> {
  const rows = windowsAt(userId, reservation.now);
  await db.batch([addTo(userId, rows.held, -reservation.credits)]);
}

/**
 * Charges a successful tool call and drops its hold. `n` is the number of records the call
 * returned. The credits go to the day and month of the call's start. `reached` names the
 * window this call used up, so the caller can tell the agent on the same response instead of
 * on the next, rejected one. Only the call whose charge crosses the allowance reports it.
 */
export async function chargeCredits(
  userId: string,
  reservation: Reservation,
  n: number,
): Promise<{ credits: number; reached: "day" | "month" | null }> {
  const credits = creditsFor(n);
  const rows = windowsAt(userId, reservation.now);
  const [[dayRow], [monthRow]] = await db.batch([
    addTo(userId, rows.day, credits),
    addTo(userId, rows.month, credits),
    addTo(userId, rows.held, -reservation.credits),
  ]);

  const crossed = (count: number, limit: number) => count >= limit && count - credits < limit;
  let reached: "day" | "month" | null = null;
  if (crossed(monthRow?.count ?? 0, MONTH_CREDITS)) {
    reached = "month";
  } else if (crossed(dayRow?.count ?? 0, DAY_CREDITS)) {
    reached = "day";
  }
  return { credits, reached };
}
