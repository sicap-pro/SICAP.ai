import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, oauthApplication } from "@/db/schema";
import { auth } from "@/lib/auth";
import { isAllowedRedirectUri } from "@/lib/auth-checks";
import { ConsentForm } from "./consent-form";

const SCOPE_LABELS: Record<string, string> = {
  openid: "Identitatea contului tău",
  profile: "Numele și datele de profil",
  email: "Adresa de email",
  offline_access: "Acces continuu (reîmprospătare token)",
};

type PendingRequest = {
  clientName: string;
  redirectHost: string;
  scopes: string[];
};

// Everything shown comes from the stored authorization request for `consent_code`, never from
// other query parameters.
async function loadPendingRequest(
  consentCode: string | undefined,
  userId: string,
): Promise<PendingRequest | null> {
  if (!consentCode) {
    return null;
  }
  const ctx = await auth.$context;
  const row = await ctx.internalAdapter.findVerificationValue(consentCode);
  if (!row || new Date(row.expiresAt) < new Date()) {
    return null;
  }

  let value: {
    clientId?: unknown;
    redirectURI?: unknown;
    scope?: unknown;
    userId?: unknown;
    requireConsent?: unknown;
  };
  try {
    value = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (value.userId !== userId || value.requireConsent !== true) {
    return null;
  }
  if (typeof value.clientId !== "string" || !isAllowedRedirectUri(value.redirectURI)) {
    return null;
  }

  const [client] = await db
    .select({ name: oauthApplication.name })
    .from(oauthApplication)
    .where(eq(oauthApplication.clientId, value.clientId))
    .limit(1);
  if (!client) {
    return null;
  }

  const scopes = Array.isArray(value.scope)
    ? value.scope.filter((s): s is string => typeof s === "string")
    : [];

  return {
    clientName: client.name?.trim() || "Aplicație fără nume",
    redirectHost: new URL(value.redirectURI).host || new URL(value.redirectURI).protocol,
    scopes,
  };
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ consent_code?: string | string[] }>;
}) {
  const { consent_code } = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null);

  if (!session) {
    redirect("/autentificare");
  }

  const consentCode = typeof consent_code === "string" ? consent_code : undefined;
  const pending = await loadPendingRequest(consentCode, session.user.id);

  if (!pending || !consentCode) {
    return (
      <div className="mx-auto max-w-md px-4 py-12">
        <h1 className="text-xl font-semibold">Cererea de autorizare nu este valabilă</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cererea a expirat, a fost deja folosită sau nu aparține contului tău. Pornește din nou
          conectarea din aplicația care a cerut accesul.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-xl font-semibold">Autorizează accesul</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Aplicația <span className="font-medium text-foreground">{pending.clientName}</span> cere
        acces la contul tău SICAP.ai pentru:
      </p>
      <ul className="mt-4 space-y-2 text-sm">
        {pending.scopes.map((s) => (
          <li key={s} className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            <span>{SCOPE_LABELS[s] ?? s}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted-foreground">
        După confirmare vei fi redirecționat către{" "}
        <span className="font-medium text-foreground">{pending.redirectHost}</span>.
      </p>
      <ConsentForm consentCode={consentCode} />
    </div>
  );
}
