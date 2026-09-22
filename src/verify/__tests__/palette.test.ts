import {describe, expect, it} from "vitest";

import {contrastRatio, parseColor} from "../colors";
import {isTransparent} from "../model";
import {
  applyRole,
  MUTED_TEXT_COLOR,
  resolveRole,
  resolveSurface,
  ROLE_NAMES,
  ROLE_TONES,
  STYLE_ROLES,
  SURFACE_NAMES,
  SURFACES,
} from "../styles";

// Same threshold as the low_contrast lint rule for body text (< 24 px).
const READABLE = 4.5;

const contrast = (fg: string, bg: string): number =>
  contrastRatio(parseColor(fg)!, parseColor(bg)!);

const luminanceOrder = (a: string, b: string): number =>
  contrast(a, "#000000") - contrast(b, "#000000");

describe("palette contrast (regression for low_contrast)", () => {
  for (const name of ROLE_NAMES) {
    for (const tone of ROLE_TONES) {
      it(`${name}/${tone}: label color is readable on its fill and on white`, () => {
        const role = resolveRole(name, tone)!;
        expect(contrast(role.labelColor, "#ffffff")).toBeGreaterThanOrEqual(READABLE);
        if (!isTransparent(role.backgroundColor)) {
          expect(contrast(role.labelColor, role.backgroundColor)).toBeGreaterThanOrEqual(READABLE);
        }
      });
    }
  }

  for (const name of SURFACE_NAMES) {
    it(`surface ${name}: text is readable on its fill`, () => {
      const surface = SURFACES[name];
      expect(contrast(surface.textColor, surface.backgroundColor)).toBeGreaterThanOrEqual(READABLE);
    });
  }

  it("note text (its stroke color) passes on white and on the subtle surface", () => {
    expect(MUTED_TEXT_COLOR).toBe(STYLE_ROLES.note.strokeColor);
    expect(STYLE_ROLES.note.strokeColor).not.toBe("#868e96");
    expect(contrast(MUTED_TEXT_COLOR, "#ffffff")).toBeGreaterThanOrEqual(READABLE);
    expect(contrast(MUTED_TEXT_COLOR, SURFACES.subtle.backgroundColor)).toBeGreaterThanOrEqual(READABLE);
    // Still a light, secondary gray rather than the body text color.
    expect(contrast(MUTED_TEXT_COLOR, "#ffffff")).toBeLessThan(contrast(STYLE_ROLES.note.labelColor, "#ffffff"));
  });
});

describe("tones and surfaces", () => {
  it("subtle keeps the role stroke and lightens the fill", () => {
    for (const name of ROLE_NAMES) {
      const solid = resolveRole(name)!;
      const subtle = resolveRole(name, "subtle")!;
      expect(subtle.strokeColor).toBe(solid.strokeColor);
      expect(subtle.labelColor).toBe(solid.labelColor);
      expect(isTransparent(subtle.backgroundColor)).toBe(false);
      if (!isTransparent(solid.backgroundColor)) {
        expect(luminanceOrder(subtle.backgroundColor, solid.backgroundColor)).toBeGreaterThan(0);
      }
    }
    expect(resolveRole("process", "solid")).toEqual(STYLE_ROLES.process);
    expect(resolveRole("banana")).toBeUndefined();
    expect(resolveRole("toString")).toBeUndefined();
  });

  it("surfaces are quiet grays", () => {
    for (const name of SURFACE_NAMES) {
      const { backgroundColor } = SURFACES[name];
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(backgroundColor.slice(i, i + 2), 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(12);
    }
    expect(resolveSurface("header")).toBe(SURFACES.header);
    expect(resolveSurface("nope")).toBeUndefined();
  });

  it("applyRole understands tone and surface", () => {
    expect(applyRole({ type: "rectangle", role: "accent", tone: "subtle", label: "x" })).toEqual({
      type: "rectangle",
      label: "x",
      backgroundColor: resolveRole("accent", "subtle")!.backgroundColor,
      strokeColor: STYLE_ROLES.accent.strokeColor,
      labelColor: STYLE_ROLES.accent.labelColor,
    });
    expect(applyRole({ type: "rectangle", surface: "code", label: "x" })).toEqual({
      type: "rectangle",
      label: "x",
      backgroundColor: SURFACES.code.backgroundColor,
      strokeColor: SURFACES.code.strokeColor,
      labelColor: SURFACES.code.textColor,
    });
    expect(applyRole({ type: "text", surface: "header" })).toEqual({
      type: "text",
      strokeColor: SURFACES.header.textColor,
    });
    expect(applyRole({ type: "rectangle", tone: "subtle" })).toEqual({ type: "rectangle" });
  });

  it("applyRole rejects bad combinations", () => {
    expect(() => applyRole({ type: "rectangle", role: "note", surface: "code" })).toThrow(/mutually exclusive/);
    expect(() => applyRole({ type: "rectangle", surface: "glass" })).toThrow(/unknown surface/);
    expect(() => applyRole({ type: "rectangle", role: "note", tone: "loud" })).toThrow(/unknown tone/);
  });
});
