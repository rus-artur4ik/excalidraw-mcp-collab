import {describe, expect, it} from "vitest";

import {contrastRatio, parseColor} from "../colors";

describe("parseColor", () => {
  it("parses shorthand and full hex", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#1e1e1e")).toEqual({ r: 30, g: 30, b: 30 });
  });

  it("resolves named colors", () => {
    expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("returns null for malformed hex instead of NaN channels", () => {
    expect(parseColor("#zzz")).toBeNull();
    expect(parseColor("#12")).toBeNull();
    expect(parseColor("not-a-color")).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is maximal for black on white", () => {
    expect(
      contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }),
    ).toBeCloseTo(21, 0);
  });
});
