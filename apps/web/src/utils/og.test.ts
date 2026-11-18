import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { OG_SECRET: "test-secret" } }));
vi.mock("@/config/site", () => ({ baseUrl: "https://example.test" }));

import { getOgImageUrl, getToken, isLegacyToken, verifyToken } from "./og";

describe("og tokens", () => {
  it("accepts a token for the same id and title", () => {
    const token = getToken("42", "Contract nr. 1");
    expect(verifyToken("42", "Contract nr. 1", token)).toBe(true);
  });

  it("rejects a token when the title changes", () => {
    const token = getToken("42", "Contract nr. 1");
    expect(verifyToken("42", "Alt titlu", token)).toBe(false);
  });

  it("recognizes a token that covers only the id", () => {
    const legacy = createHmac("sha256", "test-secret")
      .update(JSON.stringify({ id: "42" }))
      .digest("hex");
    expect(isLegacyToken("42", legacy)).toBe(true);
    expect(verifyToken("42", "Orice", legacy)).toBe(false);
    expect(isLegacyToken("42", getToken("42", "Orice"))).toBe(false);
  });

  it("returns false for tokens of the wrong length", () => {
    expect(verifyToken("42", "t", "abc")).toBe(false);
    expect(verifyToken("42", "t", "")).toBe(false);
    expect(isLegacyToken("42", "abc")).toBe(false);
  });

  it("keeps a title with & and diacritics intact through the URL", () => {
    const title = "Lucrări & servicii: Șoseaua Ștefan #1";
    const url = new URL(getOgImageUrl("7", title));
    const decoded = url.searchParams.getAll("title").at(-1) ?? "";
    expect(decoded).toBe(title);
    const token = url.pathname.split("/").filter(Boolean)[2];
    expect(verifyToken("7", decoded, token ?? "")).toBe(true);
  });
});
