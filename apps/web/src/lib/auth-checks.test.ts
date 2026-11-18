import { describe, expect, it } from "vitest";

import { isAllowedRedirectUri, isServedAuthPath } from "./auth-checks";

describe("isAllowedRedirectUri", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "http://localhost:6274/callback",
    "claude://x",
    "cursor://anysphere.cursor-mcp/oauth/callback",
  ])("accepts %s", (uri) => expect(isAllowedRedirectUri(uri)).toBe(true));

  it.each([
    ["a javascript: URI", "javascript:x"],
    ["a scheme split by a tab", "java\tscript:x"],
    ["a scheme after a control character", "\u0001javascript:x"],
    ["a data: URI", "data:text/html,x"],
    ["a string that does not parse", "not a url"],
    ["two URIs joined by a comma", "https://a.example,https://b.example"],
    ["an empty string", ""],
  ])("refuses %s", (_label, uri) => expect(isAllowedRedirectUri(uri)).toBe(false));

  it("refuses an array, as sent by a repeated query key", () => {
    expect(isAllowedRedirectUri(["https://a.example"])).toBe(false);
  });

  it("refuses values that are not strings", () => {
    expect(isAllowedRedirectUri(undefined)).toBe(false);
    expect(isAllowedRedirectUri(null)).toBe(false);
    expect(isAllowedRedirectUri(42)).toBe(false);
  });
});

describe("isServedAuthPath", () => {
  it.each(["/api/auth/get-session", "/api/auth/mcp/authorize", "/api/auth/oauth2/consent"])(
    "serves %s",
    (path) => expect(isServedAuthPath(path)).toBe(true),
  );

  it.each([
    "/Api/auth/api/auth/list-sessions",
    "/api/auth/api/auth/x",
    "/api/auth/x/api/auth/list-sessions",
    "/x/api/auth/y",
    "/api/auth",
    "/api/authx/get-session",
  ])("does not serve %s", (path) => expect(isServedAuthPath(path)).toBe(false));
});
