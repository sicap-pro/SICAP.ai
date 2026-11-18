import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { Logger } from "next-axiom";
import { db, mcpRateLimit } from "@/db/schema";

export type AccountReadKind =
  | "notice"
  | "participant"
  | "award"
  | "company"
  | "contract"
  | "authority"
  | "list"
  | "inbox"
  | "mcp";

export type AccountReadVia = "page" | "sheet" | "search" | "inbox" | "mcp";

export interface AccountReadFields {
  userId: string;
  kind: AccountReadKind;
  id: string;
  n: number;
  via: AccountReadVia;
  ip?: string | null;
  nDay: number;
  n10m: number;
}

const BUCKET_MS = 600_000;

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Bucharest",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date in Europe/Bucharest as a YYYYMMDD number. */
export function bucharestDay(date: Date): number {
  const parts = dayFormat.formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return Number(`${pick("year")}${pick("month")}${pick("day")}`);
}

/** Client address from `x-real-ip`, else the first `x-forwarded-for` entry. */
export function requestIp(headers: { get(name: string): string | null }): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) {
    return real;
  }
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

const enc = (value: string | number) => encodeURIComponent(String(value));

/** One `account_read` usage log line with a fixed field order. */
export function formatAccountReadLine(f: AccountReadFields): string {
  return [
    "account_read",
    "site=sicap.ai",
    `userId=${enc(f.userId)}`,
    "plan=",
    `kind=${f.kind}`,
    `id=${enc(f.id)}`,
    `n=${f.n}`,
    `via=${f.via}`,
    `ip=${f.ip ? enc(f.ip) : ""}`,
    `nDay=${f.nDay}`,
    `n10m=${f.n10m}`,
    "threshold=-",
    "action=log",
  ].join(" ");
}

/** Short stable id for a list request: first 16 hex chars of SHA-256 over the search inputs. */
export function listRequestId(parts: {
  query: string;
  filters: unknown;
  page: number;
  perPage: number;
}): string {
  const json = JSON.stringify({
    query: parts.query,
    filters: sortKeys(parts.filters),
    page: parts.page,
    perPage: parts.perPage,
  });
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * Adds `n` to the per-account day and ten-minute read counters in `mcp_rate_limit`
 * (keys `${userId}:r:d:${day}` and `${userId}:r:t:${bucket}`) with atomic upserts in one
 * batch, then writes one `account_read` usage log line. Logging only: never throws.
 */
export async function recordAccountRead(input: {
  userId: string;
  kind: AccountReadKind;
  id: string;
  n: number;
  via: AccountReadVia;
  ip?: string | null;
}): Promise<void> {
  const log = new Logger();
  try {
    const { userId, n } = input;
    const now = Date.now();
    const day = bucharestDay(new Date(now));
    const bucket = Math.floor(now / BUCKET_MS);

    const upsert = (id: string, windowStart: number) =>
      db
        .insert(mcpRateLimit)
        .values({ id, userId, windowStart, count: n })
        .onConflictDoUpdate({
          target: mcpRateLimit.id,
          set: { count: sql`${mcpRateLimit.count} + ${n}` },
        })
        .returning({ count: mcpRateLimit.count });

    const [[dayRow], [bucketRow], prevRows] = await db.batch([
      upsert(`${userId}:r:d:${day}`, day),
      upsert(`${userId}:r:t:${bucket}`, bucket),
      db
        .select({ count: mcpRateLimit.count })
        .from(mcpRateLimit)
        .where(sql`${mcpRateLimit.id} = ${`${userId}:r:t:${bucket - 1}`}`),
    ]);

    const nDay = dayRow?.count ?? n;
    const n10m = (bucketRow?.count ?? n) + (prevRows[0]?.count ?? 0);
    log.info(formatAccountReadLine({ ...input, nDay, n10m }));
    await log.flush();
  } catch (err) {
    try {
      log.error("account_read.failed", { message: (err as Error).message });
      await log.flush();
    } catch {
      // logging must never break the caller
    }
  }
}
