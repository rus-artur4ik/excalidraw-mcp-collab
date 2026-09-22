import * as fs from "fs";

import {afterEach, describe, expect, it} from "vitest";

import {
    getFontsDir,
    getVendoredFontFiles,
    getVerticalOffset,
    glyphMetrics,
    isFontFamilyAvailable,
    pairKerning,
    resetFontsForTests,
    splitFontRuns,
    svgFontFamily,
    uncoveredChars,
} from "../fonts";
import {
    getLineWidth,
    legacyTextMetricsProvider,
    measureText,
} from "../textMetrics";

// Sum of advances plus pair kerning, straight from the font tables.
const advanceSum = (text: string, fontFamily: number): number => {
  let total = 0;
  let previous: string | null = null;
  for (const char of text) {
    const glyph = glyphMetrics(char, fontFamily);
    if (!glyph) {
      throw new Error(`no glyph for ${char}`);
    }
    total += glyph.advance / glyph.unitsPerEm;
    if (previous) {
      total += pairKerning(previous, char, fontFamily) / glyph.unitsPerEm;
    }
    previous = char;
  }
  return total;
};

describe("vendored fonts", () => {
  it("finds every client font file", () => {
    expect(getFontsDir()).not.toBeNull();
    const files = getVendoredFontFiles();
    expect(files.length).toBe(8);
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(true);
    }
    for (const family of [1, 2, 3, 5, 6, 7, 8, 9, 10]) {
      expect(isFontFamilyAvailable(family)).toBe(true);
    }
  });

  it("names SVG families exactly as the files declare them", () => {
    expect(svgFontFamily(5)).toBe("Excalifont, 'Liberation Sans', sans-serif");
    expect(svgFontFamily(6)).toBe("Nunito, 'Liberation Sans', sans-serif");
    expect(svgFontFamily(3)).toBe("'Cascadia Code', monospace");
    expect(svgFontFamily(2)).toBe("'Liberation Sans', sans-serif");
    expect(svgFontFamily(8)).toBe("'Comic Shanns', 'Cascadia Code', monospace");
  });

  it("covers Cyrillic in Excalifont, Nunito and Cascadia", () => {
    for (const family of [5, 6, 3]) {
      expect(uncoveredChars("Съешь же ещё этих мягких булок", family)).toEqual([]);
    }
  });
});

describe("font-backed text metrics", () => {
  const samples = ["Hello, World", "AVATAR Tokyo", "Привет, мир", "Кольцо чтения: getMessage"];

  it.each([5, 6, 3])("equals the sum of font advances and kerning (family %i)", (family) => {
    for (const text of samples) {
      expect(getLineWidth(text, 20, family)).toBeCloseTo(advanceSum(text, family) * 20, 6);
    }
  });

  it("applies GPOS pair kerning, Cyrillic included", () => {
    for (const pair of ["VA", "To", "ТА"]) {
      expect(pairKerning(pair[0], pair[1], 5)).toBeLessThan(0);
      const kerned = getLineWidth(pair, 20, 5);
      const separate = getLineWidth(pair[0], 20, 5) + getLineWidth(pair[1], 20, 5);
      expect(kerned).toBeLessThan(separate);
    }
  });

  it("matches HarfBuzz shaping of the client's woff2 subsets", () => {
    // Widths in em from HarfBuzz (Chrome's shaper) on the original client
    // woff2 files, each character taken from the face the browser picks by
    // unicode-range. Ligatures aside, canvas measureText reports the same.
    const reference: Array<[number, string, number]> = [
      [5, "Hello, World", 5.415],
      [5, "AVATAR Tokyo", 7.363],
      [5, "Привет, мир", 5.491],
      [5, "Кольцо чтения: getMessage", 13.241],
      [6, "AVATAR Tokyo", 6.818],
      [6, "Кольцо чтения: getMessage", 13.021],
      [3, "Привет, мир", 6.4453],
      [9, "AVATAR Tokyo", 6.5762],
      [9, "Привет, мир", 5.5815],
    ];
    for (const [family, text, em] of reference) {
      expect(getLineWidth(text, 1, family)).toBeCloseTo(em, 3);
    }
  });

  it("measures Cyrillic in Excalifont narrower than the old advance table", () => {
    const text = "Сервис чтения";
    expect(getLineWidth(text, 20, 5)).toBeLessThan(
      legacyTextMetricsProvider.getLineWidth(text, 20, 5),
    );
  });

  it("keeps Cascadia monospaced across scripts", () => {
    const latin = getLineWidth("abcdefghij", 20, 3);
    expect(getLineWidth("МММММММММ!", 20, 3)).toBeCloseTo(latin, 6);
    expect(getLineWidth("iiiiiiiiii", 20, 3)).toBeCloseTo(latin, 6);
  });

  it("measures glyphs no vendored font has with the old table", () => {
    const withEmoji = getLineWidth("a😀", 20, 5);
    expect(withEmoji - getLineWidth("a", 20, 5)).toBeCloseTo(20, 6);
  });

  it("gives zero width to combining marks and format characters", () => {
    expect(getLineWidth("a\u200d", 20, 5)).toBeCloseTo(getLineWidth("a", 20, 5), 6);
  });
});

describe("vertical metrics", () => {
  it("follows the client's getVerticalOffset", () => {
    // Excalifont: 20px, line height 1.25 → ascender 17.72, descender 7.48.
    expect(getVerticalOffset(5, 20, 25)).toBeCloseTo(17.62, 6);
    // Cascadia uses 2048 units per em.
    const size = 16;
    const lineHeightPx = size * 1.2;
    const em = size / 2048;
    expect(getVerticalOffset(3, size, lineHeightPx)).toBeCloseTo(
      em * 1900 + (lineHeightPx - em * 1900 - em * 480) / 2,
      6,
    );
  });

  it("keeps the client's line heights in measureText", () => {
    expect(measureText("a\nb", 20, 5).height).toBeCloseTo(50, 6);
    expect(measureText("a\nb", 20, 3).height).toBeCloseTo(48, 6);
  });
});

describe("glyph coverage", () => {
  it("does not flag glyphs the client's generic fallback stand-in covers", () => {
    expect(uncoveredChars("A → B", 5)).toEqual([]);
  });

  it("flags glyphs only system fonts have", () => {
    expect(uncoveredChars("ok ✓ 漢", 5).sort()).toEqual(["✓", "漢"].sort());
  });

  it("splits a line into runs by the font that draws it", () => {
    expect(splitFontRuns("A → B", 5)).toEqual([
      { text: "A ", family: null },
      { text: "→", family: "'Liberation Sans', sans-serif" },
      { text: " B", family: null },
    ]);
    expect(splitFontRuns("plain", 5)).toEqual([{ text: "plain", family: null }]);
    const runs = splitFontRuns("x ★", 5);
    expect(runs[runs.length - 1]).toEqual({ text: "★", family: "sans-serif" });
  });

  it("run widths add up to the line width", () => {
    const line = "Итого → 42 ✓ done";
    const sum = splitFontRuns(line, 5).reduce(
      (total, run) => total + getLineWidth(run.text, 20, 5),
      0,
    );
    expect(sum).toBeCloseTo(getLineWidth(line, 20, 5), 6);
  });
});

describe("missing font files", () => {
  afterEach(() => resetFontsForTests());

  it("falls back to the old table and flags every visible glyph", () => {
    resetFontsForTests(null);
    expect(isFontFamilyAvailable(5)).toBe(false);
    expect(getLineWidth("Привет", 20, 5)).toBeCloseTo(
      legacyTextMetricsProvider.getLineWidth("Привет", 20, 5),
      6,
    );
    expect(uncoveredChars("ab c", 5).sort()).toEqual(["a", "b", "c"]);
    expect(getVendoredFontFiles()).toEqual([]);
  });
});
