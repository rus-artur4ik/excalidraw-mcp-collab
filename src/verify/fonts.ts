import * as fs from "fs";
import * as path from "path";

import {DEFAULT_FONT_FAMILY} from "./model";

// The client's woff2 fonts, converted to TTF (resvg cannot read woff2) and with
// their unicode-range subsets merged back into one face per family. The files
// live in assets/fonts at the package root, two levels above both src/verify
// (vitest) and dist/verify (the Docker image).
type FontKey =
  | "excalifont"
  | "nunito"
  | "cascadia"
  | "liberation"
  | "virgil"
  | "lilita"
  | "comicShanns"
  | "assistant";

type FontSpec = { file: string; family: string };

const FONT_SPECS: Record<FontKey, FontSpec> = {
  excalifont: { file: "Excalifont/Excalifont-Regular.ttf", family: "Excalifont" },
  nunito: { file: "Nunito/Nunito-Regular.ttf", family: "Nunito" },
  cascadia: { file: "Cascadia/CascadiaCode-Regular.ttf", family: "Cascadia Code" },
  liberation: { file: "Liberation/LiberationSans-Regular.ttf", family: "Liberation Sans" },
  virgil: { file: "Virgil/Virgil-Regular.ttf", family: "Virgil" },
  lilita: { file: "Lilita/LilitaOne-Regular.ttf", family: "Lilita One" },
  comicShanns: { file: "ComicShanns/ComicShanns-Regular.ttf", family: "Comic Shanns" },
  assistant: { file: "Assistant/Assistant-Regular.ttf", family: "Assistant" },
};

type GenericFamily = "sans-serif" | "monospace";

type FamilyChain = {
  primary: FontKey;
  // Vendored stand-in for the client's generic fallback (the browser uses the
  // system sans-serif/monospace for glyphs the family lacks).
  fallback: FontKey | null;
  generic: GenericFamily;
};

// Mirrors getFontFamilyFallbacks in the client: every family falls back to a
// generic family; Helvetica (2) is a local font in the client, and Liberation
// Sans is its metric-compatible twin.
const FAMILY_CHAINS: Record<number, FamilyChain> = {
  1: { primary: "virgil", fallback: "liberation", generic: "sans-serif" },
  2: { primary: "liberation", fallback: null, generic: "sans-serif" },
  3: { primary: "cascadia", fallback: null, generic: "monospace" },
  5: { primary: "excalifont", fallback: "liberation", generic: "sans-serif" },
  6: { primary: "nunito", fallback: "liberation", generic: "sans-serif" },
  7: { primary: "lilita", fallback: "liberation", generic: "sans-serif" },
  8: { primary: "comicShanns", fallback: "cascadia", generic: "monospace" },
  9: { primary: "liberation", fallback: null, generic: "sans-serif" },
  10: { primary: "assistant", fallback: "liberation", generic: "sans-serif" },
};

const chainFor = (fontFamily?: number): FamilyChain =>
  FAMILY_CHAINS[fontFamily ?? DEFAULT_FONT_FAMILY] ??
  FAMILY_CHAINS[DEFAULT_FONT_FAMILY];

export const isKnownFontFamily = (fontFamily?: number): boolean =>
  FAMILY_CHAINS[fontFamily ?? DEFAULT_FONT_FAMILY] !== undefined;

// Copy of FONT_METADATA in the client (packages/common/src/font-metadata.ts),
// including its quirks (Assistant is declared with unitsPerEm 2048), because the
// client positions text with these numbers, not with the font files.
// Line heights live in model.ts (FONT_LINE_HEIGHTS), which matches the client.
export const FONT_METRICS: Record<
  number,
  { unitsPerEm: number; ascender: number; descender: number }
> = {
  1: { unitsPerEm: 1000, ascender: 886, descender: -374 },
  2: { unitsPerEm: 2048, ascender: 1577, descender: -471 },
  3: { unitsPerEm: 2048, ascender: 1900, descender: -480 },
  5: { unitsPerEm: 1000, ascender: 886, descender: -374 },
  6: { unitsPerEm: 1000, ascender: 1011, descender: -353 },
  7: { unitsPerEm: 1000, ascender: 923, descender: -220 },
  8: { unitsPerEm: 1000, ascender: 750, descender: -250 },
  9: { unitsPerEm: 2048, ascender: 1854, descender: -434 },
  10: { unitsPerEm: 2048, ascender: 1021, descender: -287 },
};

/** Client getVerticalOffset: distance from a line box's top to its alphabetic baseline. */
export const getVerticalOffset = (
  fontFamily: number | undefined,
  fontSize: number,
  lineHeightPx: number,
): number => {
  const { unitsPerEm, ascender, descender } =
    FONT_METRICS[fontFamily ?? DEFAULT_FONT_FAMILY] ?? FONT_METRICS[DEFAULT_FONT_FAMILY];
  const fontSizeEm = fontSize / unitsPerEm;
  const lineGap = (lineHeightPx - fontSizeEm * ascender + fontSizeEm * descender) / 2;
  return fontSizeEm * ascender + lineGap;
};

// --- Minimal TrueType reader: cmap, hmtx, name and GPOS pair kerning. ---

type Coverage = (glyph: number) => number;
type ClassDef = (glyph: number) => number;

type PairSubtable = (left: number, right: number) => number | null;

const popcount = (value: number): number => {
  let n = 0;
  for (let v = value & 0xff; v; v >>= 1) {
    n += v & 1;
  }
  return n;
};

// Only XAdvance changes the pen position; placements and device tables do not.
const xAdvanceOffset = (valueFormat: number): number | null =>
  valueFormat & 0x0004 ? popcount(valueFormat & 0x0003) * 2 : null;

class TrueTypeFont {
  readonly unitsPerEm: number;
  readonly family: string | null;
  private readonly view: DataView;
  private readonly tables = new Map<string, number>();
  private readonly cmap = new Map<number, number>();
  private readonly advances: Uint16Array;
  private readonly kernLookups: PairSubtable[][] = [];
  private readonly kernCache = new Map<number, number>();

  constructor(buffer: Buffer) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const numTables = this.u16(4);
    for (let i = 0; i < numTables; i++) {
      const record = 12 + i * 16;
      const tag = String.fromCharCode(
        this.view.getUint8(record),
        this.view.getUint8(record + 1),
        this.view.getUint8(record + 2),
        this.view.getUint8(record + 3),
      );
      this.tables.set(tag, this.u32(record + 8));
    }
    const head = this.table("head");
    this.unitsPerEm = this.u16(head + 18);
    this.advances = this.readAdvances();
    this.readCmap();
    this.family = this.readFamilyName();
    this.readKerning();
  }

  glyphIndex(codePoint: number): number {
    return this.cmap.get(codePoint) ?? 0;
  }

  advance(glyph: number): number {
    const n = this.advances.length;
    return n === 0 ? 0 : this.advances[Math.min(glyph, n - 1)];
  }

  /** Sum of GPOS 'kern' pair adjustments for an adjacent glyph pair, in font units. */
  kerning(left: number, right: number): number {
    if (!this.kernLookups.length) {
      return 0;
    }
    const key = left * 0x10000 + right;
    const cached = this.kernCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let total = 0;
    for (const subtables of this.kernLookups) {
      // Like HarfBuzz: the first subtable of a lookup that applies wins.
      for (const subtable of subtables) {
        const value = subtable(left, right);
        if (value !== null) {
          total += value;
          break;
        }
      }
    }
    this.kernCache.set(key, total);
    return total;
  }

  private u16(offset: number): number {
    return this.view.getUint16(offset);
  }

  private i16(offset: number): number {
    return this.view.getInt16(offset);
  }

  private u32(offset: number): number {
    return this.view.getUint32(offset);
  }

  private table(tag: string): number {
    const offset = this.tables.get(tag);
    if (offset === undefined) {
      throw new Error(`font has no ${tag} table`);
    }
    return offset;
  }

  private readAdvances(): Uint16Array {
    const hhea = this.table("hhea");
    const count = this.u16(hhea + 34);
    const hmtx = this.table("hmtx");
    const advances = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      advances[i] = this.u16(hmtx + i * 4);
    }
    return advances;
  }

  private readCmap(): void {
    const cmap = this.table("cmap");
    const numTables = this.u16(cmap + 2);
    let format4: number | null = null;
    let format12: number | null = null;
    for (let i = 0; i < numTables; i++) {
      const record = cmap + 4 + i * 8;
      const platform = this.u16(record);
      const encoding = this.u16(record + 2);
      const subtable = cmap + this.u32(record + 4);
      const format = this.u16(subtable);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode) {
        continue;
      }
      if (format === 12 && format12 === null) {
        format12 = subtable;
      } else if (format === 4 && format4 === null) {
        format4 = subtable;
      }
    }
    if (format12 !== null) {
      const groups = this.u32(format12 + 12);
      for (let i = 0; i < groups; i++) {
        const group = format12 + 16 + i * 12;
        const start = this.u32(group);
        const end = this.u32(group + 4);
        const glyph = this.u32(group + 8);
        for (let cp = start; cp <= end; cp++) {
          this.cmap.set(cp, glyph + (cp - start));
        }
      }
      return;
    }
    if (format4 === null) {
      return;
    }
    const segCount = this.u16(format4 + 6) / 2;
    const endCodes = format4 + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    for (let i = 0; i < segCount; i++) {
      const start = this.u16(startCodes + i * 2);
      const end = this.u16(endCodes + i * 2);
      const delta = this.u16(idDeltas + i * 2);
      const rangeOffset = this.u16(idRangeOffsets + i * 2);
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (cp + delta) & 0xffff;
        } else {
          const address = idRangeOffsets + i * 2 + rangeOffset + (cp - start) * 2;
          glyph = this.u16(address);
          if (glyph !== 0) {
            glyph = (glyph + delta) & 0xffff;
          }
        }
        if (glyph !== 0) {
          this.cmap.set(cp, glyph);
        }
      }
    }
  }

  private readFamilyName(): string | null {
    const name = this.tables.get("name");
    if (name === undefined) {
      return null;
    }
    const count = this.u16(name + 2);
    const strings = name + this.u16(name + 4);
    const found = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const record = name + 6 + i * 12;
      const platform = this.u16(record);
      const nameId = this.u16(record + 6);
      if ((nameId !== 1 && nameId !== 16) || found.has(nameId)) {
        continue;
      }
      if (platform !== 0 && platform !== 3) {
        continue;
      }
      const length = this.u16(record + 8);
      const offset = strings + this.u16(record + 10);
      let value = "";
      for (let j = 0; j + 1 < length; j += 2) {
        value += String.fromCharCode(this.u16(offset + j));
      }
      found.set(nameId, value);
    }
    // fontdb (resvg) registers a face under its typographic family when present.
    return found.get(16) ?? found.get(1) ?? null;
  }

  private readCoverage(offset: number): Coverage {
    const format = this.u16(offset);
    const count = this.u16(offset + 2);
    if (format === 1) {
      return (glyph) => {
        let lo = 0;
        let hi = count - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const value = this.u16(offset + 4 + mid * 2);
          if (value === glyph) {
            return mid;
          }
          if (value < glyph) {
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        return -1;
      };
    }
    return (glyph) => {
      for (let i = 0; i < count; i++) {
        const record = offset + 4 + i * 6;
        if (glyph >= this.u16(record) && glyph <= this.u16(record + 2)) {
          return this.u16(record + 4) + glyph - this.u16(record);
        }
      }
      return -1;
    };
  }

  private readClassDef(offset: number): ClassDef {
    const format = this.u16(offset);
    if (format === 1) {
      const start = this.u16(offset + 2);
      const count = this.u16(offset + 4);
      return (glyph) =>
        glyph >= start && glyph < start + count
          ? this.u16(offset + 6 + (glyph - start) * 2)
          : 0;
    }
    const count = this.u16(offset + 2);
    return (glyph) => {
      for (let i = 0; i < count; i++) {
        const record = offset + 4 + i * 6;
        if (glyph >= this.u16(record) && glyph <= this.u16(record + 2)) {
          return this.u16(record + 4);
        }
      }
      return 0;
    };
  }

  private readPairSubtable(offset: number): PairSubtable | null {
    const format = this.u16(offset);
    const coverage = this.readCoverage(offset + this.u16(offset + 2));
    const format1 = this.u16(offset + 4);
    const format2 = this.u16(offset + 6);
    const size1 = popcount(format1) * 2;
    const size2 = popcount(format2) * 2;
    const adv1 = xAdvanceOffset(format1);
    const adv2 = xAdvanceOffset(format2);
    const valueAt = (record: number): number =>
      (adv1 === null ? 0 : this.i16(record + adv1)) +
      (adv2 === null ? 0 : this.i16(record + size1 + adv2));

    if (format === 1) {
      const recordSize = 2 + size1 + size2;
      return (left, right) => {
        const index = coverage(left);
        if (index < 0) {
          return null;
        }
        const pairSet = offset + this.u16(offset + 10 + index * 2);
        let lo = 0;
        let hi = this.u16(pairSet) - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const record = pairSet + 2 + mid * recordSize;
          const second = this.u16(record);
          if (second === right) {
            return valueAt(record + 2);
          }
          if (second < right) {
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        return null;
      };
    }
    if (format === 2) {
      const classDef1 = this.readClassDef(offset + this.u16(offset + 8));
      const classDef2 = this.readClassDef(offset + this.u16(offset + 10));
      const class1Count = this.u16(offset + 12);
      const class2Count = this.u16(offset + 14);
      const recordSize = size1 + size2;
      return (left, right) => {
        if (coverage(left) < 0) {
          return null;
        }
        const class1 = classDef1(left);
        const class2 = classDef2(right);
        if (class1 >= class1Count || class2 >= class2Count) {
          return null;
        }
        return valueAt(offset + 16 + (class1 * class2Count + class2) * recordSize);
      };
    }
    return null;
  }

  private readKerning(): void {
    const gpos = this.tables.get("GPOS");
    if (gpos === undefined) {
      return;
    }
    const featureList = gpos + this.u16(gpos + 6);
    const lookupList = gpos + this.u16(gpos + 8);
    // Union of the 'kern' lookups of every script: the shaper picks the script
    // of the run, and our text mixes Latin and Cyrillic freely.
    const lookupIndices = new Set<number>();
    const featureCount = this.u16(featureList);
    for (let i = 0; i < featureCount; i++) {
      const record = featureList + 2 + i * 6;
      const tag = String.fromCharCode(
        this.view.getUint8(record),
        this.view.getUint8(record + 1),
        this.view.getUint8(record + 2),
        this.view.getUint8(record + 3),
      );
      if (tag !== "kern") {
        continue;
      }
      const feature = featureList + this.u16(record + 4);
      const count = this.u16(feature + 2);
      for (let j = 0; j < count; j++) {
        lookupIndices.add(this.u16(feature + 4 + j * 2));
      }
    }
    for (const index of [...lookupIndices].sort((a, b) => a - b)) {
      const lookup = lookupList + this.u16(lookupList + 2 + index * 2);
      const type = this.u16(lookup);
      const count = this.u16(lookup + 4);
      const subtables: PairSubtable[] = [];
      for (let j = 0; j < count; j++) {
        let subtable = lookup + this.u16(lookup + 6 + j * 2);
        let subtableType = type;
        if (type === 9) {
          subtableType = this.u16(subtable + 2);
          subtable += this.u32(subtable + 4);
        }
        if (subtableType !== 2) {
          continue;
        }
        const parsed = this.readPairSubtable(subtable);
        if (parsed) {
          subtables.push(parsed);
        }
      }
      if (subtables.length) {
        this.kernLookups.push(subtables);
      }
    }
  }
}

// --- Loading ---

const fontsDirCandidates = (): string[] => {
  const candidates = [
    process.env.EXCALIDRAW_FONTS_DIR,
    path.resolve(__dirname, "../../assets/fonts"),
    path.resolve(process.cwd(), "assets/fonts"),
  ];
  return candidates.filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
};

let fontsDir: string | null | undefined;

/** Directory holding the vendored fonts, or null when it cannot be found. */
export const getFontsDir = (): string | null => {
  if (fontsDir !== undefined) {
    return fontsDir;
  }
  fontsDir =
    fontsDirCandidates().find((dir) =>
      fs.existsSync(path.join(dir, FONT_SPECS.excalifont.file)),
    ) ?? null;
  return fontsDir;
};

const loaded = new Map<FontKey, TrueTypeFont | null>();

const loadFont = (key: FontKey): TrueTypeFont | null => {
  if (loaded.has(key)) {
    return loaded.get(key) ?? null;
  }
  let font: TrueTypeFont | null = null;
  const dir = getFontsDir();
  if (dir) {
    try {
      font = new TrueTypeFont(fs.readFileSync(path.join(dir, FONT_SPECS[key].file)));
    } catch {
      font = null;
    }
  }
  loaded.set(key, font);
  return font;
};

/** Absolute paths of every vendored font file that exists, for the rasterizer. */
export const getVendoredFontFiles = (): string[] => {
  const dir = getFontsDir();
  if (!dir) {
    return [];
  }
  return Object.values(FONT_SPECS)
    .map((spec) => path.join(dir, spec.file))
    .filter((file) => fs.existsSync(file));
};

const familyName = (key: FontKey): string =>
  loadFont(key)?.family ?? FONT_SPECS[key].family;

/**
 * SVG font-family for an Excalidraw fontFamily id, naming the families exactly
 * as the vendored files declare them so resvg resolves them, followed by the
 * same fallback order the metric engine uses.
 */
export const svgFontFamily = (fontFamily?: number): string => {
  const chain = chainFor(fontFamily);
  const names = [familyName(chain.primary)];
  if (chain.fallback) {
    names.push(familyName(chain.fallback));
  }
  names.push(chain.generic);
  return names.map((name) => (/[\s,]/.test(name) ? `'${name}'` : name)).join(", ");
};

/** Families the rasterizer should map the CSS generic families to. */
export const genericFontFamilies = (): { sansSerif: string; monospace: string } => ({
  sansSerif: familyName("liberation"),
  monospace: familyName("cascadia"),
});

// Characters that take no room of their own (combining marks, format controls
// such as ZWJ and variation selectors).
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}]/u;
const WHITESPACE = /\s/u;

type ResolvedGlyph = { font: TrueTypeFont; glyph: number; advanceEm: number };

const glyphCache = new Map<FontKey, Map<number, ResolvedGlyph | null>>();

const resolveInFont = (key: FontKey, codePoint: number): ResolvedGlyph | null => {
  let cache = glyphCache.get(key);
  if (!cache) {
    cache = new Map();
    glyphCache.set(key, cache);
  }
  const cached = cache.get(codePoint);
  if (cached !== undefined) {
    return cached;
  }
  const font = loadFont(key);
  const glyph = font ? font.glyphIndex(codePoint) : 0;
  const resolved =
    font && glyph ? { font, glyph, advanceEm: font.advance(glyph) / font.unitsPerEm } : null;
  cache.set(codePoint, resolved);
  return resolved;
};

const resolveGlyph = (chain: FamilyChain, codePoint: number): ResolvedGlyph | null =>
  resolveInFont(chain.primary, codePoint) ??
  (chain.fallback ? resolveInFont(chain.fallback, codePoint) : null);

/**
 * Width of one line in em: glyph advances plus GPOS pair kerning within runs of
 * the same font (what canvas measureText reports). Characters no vendored font
 * covers are measured with `fallbackEm`.
 */
export const lineWidthEm = (
  text: string,
  fontFamily: number | undefined,
  fallbackEm: (char: string) => number,
): number => {
  const chain = chainFor(fontFamily);
  let total = 0;
  let previous: ResolvedGlyph | null = null;
  for (const char of text) {
    const resolved = resolveGlyph(chain, char.codePointAt(0) ?? 0);
    if (!resolved) {
      total += ZERO_WIDTH.test(char) ? 0 : fallbackEm(char);
      previous = null;
      continue;
    }
    if (previous && previous.font === resolved.font) {
      total += previous.font.kerning(previous.glyph, resolved.glyph) / resolved.font.unitsPerEm;
    }
    total += resolved.advanceEm;
    previous = resolved;
  }
  return total;
};

/** Whether the vendored font of this family (or its generic stand-in) loaded. */
export const isFontFamilyAvailable = (fontFamily?: number): boolean =>
  isKnownFontFamily(fontFamily) && loadFont(chainFor(fontFamily).primary) !== null;

/**
 * Visible characters of `text` that no vendored font of this family's chain
 * covers — in a PNG they come from a system font, so their shape and width can
 * differ from the browser. Unknown families and missing font files report every
 * visible character.
 */
export const uncoveredChars = (text: string, fontFamily?: number): string[] => {
  const known = isFontFamilyAvailable(fontFamily);
  const chain = chainFor(fontFamily);
  const missing = new Set<string>();
  for (const char of text) {
    if (WHITESPACE.test(char) || ZERO_WIDTH.test(char)) {
      continue;
    }
    if (!known || !resolveGlyph(chain, char.codePointAt(0) ?? 0)) {
      missing.add(char);
    }
  }
  return [...missing];
};

export type FontRun = {
  text: string;
  /** SVG font-family for this run; null means the text element's own family. */
  family: string | null;
};

/**
 * Splits a line into runs by the font the metric engine measures them with.
 * resvg shapes a whole text chunk with one fallback font when that font covers
 * every character, so one arrow glyph could otherwise switch a whole Excalifont
 * label to another font; drawing each run as its own chunk keeps the render on
 * the measured fonts. Whitespace always belongs to the family's own font (that
 * is where the metric engine finds it); zero-width marks stay with their base.
 */
export const splitFontRuns = (text: string, fontFamily?: number): FontRun[] => {
  if (!isFontFamilyAvailable(fontFamily)) {
    return [{ text, family: null }];
  }
  const chain = chainFor(fontFamily);
  type Key = "primary" | "fallback" | "none";
  const runs: Array<{ text: string; key: Key }> = [];
  for (const char of text) {
    const current = runs[runs.length - 1];
    const codePoint = char.codePointAt(0) ?? 0;
    const key: Key =
      ZERO_WIDTH.test(char) && current
        ? current.key
        : WHITESPACE.test(char) || resolveInFont(chain.primary, codePoint)
          ? "primary"
          : chain.fallback && resolveInFont(chain.fallback, codePoint)
            ? "fallback"
            : "none";
    if (current && current.key === key) {
      current.text += char;
    } else {
      runs.push({ text: char, key });
    }
  }
  const quote = (name: string) => (/[\s,]/.test(name) ? `'${name}'` : name);
  return runs.map(({ text: run, key }) => ({
    text: run,
    family:
      key === "primary"
        ? null
        : key === "fallback" && chain.fallback
          ? `${quote(familyName(chain.fallback))}, ${chain.generic}`
          : chain.generic,
  }));
};

/** Raw glyph data of the family's own font, for tests and diagnostics. */
export const glyphMetrics = (
  char: string,
  fontFamily?: number,
): { glyph: number; advance: number; unitsPerEm: number } | null => {
  const font = loadFont(chainFor(fontFamily).primary);
  if (!font) {
    return null;
  }
  const glyph = font.glyphIndex(char.codePointAt(0) ?? 0);
  return glyph ? { glyph, advance: font.advance(glyph), unitsPerEm: font.unitsPerEm } : null;
};

/** Kerning between two characters in the family's own font, in font units. */
export const pairKerning = (left: string, right: string, fontFamily?: number): number => {
  const font = loadFont(chainFor(fontFamily).primary);
  if (!font) {
    return 0;
  }
  const a = font.glyphIndex(left.codePointAt(0) ?? 0);
  const b = font.glyphIndex(right.codePointAt(0) ?? 0);
  return a && b ? font.kerning(a, b) : 0;
};

/** Test hook: forget loaded fonts and point the loader at another directory. */
export const resetFontsForTests = (dir?: string | null): void => {
  loaded.clear();
  glyphCache.clear();
  fontsDir = dir === undefined ? undefined : dir;
};
