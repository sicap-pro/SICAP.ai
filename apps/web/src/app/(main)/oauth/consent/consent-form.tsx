"use client";

import { useState } from "react";
import { isAllowedRedirectUri } from "@/lib/auth-checks";

export function ConsentForm({ consentCode }: { consentCode: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function decide(accept: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });
      const data = (await res.json().catch(() => null)) as { redirectURI?: unknown } | null;
      // Navigate only to a URL whose scheme is on the allowed list.
      if (res.ok && isAllowedRedirectUri(data?.redirectURI)) {
        window.location.href = data.redirectURI;
        return;
      }
    } catch {
      // Falls through to the error state below.
    }
    setFailed(true);
    setBusy(false);
  }

  return (
    <>
      <div className="mt-8 flex gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(true)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Permite
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(false)}
          className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          Refuză
        </button>
      </div>
      {failed && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          Nu am putut finaliza cererea. Pornește din nou conectarea din aplicația care a cerut
          accesul.
        </p>
      )}
    </>
  );
}
