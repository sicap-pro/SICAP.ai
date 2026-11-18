import { describe, expect, it } from "vitest";

import { buildCuiClauses, getCuiSearchTerms, normalizeIndexes } from "./search-contracts";

// Fields mapped as numbers in Elasticsearch. A phrase query carrying the "RO" prefix against
// one of these raises number_format_exception, which fails the entire search request.
const NUMERIC_MAPPED_FIELDS = [
  "item.nationalId",
  "noticeContracts.items.winner.fiscalNumberInt",
  "noticeContracts.items.winners.fiscalNumberInt",
];

describe("getCuiSearchTerms", () => {
  it("detects a bare CUI and derives the RO-prefixed form", () => {
    expect(getCuiSearchTerms("41897885")).toEqual({
      isCui: true,
      numeric: "41897885",
      roPrefixed: "RO41897885",
    });
  });

  it("detects an RO-prefixed CUI and derives the numeric form", () => {
    expect(getCuiSearchTerms("ro41897885")).toEqual({
      isCui: true,
      numeric: "41897885",
      roPrefixed: "RO41897885",
    });
  });

  it("does not treat free text as a CUI", () => {
    expect(getCuiSearchTerms("spital judetean")).toEqual({ isCui: false });
  });
});

describe("buildCuiClauses", () => {
  const terms = { numeric: "41897885", roPrefixed: "RO41897885" };

  it("searches both the numeric and the RO-prefixed form", () => {
    const queries = buildCuiClauses(terms, NUMERIC_MAPPED_FIELDS).map((c) => c.multi_match.query);

    expect(queries).toContain("41897885");
    expect(queries).toContain("RO41897885");
  });

  // Regression: https://github.com/ciocan/SICAP.ai/issues/77
  // Searching a CUI crashed the page because the RO-prefixed term was sent as a strict
  // match_phrase to item.nationalId, which is numeric. Every clause must tolerate a field
  // whose mapping cannot hold the term.
  it("never sends a term to a numeric field without tolerating a format mismatch", () => {
    const clauses = buildCuiClauses(terms, NUMERIC_MAPPED_FIELDS);

    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) {
      expect(clause.multi_match.lenient).toBe(true);
    }
  });

  it("queries every field it is given", () => {
    const clauses = buildCuiClauses(terms, NUMERIC_MAPPED_FIELDS);

    for (const clause of clauses) {
      expect(clause.multi_match.fields).toEqual(NUMERIC_MAPPED_FIELDS);
    }
  });
});

describe("normalizeIndexes", () => {
  const known = ["idx-public", "idx-direct", "idx-offline"];

  it("uses all known indexes when db is undefined", () => {
    expect(normalizeIndexes(undefined, known)).toEqual(known);
  });

  it("uses all known indexes for an empty list", () => {
    expect(normalizeIndexes([], known)).toEqual(known);
  });

  it("splits a comma separated string and trims entries", () => {
    expect(normalizeIndexes("idx-direct, idx-offline", known)).toEqual([
      "idx-direct",
      "idx-offline",
    ]);
  });

  it("flattens a repeated-key array and removes duplicates", () => {
    expect(normalizeIndexes(["idx-direct", "idx-direct,idx-public"], known)).toEqual([
      "idx-direct",
      "idx-public",
    ]);
  });

  it("drops unknown names from a mixed list", () => {
    expect(normalizeIndexes(["idx-offline", "other", "idx-*"], known)).toEqual(["idx-offline"]);
  });

  it("does not treat a wildcard as an index", () => {
    expect(normalizeIndexes("*", known)).toEqual(known);
  });

  it("uses all known indexes when only unknown names remain", () => {
    expect(normalizeIndexes(["foo", "bar,baz"], known)).toEqual(known);
  });
});
