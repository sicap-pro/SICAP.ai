import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { mcp } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { Logger } from "next-axiom";

import {
  account,
  db,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  session,
  user,
  verification,
} from "../db/schema";
import { isAllowedRedirectUri, isServedAuthPath } from "./auth-checks";
import { addSubscriber, addSubscriberToLists, messageSubscriber } from "./listmonk";
import { env } from "./env";

const log = new Logger();

// Endpoints the app does not call. Better Auth answers 404 to HTTP requests for them; in-process
// `auth.api.*` calls (such as `getMcpSession` in `withMcpAuth`) are not affected.
const DISABLED_PATHS = [
  "/verify-email",
  "/link-social",
  "/unlink-account",
  "/update-user",
  "/get-access-token",
  "/refresh-token",
  "/list-sessions",
  "/list-accounts",
  "/account-info",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/update-session",
  "/mcp/get-session",
];

// `disabledPaths` matches only a pathname that starts with exactly `/api/auth/`. This answers 404
// to every other spelling before routing.
const servedPathsOnly = {
  id: "served-paths-only",
  onRequest: async (request) => {
    if (!isServedAuthPath(new URL(request.url).pathname)) {
      return { response: new Response(null, { status: 404 }) };
    }
  },
} satisfies BetterAuthPlugin;

function invalidRedirect(): APIError {
  return new APIError("BAD_REQUEST", {
    error: "invalid_redirect_uri",
    error_description: "redirect_uri must be a single https, http, claude or cursor URL",
  });
}

function bodyField(body: unknown, key: string): unknown {
  if (body instanceof FormData) {
    return body.get(key);
  }
  if (body && typeof body === "object") {
    return (body as Record<string, unknown>)[key];
  }
  return undefined;
}

function parseVerificationValue(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Runs before every endpoint, HTTP and in-process alike, so each branch is keyed on `ctx.path`
// and everything else returns at once.
const beforeHook = createAuthMiddleware(async (ctx) => {
  switch (ctx.path) {
    case "/mcp/register": {
      const uris = bodyField(ctx.body, "redirect_uris");
      if (!Array.isArray(uris) || !uris.every(isAllowedRedirectUri)) {
        throw invalidRedirect();
      }
      return;
    }
    case "/mcp/authorize": {
      if (!isAllowedRedirectUri(ctx.query?.redirect_uri)) {
        throw invalidRedirect();
      }
      // Always show the consent screen. The value is compared as a whole string, so it is
      // replaced, not appended to. Returning the query is what makes the change take effect.
      return { context: { query: { ...ctx.query, prompt: "consent" } } };
    }
    case "/mcp/token": {
      const code = bodyField(ctx.body, "code");
      if (bodyField(ctx.body, "grant_type") !== "authorization_code") {
        return;
      }
      if (typeof code !== "string" || code.length === 0) {
        return;
      }
      // Read without consuming: the endpoint consumes the code itself.
      const row = await ctx.context.internalAdapter.findVerificationValue(code);
      if (row && parseVerificationValue(row.value)?.requireConsent === true) {
        throw new APIError("UNAUTHORIZED", {
          error: "invalid_grant",
          error_description: "invalid code",
        });
      }
      return;
    }
    case "/oauth2/consent": {
      const consentCode = bodyField(ctx.body, "consent_code");
      if (typeof consentCode !== "string" || consentCode.length === 0) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_request",
          error_description: "consent_code is required in the body",
        });
      }
      const session = await getSessionFromCtx(ctx);
      if (!session) {
        throw new APIError("UNAUTHORIZED");
      }
      const row = await ctx.context.internalAdapter.findVerificationValue(consentCode);
      if (row && parseVerificationValue(row.value)?.userId !== session.user.id) {
        throw new APIError("UNAUTHORIZED", {
          error: "invalid_request",
          error_description: "Invalid code",
        });
      }
      return;
    }
    default:
      return;
  }
});

export const auth = betterAuth({
  baseURL: env.NEXTAUTH_URL,
  secret: env.NEXTAUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: {
      user,
      session,
      account,
      verification,
      oauthApplication,
      oauthAccessToken,
      oauthConsent,
    },
  }),
  socialProviders: {
    google: {
      clientId: env.GOOGLE_ID ?? "",
      clientSecret: env.GOOGLE_SECRET ?? "",
    },
  },
  disabledPaths: DISABLED_PATHS,
  hooks: {
    before: beforeHook,
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 300,
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (createdUser) => {
          const { id, email, name } = createdUser;
          log.info("User created", { userId: id });
          try {
            await addSubscriber({ email, name: name ?? email, attribs: { userId: id } });
            await addSubscriberToLists({ email, lists: ["users"] });
            await messageSubscriber({ email, template: "welcome" });
          } catch (_e) {
            log.error("Listmonk sync failed on user create", { userId: id });
          }
        },
      },
    },
    session: {
      create: {
        after: async (createdSession) => {
          const { userId } = createdSession;
          log.info("User signed in", { userId });
          await db.update(user).set({ updatedAt: new Date() }).where(eq(user.id, userId));
        },
      },
    },
  },
  plugins: [
    servedPathsOnly,
    mcp({
      loginPage: "/autentificare",
      oidcConfig: {
        loginPage: "/autentificare",
        consentPage: "/oauth/consent",
      },
    }),
    nextCookies(),
  ],
});
