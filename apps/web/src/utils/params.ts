export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;
export const MAX_QUERY_LENGTH = 2000;

type ParamValue = string | string[] | number | undefined | null;

/** Returns the last value when a query key is repeated, otherwise the value itself. */
export function lastValue<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}

function toInt(value: ParamValue): number | undefined {
  const single = lastValue(value as string | number | undefined | null);
  if (single === undefined || single === null || single === "") {
    return undefined;
  }
  const n = typeof single === "number" ? single : Number(single);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Page size as an integer between 1 and 100, defaulting to 20. */
export function parsePerPage(value: ParamValue): number {
  const n = toInt(value);
  if (n === undefined) {
    return DEFAULT_PER_PAGE;
  }
  return Math.min(MAX_PER_PAGE, Math.max(1, n));
}

/** Page number as an integer of at least 1. */
export function parsePage(value: ParamValue): number {
  const n = toInt(value);
  return n === undefined ? 1 : Math.max(1, n);
}

/** True when the search text is within the supported length. */
export function isQueryLengthOk(query: string | undefined): boolean {
  return (query ?? "").length <= MAX_QUERY_LENGTH;
}

const DISALLOWED_SEGMENT_CHARS = /['"<>]/;

/** True when the URL-decoded path segment contains a quote or an angle bracket. */
export function hasDisallowedSegmentChars(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment when it is not valid percent-encoding
  }
  return DISALLOWED_SEGMENT_CHARS.test(decoded) || DISALLOWED_SEGMENT_CHARS.test(segment);
}
