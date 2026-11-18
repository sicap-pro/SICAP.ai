// Pure checks shared by the Better Auth config (server) and the OAuth consent form (client).
// Keep this module free of server-only imports.

/** URL schemes an OAuth client may register and be redirected to. */
export const ALLOWED_REDIRECT_PROTOCOLS: readonly string[] = [
  "https:",
  "http:",
  "claude:",
  "cursor:",
];

/**
 * True when `value` is a single redirect URI string that parses as a URL with an allowed scheme.
 * Arrays (a repeated query key) and values with a comma are refused: Better Auth stores a client's
 * redirect URIs as one comma-joined string.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.includes(",")) {
    return false;
  }
  try {
    return ALLOWED_REDIRECT_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const AUTH_BASE_PATH = "/api/auth";

/**
 * True when `pathname` is under the auth base path exactly once. Better Auth's router strips every
 * occurrence of the base path, so other spellings would reach the same endpoints under a name that
 * `disabledPaths` does not list.
 */
export function isServedAuthPath(pathname: string): boolean {
  return pathname.startsWith(`${AUTH_BASE_PATH}/`) && pathname.indexOf(AUTH_BASE_PATH, 1) === -1;
}
