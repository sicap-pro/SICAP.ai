import { describe, expect, it } from "vitest";

import {
  hasDisallowedSegmentChars,
  isQueryLengthOk,
  lastValue,
  parsePage,
  parsePerPage,
} from "./params";

describe("lastValue", () => {
  it("returns the last entry of a repeated key", () => {
    expect(lastValue(["a", "b"])).toBe("b");
  });
  it("returns single values and undefined unchanged", () => {
    expect(lastValue("a")).toBe("a");
    expect(lastValue(undefined)).toBeUndefined();
  });
});

describe("parsePerPage", () => {
  it("defaults to 20", () => {
    expect(parsePerPage(undefined)).toBe(20);
    expect(parsePerPage("abc")).toBe(20);
    expect(parsePerPage("")).toBe(20);
  });
  it("floors at 1 and caps at 100", () => {
    expect(parsePerPage("0")).toBe(1);
    expect(parsePerPage("-5")).toBe(1);
    expect(parsePerPage("100000")).toBe(100);
  });
  it("keeps offered sizes and truncates decimals", () => {
    expect(parsePerPage("50")).toBe(50);
    expect(parsePerPage("10.9")).toBe(10);
    expect(parsePerPage(["10", "50"])).toBe(50);
  });
});

describe("parsePage", () => {
  it("is an integer of at least 1", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("x")).toBe(1);
    expect(parsePage("3.7")).toBe(3);
    expect(parsePage(["1", "4"])).toBe(4);
  });
});

describe("isQueryLengthOk", () => {
  it("accepts up to 2000 characters", () => {
    expect(isQueryLengthOk(undefined)).toBe(true);
    expect(isQueryLengthOk("a".repeat(2000))).toBe(true);
    expect(isQueryLengthOk("a".repeat(2001))).toBe(false);
  });
});

describe("hasDisallowedSegmentChars", () => {
  it("flags quotes and angle brackets, also when percent-encoded", () => {
    for (const s of ["a'b", 'a"b', "a<b", "a>b", "a%27b", "a%22b", "%3Cb%3E"]) {
      expect(hasDisallowedSegmentChars(s)).toBe(true);
    }
  });
  it("accepts irregular real ids", () => {
    for (const s of [
      "RO 12345678901",
      "RO12345678901",
      "123",
      "A-1.2(3);",
      "ab%20cd",
      "%E0%A4%A",
    ]) {
      expect(hasDisallowedSegmentChars(s)).toBe(false);
    }
  });
});
