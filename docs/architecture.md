# Architecture deep dives

Detailed mechanics that don't belong in the scannable `CLAUDE.md`. Link here from there.

## MCP Server

Lets authenticated users query the procurement data from Claude (claude.ai, Desktop, Code) and other MCP-capable agents (Cursor, VS Code) via an OAuth-authenticated, remote MCP server hosted inside the Next.js app. The data is public; auth exists for one-click distribution, per-user identity, rate limiting, and usage analytics.

Design spec: `docs/superpowers/specs/2026-05-26-mcp-server-design.md`. Implementation plan: `docs/superpowers/plans/2026-05-26-mcp-server.md`.

### How it fits together

```
Claude / agent
  │  discover  → GET /.well-known/oauth-authorization-server   (oAuthDiscoveryMetadata)
  │            → GET /.well-known/oauth-protected-resource     (oAuthProtectedResourceMetadata)
  │  register  → Dynamic Client Registration (open) → oauthApplication row
  │  authorize → /autentificare (Google) → /oauth/consent → code
  │  token     → access + refresh tokens (oauthAccessToken)
  │  call      → POST /api/mcp  (Authorization: Bearer <token>)
  ▼
withMcpAuth(auth, (req, session) => createMcpHandler(...)(req))   // session = { userId, scopes, accessToken }
  ▼
enforceRateLimit(userId, maxCredits) → tool handler → packages/api fn → Elasticsearch → chargeCredits(userId, reservation, n)
  ▼
compact JSON  +  Axiom "mcp.tool" event { userId, tool, query, n, credits, latencyMs, status }
```

### Auth

`apps/web/src/lib/auth.ts` enables the Better Auth `mcp` plugin (`loginPage: "/autentificare"`, `oidcConfig.consentPage: "/oauth/consent"`). This turns the app into an OAuth 2.0 provider with open Dynamic Client Registration. The three OAuth tables (`oauthApplication`, `oauthAccessToken`, `oauthConsent`) are registered in the drizzle adapter `schema` and were generated from `@better-auth/cli generate` (authoritative field names for the installed version).

A `hooks.before` in `auth.ts` shapes the flow: `/mcp/authorize` always runs with `prompt=consent`, so every authorization shows the consent screen, and `/mcp/register` and `/mcp/authorize` accept only redirect URIs that parse as a single `https:`, `http:`, `claude:` or `cursor:` URL (`lib/auth-checks.ts`; add a scheme there when a new client needs one). `/mcp/token` redeems a code only after consent was given, and `/oauth2/consent` takes the `consent_code` from the request body for the signed-in user who started the request. Better Auth endpoints the app never calls are listed in `disabledPaths`; in-process `auth.api.*` calls are unaffected.

### Transport & files

Self-hosted via Docker (long-lived Node), so the server uses the stateless **Streamable HTTP** transport — no Redis.

| Path | File | Purpose |
|------|------|---------|
| `POST /api/mcp` (+ `[transport]`) | `apps/web/src/app/api/[transport]/route.ts` | `withMcpAuth` + `createMcpHandler` (`mcp-handler`), `basePath: "/api"`; exports `GET/POST/DELETE` |
| `/.well-known/oauth-authorization-server` | `apps/web/src/app/.well-known/.../route.ts` | `oAuthDiscoveryMetadata(auth)` |
| `/.well-known/oauth-protected-resource` | `apps/web/src/app/.well-known/.../route.ts` | `oAuthProtectedResourceMetadata(auth)` |
| `/oauth/consent` | `apps/web/src/app/(main)/oauth/consent/` | Styled consent screen; shows the client name, redirect host and scopes of the pending request stored under `consent_code`, and posts `{ accept, consent_code }` to `/api/auth/oauth2/consent` |
| `/mcp` | `apps/web/src/app/(main)/mcp/page.tsx` | Public connector docs + setup snippets |
| helpers | `apps/web/src/lib/mcp/` | `format.ts` (compact projection), `index-map.ts` (ES index ↔ slug), `contracts.ts` (dispatch), `rate-limit.ts` |

### Tools (read-only)

All wrap `packages/api`. Results are compact JSON; `search_contracts` returns ≤50 rows (default 10) projected to `{ id, type, object, authority, supplier, value, date, cpv, url }` + `totalCount`; detail tools return the full document.

| Tool | Backing fn(s) |
|------|---------------|
| `search_contracts` | `searchContracts` |
| `get_contract` | `getContractLicitatii` / `getContractAchizitii` / `getContractAchizitiiOffline` (via `getContractBySlug`) |
| `get_company` | `getCompanyByNationalId` + `getCompanyTopAuthorities` |
| `get_authority` | `getAuthorityByNationalId` + `getAuthorityTopSuppliers` |
| `get_locality_stats` | `getLocalityStats` + top authorities/companies/CPV |
| `get_totals` | `getTotal` |

The dataset discriminator is the slug `licitatii | achizitii | achizitii-offline`. `IndexName` from `@sicap/api` is the **raw ES index name**, so the route maps index → slug (`indexToSlug`) for output and slug → index (`slugToIndex`) for the `db` filter, reusing the app's `databases` table in `@/utils`.

### Rate limiting & telemetry

`lib/mcp/rate-limit.ts` limits each user in three windows on `mcp_rate_limit`: 60 calls per minute, 100 credits per UTC day and 1,000 credits per UTC month. A credit is one contract returned, with a minimum of one per call (`creditsFor`), the unit https://api.sicap.ai/pricing sells. `search_contracts` costs one credit per row. `get_company` and `get_authority` cost one credit per contract in the profile's `items` (up to 20). `get_contract`, `get_locality_stats` and `get_totals` cost one. The two credit allowances equal the free API plan. They are constants in that file; change them there.

`enforceRateLimit(userId, maxCredits)` runs before the tool with the most the call can cost (`clampPerPage(perPage)` for a search, 20 for `get_company` and `get_authority`, 1 otherwise). The day row (`${userId}:c:d:${day}`) and the month row (`${userId}:c:m:${year * 12 + month}`) hold settled credits only. Credits of calls still running are held in a per-minute row (`${userId}:c:h:${minute}`). One `db.batch` adds one to the minute row (`${userId}:${minute}`), adds the hold, and reads the hold of the minute before and the day and month rows. The adds are `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` upserts, so parallel calls see each other. The call is rejected in this order: month used up, day used up, more than 60 calls this minute, then `busy` when the settled credits plus the holds of other calls reach the day or month allowance. Otherwise it passes, so an account can end a window at most one response over (49 credits). A rejected call drops its hold and charges nothing, so retries do not use up the month.

After the tool returns, `chargeCredits` adds the real cost to the day and month rows and drops the hold. If the tool throws, the route drops the hold with `releaseCredits` and logs `mcp.release_failed` if that write fails. A failed drop after a rejection is not logged. Either way the hold stops counting within two minutes. Charges go to the day and month of the call's start, and the reset times in the messages are computed from the same timestamp. A hold that is never dropped (a process killed mid-call) stops counting after two minutes, because only the current and the previous minute's hold rows are read.

`busy` is a transient rejection, not a used-up allowance: its message and `instructions` ask the agent to wait 3 seconds and retry, one call at a time, and do not mention the API plans. It depends on what other calls hold, not on how close the account is to the limit: a search holds its full `perPage` until it returns, so on a fresh account the third of three parallel 50-row searches gets `busy` while the first two run. With the default `perPage` of 10, ten can run at once.

This is an approximation of the public API's credit ledger, not a shared wallet. A paid API plan does not raise the MCP allowance. The `${userId}:d:${day}` rows from the earlier 500 calls a day limit are no longer read. The day, month and minute messages are in Romanian and point to https://api.sicap.ai/ for higher limits. Better Auth's own limiter can't see MCP-adapter traffic, so tools enforce this directly. Each call logs an Axiom `mcp.tool` event with `userId`, `tool`, args (incl. query text), `n`, `credits`, `limitReached` (set on the call that uses up a day or month), `latencyMs`, and `status` (`ok` / `rate_limited` / `error`).

Tool failures return an MCP tool error (`isError: true`) with the same `{ error }` JSON text; rate-limit errors also carry `retryAfter` in seconds. They also carry `instructions`, English text from `limitInstructions` written for the calling agent: for the day and month windows it says to stop calling, to tell the user the free allowance is used up and when it resets, and to point them to the paid plans at https://api.sicap.ai/pricing. For the minute and `busy` rejections it only says how long to wait. The successful call whose charge crosses an allowance gets the day or month text as a second content block (`chargeCredits` reports the window in `reached`, on that one call only, from the settled counters), so the user hears about it even if the agent makes no further call. An expired access token gets the same 401 and `WWW-Authenticate` response as a missing one, so clients refresh the token. Signed-in `/cauta` results and MCP tool calls write one `account_read` usage log line each (`lib/account-read.ts`), with per-account read counters for the Bucharest calendar day and a ten-minute window kept in `mcp_rate_limit` under `${userId}:r:d:${day}` and `${userId}:r:t:${bucket}`.

### Gotchas

- **BotID:** `next.config.ts` wraps the app in `withBotId`, but it only blocks where code calls `checkBot()`. The MCP route deliberately does **not** call it — MCP clients are bots and must not be blocked.
- **`mcp-handler`, not `@vercel/mcp-adapter`:** the latter is now a deprecated empty stub; the live package is `mcp-handler` (same `createMcpHandler` API).
- **tsc OOM:** the MCP SDK's generic `server.tool()` overloads trigger TS2589 ("type instantiation excessively deep") and exhaust tsc's heap. The route registers tools through a minimal local `McpToolServer` interface (generic over the handler's `Args`) so the compiler skips that inference; Zod still validates inputs at runtime.
- **Migrations:** `0001_woozy_mauler.sql` (the OAuth + rate-limit tables) must be applied with `pnpm db:migrate` against the target database. It is additive only.

## Search and page inputs

`apps/web/src/utils/params.ts` holds the shared parsing for URL input. Page size is an integer from 1 to 100 (default 20, matching the largest option in `components/per-page.tsx`) on `/cauta` and on the company and authority lists; the MCP tools keep their own cap of 50 (`clampPerPage`). A repeated query key is read as its last value. `db` is a list by design: `normalizeIndexes` in `packages/api/src/es/search-contracts.ts` splits it on commas, keeps the three search indexes and falls back to all three when none is given. A search text longer than 2,000 characters returns no results without querying Elasticsearch. Entity and contract pages answer not-found for an id segment that contains a quote or an angle bracket; ids are otherwise free-form (`RO` prefixes, foreign ids with dots, hyphens and parentheses all occur).

## OG images

`/og/[id]/[token]?title=` renders the social preview image. The token is an HMAC over `{ id, title }` with `OG_SECRET` (`apps/web/src/utils/og.ts`), so the image shows only the title the page was built with. Tokens issued before the title was part of the signature cover the id alone; they still resolve and render a generic site title.

## harta-firmelor.ro links

sicap.ai and [harta-firmelor.ro](https://harta-firmelor.ro) share an owner and the ONRC data. sicap links out to harta on purpose, with plain anchors that carry link equity (issue #82, harta#1176). The rules:

- `apps/web/src/lib/harta-firmelor.ts` owns the origin and the URL builders. `isEmbeddableCui` gates everything: a bare 4 to 10 digit CUI gets a link, anything else (consortium ids, legacy ids) gets nothing, because harta answers 404 for those.
- `components/harta-firmelor-link.tsx` is the one anchor to `https://harta-firmelor.ro/firma/<cui>`, rendered in server HTML. `rel="noopener"` only. Never add `nofollow` or `sponsored`.
- Both firm pages render it. `/firma/[nationalId]` gets it under the framed card (`harta-firmelor-card.tsx`), and `/achizitii/firma/[id]` (`company-achizitii.tsx`, the URL the sitemap advertises and search engines rank) gets it without the frame, plus a link to `/firma/<cui>`. That route's `[id]` is e-licitatie's supplier entityId, not a CUI, so both links come from `supplier.numericFiscalNumber` in the query result.
- The framed card loads harta's `/embed/.../bare` variant, which harta serves `noindex, nofollow`. That is why the anchor lives outside the frame. The card stays on the company page only; `harta-firmelor-isolation.test.ts` greps the import graph and the JSX to keep it off the authority page and pins the anchor rules above.
- The footer links the harta home through `HARTA_FIRMELOR_ORIGIN`, and `/despre` carries one sentence with the same link.
- No link to harta's `/adresa/...` pages yet: that URL ends in harta's `address_key`, which sicap's ONRC index does not carry.
