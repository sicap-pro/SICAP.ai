import { withMcpAuth } from "better-auth/plugins";
import { createMcpHandler } from "mcp-handler";
import { Logger } from "next-axiom";
import { after } from "next/server";
import { z } from "zod";
import {
  getAuthorityByNationalId,
  getAuthorityTopSuppliers,
  getCompanyByNationalId,
  getCompanyTopAuthorities,
  getLocalityStats,
  getLocalityTopAuthorities,
  getLocalityTopCompanies,
  getLocalityTopCpv,
  getTotal,
  searchContracts,
} from "@sicap/api";
import { listRequestId, recordAccountRead, requestIp } from "@/lib/account-read";
import { auth } from "@/lib/auth";
import { getContractBySlug } from "@/lib/mcp/contracts";
import { corsPreflight, withCors } from "@/lib/mcp/cors";
import { type ContractSlug, clampPerPage, toCompactRow } from "@/lib/mcp/format";
import { indexToSlug, slugToIndex } from "@/lib/mcp/index-map";
import { enforceRateLimit, RateLimitError } from "@/lib/mcp/rate-limit";

export const maxDuration = 60;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

type ReadSummary = { id: string; n: number };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DAY_LIMIT_MESSAGE = new RateLimitError("day").message;

// RateLimitError does not carry its window, so it is told apart by message.
function retryAfterSeconds(err: RateLimitError, now = Date.now()): number {
  if (err.message === DAY_LIMIT_MESSAGE) {
    return Math.max(1, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000));
  }
  return Math.max(1, Math.ceil((MINUTE_MS - (now % MINUTE_MS)) / 1000));
}

function unauthorizedResponse(): Response {
  const basePath = "/api/auth"; // auth.ts sets no basePath, so withMcpAuth uses this default
  const configured = auth.options.baseURL;
  let baseURL: string | undefined;
  if (typeof configured === "string" && configured) {
    // Same shape withMcpAuth builds: keep a URL that has a path, else append the base path.
    const hasPath = new URL(configured).pathname.replace(/\/+$/, "") !== "";
    baseURL = hasPath ? configured : `${configured.replace(/\/+$/, "")}${basePath}`;
  }
  const wwwAuthenticate = baseURL
    ? `Bearer resource_metadata="${baseURL}/.well-known/oauth-protected-resource"`
    : "Bearer";
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32e3,
        message: "Unauthorized: Authentication required",
        "www-authenticate": wwwAuthenticate,
      },
      id: null,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": wwwAuthenticate,
        "Access-Control-Expose-Headers": "WWW-Authenticate",
      },
    },
  );
}

// The MCP SDK's generic server.tool() overloads trigger TS2589 ("type instantiation is
// excessively deep") and exhaust tsc's heap. We register tools through this minimal
// interface so the compiler skips that inference; Zod still validates inputs at runtime.
// Args is inferred from each handler's explicit annotation, not from the Zod schema.
interface McpToolServer {
  tool: <Args>(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (args: Args) => Promise<ToolResult>,
  ) => void;
}

const asText = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const mcpHandler = withMcpAuth(auth, (req, session) => {
  const expiresAt = session.accessTokenExpiresAt
    ? new Date(session.accessTokenExpiresAt as unknown as string | number | Date)
    : null;
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    return unauthorizedResponse();
  }

  const userId = session.userId;
  const ip = requestIp(req.headers);
  const log = new Logger();

  const run = async (
    tool: string,
    meta: Record<string, unknown>,
    fn: () => Promise<unknown>,
    summarize: (data: unknown) => ReadSummary,
  ): Promise<ToolResult> => {
    const started = Date.now();
    try {
      await enforceRateLimit(userId);
      const data = await fn();
      const read = summarize(data);
      log.info("mcp.tool", {
        ...meta,
        userId,
        tool,
        n: read.n,
        latencyMs: Date.now() - started,
        status: "ok",
      });
      await log.flush();
      after(() =>
        recordAccountRead({ userId, kind: "mcp", id: read.id, n: read.n, via: "mcp", ip }),
      );
      return asText(data);
    } catch (err) {
      const status = err instanceof RateLimitError ? "rate_limited" : "error";
      log.error("mcp.tool", {
        ...meta,
        userId,
        tool,
        latencyMs: Date.now() - started,
        status,
        message: (err as Error).message,
      });
      await log.flush();
      const body: Record<string, unknown> = { error: (err as Error).message };
      if (err instanceof RateLimitError) {
        body.retryAfter = retryAfterSeconds(err);
      }
      return { ...asText(body), isError: true };
    }
  };

  return createMcpHandler(
    (serverRaw) => {
      const server = serverRaw as unknown as McpToolServer;

      server.tool(
        "search_contracts",
        "Search Romanian public procurement contracts. Datasets: licitatii (public tenders), achizitii (direct acquisitions), achizitii-offline. Returns compact rows; call get_contract for full detail. value is in RON, date is ISO, cpv is the CPV procurement-category code.",
        {
          query: z.string().describe("Free-text query: company, authority, object, or CPV"),
          db: z
            .array(z.enum(["licitatii", "achizitii", "achizitii-offline"]))
            .optional()
            .describe("Restrict to datasets; default all"),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          valueFrom: z.string().optional(),
          valueTo: z.string().optional(),
          cpv: z.string().optional(),
          authority: z.string().optional().describe("Contracting authority name or CUI"),
          supplier: z.string().optional().describe("Supplier company name or CUI"),
          euFunds: z.boolean().optional(),
          page: z.number().optional().describe("1-based page; default 1"),
          perPage: z.number().optional().describe("rows per page; default 10, max 50"),
        },
        async (args: {
          query: string;
          db?: ContractSlug[];
          dateFrom?: string;
          dateTo?: string;
          valueFrom?: string;
          valueTo?: string;
          cpv?: string;
          authority?: string;
          supplier?: string;
          euFunds?: boolean;
          page?: number;
          perPage?: number;
        }) =>
          run(
            "search_contracts",
            { query: args.query },
            async () => {
              const page = args.page ?? 1;
              const db = args.db?.map((s) => slugToIndex(s)).filter((v): v is string => Boolean(v));
              const result = await searchContracts({
                query: args.query,
                page,
                perPage: clampPerPage(args.perPage),
                filters: {
                  db,
                  dateFrom: args.dateFrom,
                  dateTo: args.dateTo,
                  valueFrom: args.valueFrom,
                  valueTo: args.valueTo,
                  cpv: args.cpv,
                  authority: args.authority,
                  supplier: args.supplier,
                  euFunds: args.euFunds,
                },
              });
              const rows = result.items.flatMap((it) => {
                const slug = indexToSlug(it.index);
                return slug ? [toCompactRow(it, slug)] : [];
              });
              return { totalCount: result.total, page, rows };
            },
            (data) => {
              const rows = (data as { rows: unknown[] }).rows;
              return {
                id: listRequestId({
                  query: args.query,
                  filters: {
                    db: args.db,
                    dateFrom: args.dateFrom,
                    dateTo: args.dateTo,
                    valueFrom: args.valueFrom,
                    valueTo: args.valueTo,
                    cpv: args.cpv,
                    authority: args.authority,
                    supplier: args.supplier,
                    euFunds: args.euFunds,
                  },
                  page: args.page ?? 1,
                  perPage: clampPerPage(args.perPage),
                }),
                n: rows.length,
              };
            },
          ),
      );

      server.tool(
        "get_contract",
        "Get the full detail of one contract by id and dataset slug (licitatii | achizitii | achizitii-offline).",
        {
          id: z.string(),
          type: z.enum(["licitatii", "achizitii", "achizitii-offline"]),
        },
        async (args: { id: string; type: ContractSlug }) =>
          run(
            "get_contract",
            { id: args.id, type: args.type },
            () => getContractBySlug(args.type, args.id),
            () => ({ id: args.id, n: 1 }),
          ),
      );

      server.tool(
        "get_company",
        "Look up a supplier company by its Romanian fiscal id (CUI/CIF). Returns the company profile plus the authorities it contracts with most.",
        { nationalId: z.string().describe("CUI / CIF fiscal number") },
        async (args: { nationalId: string }) =>
          run(
            "get_company",
            { nationalId: args.nationalId },
            async () => {
              const [profile, topAuthorities] = await Promise.all([
                getCompanyByNationalId({ nationalId: args.nationalId }),
                getCompanyTopAuthorities({ nationalId: args.nationalId }),
              ]);
              return { profile, topAuthorities };
            },
            () => ({ id: args.nationalId, n: 1 }),
          ),
      );

      server.tool(
        "get_authority",
        "Look up a contracting authority by its Romanian fiscal id (CUI/CIF). Returns the authority profile plus its top suppliers.",
        { nationalId: z.string().describe("CUI / CIF fiscal number") },
        async (args: { nationalId: string }) =>
          run(
            "get_authority",
            { nationalId: args.nationalId },
            async () => {
              const [profile, topSuppliers] = await Promise.all([
                getAuthorityByNationalId({ nationalId: args.nationalId }),
                getAuthorityTopSuppliers({ nationalId: args.nationalId }),
              ]);
              return { profile, topSuppliers };
            },
            () => ({ id: args.nationalId, n: 1 }),
          ),
      );

      server.tool(
        "get_locality_stats",
        "Procurement statistics for a Romanian locality: totals plus top authorities, companies, and CPV categories. Provide city and county (judet) names.",
        { city: z.string(), county: z.string().describe("Judet (county) name") },
        async (args: { city: string; county: string }) =>
          run(
            "get_locality_stats",
            { city: args.city, county: args.county },
            async () => {
              const [stats, topAuthorities, topCompanies, topCpv] = await Promise.all([
                getLocalityStats({ city: args.city, county: args.county }),
                getLocalityTopAuthorities({ city: args.city, county: args.county }),
                getLocalityTopCompanies({ city: args.city, county: args.county }),
                getLocalityTopCpv({ city: args.city, county: args.county }),
              ]);
              return { stats, topAuthorities, topCompanies, topCpv };
            },
            () => ({ id: `${args.county}/${args.city}`, n: 1 }),
          ),
      );

      server.tool(
        "get_totals",
        "Total indexed record counts per dataset (public tenders, direct acquisitions, offline).",
        {},
        async () =>
          run(
            "get_totals",
            {},
            () => getTotal(),
            () => ({ id: "totals", n: 1 }),
          ),
      );
    },
    { capabilities: { tools: {} } },
    { basePath: "/api", maxDuration: 60, verboseLogs: false },
  )(req);
});

// createMcpHandler doesn't add CORS; shared helpers in lib/mcp/cors keep the MCP transport and the
// OAuth routes consistent (see cors.ts for why both preflight and actual responses need it).
async function handler(req: Request): Promise<Response> {
  return withCors(await mcpHandler(req));
}

export const OPTIONS = corsPreflight;
export { handler as GET, handler as POST, handler as DELETE };
