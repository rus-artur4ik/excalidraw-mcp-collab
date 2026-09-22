import type {ExcalidrawElement} from "../types";
import {kindOf, roleOf, slotOf, tableRefOf} from "../customData";
import {
  type BoardProfile,
  fontSizeFor,
  isOnTypeScale,
  nearestScaleSize,
  type TypeScale,
  TYPE_SCALE_ROLES,
} from "../profile";
import {isFrameLike, isTransparent, MONOSPACE_FAMILIES} from "./model";
import {resolveRole} from "./styles";
import {
  containerIdOf,
  fontFamilyOf,
  fontSizeOf,
  isBoundText,
  labelSource,
  type LintContext,
  reasonSuggestion,
  textContent,
  updateSuggestion,
} from "./lintContext";

// Rules that need the board/series profile (I29b): the type scale, what a
// role means, what a dashed stroke means. Without a profile there is no
// contract to check against, so lintScene leaves them out of coverage.

type ScaleRole = keyof TypeScale;

const MAX_LISTED_IDS = 50;

// Most important first; a text of a higher-ranked role must never be smaller
// than one of a lower-ranked role in the same frame.
const RANK: ScaleRole[] = ["title", "frameTitle", "colHeader", "body", "caption"];

const ordered = (ctx: LintContext, elements: readonly ExcalidrawElement[]) =>
  [...elements].sort((a, b) => (ctx.order.get(a.id) ?? 0) - (ctx.order.get(b.id) ?? 0));

const isScaleRole = (value: string): value is ScaleRole =>
  (TYPE_SCALE_ROLES as readonly string[]).includes(value);

const containerOf = (ctx: LintContext, text: ExcalidrawElement): ExcalidrawElement | undefined => {
  const id = containerIdOf(text);
  return id ? ctx.byId.get(id) : undefined;
};

/**
 * Which step of the scale a text is supposed to be at, or undefined when the
 * board never says. A `slot` naming a step wins (the agent declared it), then
 * the structural facts the planners record: a table's header row is a column
 * header, its body is body text, a monospace code card is code.
 */
const scaleRoleOf = (ctx: LintContext, text: ExcalidrawElement): ScaleRole | undefined => {
  const container = containerOf(ctx, text);
  for (const element of [text, container]) {
    const slot = element ? slotOf(element) : undefined;
    const tail = slot?.split(".").pop();
    if (tail && isScaleRole(tail)) {
      return tail;
    }
  }
  const monospace = MONOSPACE_FAMILIES.has(fontFamilyOf(text) ?? 0);
  const ref = container ? tableRefOf(container) : tableRefOf(text);
  if (ref && "row" in ref) {
    // A monospace cell is a code cell, whatever column it is in.
    return monospace ? "code" : ref.row === "_h" ? "colHeader" : "body";
  }
  if (monospace && kindOf(container ?? text) === "code") {
    return "code";
  }
  return undefined;
};

// Texts worth judging: everything with visible content, skipping the ones the
// board never renders as prose.
const scaleTexts = (ctx: LintContext): ExcalidrawElement[] =>
  ctx.scopedTexts().filter((text) => {
    if (!textContent(text).trim()) {
      return false;
    }
    // A label whose container is gone is an orphan_bound_text, not a type
    // problem; reporting it twice helps nobody.
    return !(isBoundText(text) && !containerOf(ctx, text));
  });

// A bound label's size is a property of its container for update_elements.
const sizePatch = (
  ctx: LintContext,
  text: ExcalidrawElement,
  size: number,
): { id: string } & Record<string, unknown> => {
  const container = containerOf(ctx, text);
  return container
    ? { id: container.id, labelFontSize: size }
    : { id: text.id, fontSize: size };
};

// ---- style_font_size_off_profile --------------------------------------------

const offProfileRule = (ctx: LintContext, profile: BoardProfile): void => {
  if (!ctx.on("style_font_size_off_profile")) {
    return;
  }
  for (const text of scaleTexts(ctx)) {
    const size = fontSizeOf(text);
    if (isOnTypeScale(profile, size)) {
      continue;
    }
    const target = nearestScaleSize(profile, size);
    if (target === undefined) {
      continue;
    }
    const container = containerOf(ctx, text);
    ctx.emit({
      code: "style_font_size_off_profile",
      severity: "info",
      elementIds: container ? [text.id, container.id] : [text.id],
      kind: String(size),
      message: `Font size ${size} is not a step of the board profile's type scale; the nearest step is ${target}.`,
      suggestion: updateSuggestion([sizePatch(ctx, text, target)], "review"),
    });
  }
};

// ---- type_scale_violation ---------------------------------------------------

const scaleViolationRule = (ctx: LintContext, profile: BoardProfile): void => {
  if (!ctx.on("type_scale_violation")) {
    return;
  }
  for (const text of scaleTexts(ctx)) {
    const role = scaleRoleOf(ctx, text);
    if (!role) {
      continue;
    }
    const expected = fontSizeFor(profile, role);
    const size = fontSizeOf(text);
    if (Math.abs(size - expected) <= 1) {
      continue;
    }
    const container = containerOf(ctx, text);
    ctx.emit({
      code: "type_scale_violation",
      severity: "info",
      elementIds: container ? [text.id, container.id] : [text.id],
      kind: role,
      message: `This ${role} text is set at ${size}; the board profile's ${role} step is ${expected}.`,
      suggestion: updateSuggestion([sizePatch(ctx, text, expected)], "review"),
    });
  }
};

// ---- hierarchy_inverted -----------------------------------------------------

const hierarchyRule = (ctx: LintContext): void => {
  if (!ctx.on("hierarchy_inverted")) {
    return;
  }
  // Grouped by frame ("" for the frameless top level): a caption next to a
  // title in another frame says nothing about either.
  const byFrame = new Map<string, Array<{ text: ExcalidrawElement; role: ScaleRole; size: number }>>();
  for (const text of ctx.live) {
    if (text.type !== "text" || !textContent(text).trim()) {
      continue;
    }
    const role = scaleRoleOf(ctx, text);
    if (!role || role === "code") {
      // Code is set for legibility, not for weight in the hierarchy.
      continue;
    }
    const container = containerOf(ctx, text);
    const frameId = (container ?? text).frameId;
    const key = typeof frameId === "string" ? frameId : "";
    byFrame.set(key, [...(byFrame.get(key) ?? []), { text, role, size: fontSizeOf(text) }]);
  }
  for (const [frameId, entries] of [...byFrame.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // One finding per pair of roles: a frame with 20 captions under one
    // undersized title should say that once.
    const reported = new Set<string>();
    for (const higher of entries) {
      for (const lower of entries) {
        const hRank = RANK.indexOf(higher.role);
        const lRank = RANK.indexOf(lower.role);
        if (hRank < 0 || lRank < 0 || hRank >= lRank || higher.size >= lower.size) {
          continue;
        }
        const key = `${higher.role}|${lower.role}`;
        if (reported.has(key)) {
          continue;
        }
        reported.add(key);
        ctx.emit({
          code: "hierarchy_inverted",
          severity: "info",
          elementIds: ordered(ctx, [higher.text, lower.text]).map((element) => element.id),
          kind: key,
          message: `A ${higher.role} is set at ${higher.size} while a ${lower.role}${frameId ? ` in the same frame` : ""} is set at ${lower.size}; the more important text reads as the smaller one.`,
          suggestion: updateSuggestion([sizePatch(ctx, higher.text, lower.size + 2)], "review", `Raises the ${higher.role} above the ${lower.role}; the profile's own steps are usually the better target.`),
        });
      }
    }
  }
};

// ---- semantic_conflict ------------------------------------------------------

const textOf = (ctx: LintContext, element: ExcalidrawElement): string => {
  if (element.type === "text") {
    return labelSource(element);
  }
  const label = ctx.labelOf(element);
  return label ? labelSource(label) : "";
};

const carries = (haystack: string, tag: string): boolean =>
  !!tag.trim() && haystack.toLowerCase().includes(tag.toLowerCase());

const conflictRule = (ctx: LintContext, profile: BoardProfile): void => {
  if (!ctx.on("semantic_conflict")) {
    return;
  }
  const roleTags = Object.entries(profile.roles ?? {})
    .map(([name, entry]) => ({ name, tag: entry?.tag ?? "" }))
    .filter((entry) => entry.tag.trim().length);
  const strokeTags = Object.entries(profile.strokeStyles ?? {})
    .map(([name, tag]) => ({ name, tag: tag ?? "" }))
    .filter((entry) => entry.tag.trim().length);

  for (const element of ctx.scoped) {
    if (element.type === "text" && isBoundText(element)) {
      // Judged through its container, so the finding names the shape.
      continue;
    }
    const content = textOf(ctx, element);
    if (!content.trim()) {
      continue;
    }
    const role = roleOf(element);
    const own = roleTags.find((entry) => entry.name === role);
    const foreign = roleTags.filter((entry) => entry.name !== role && carries(content, entry.tag));
    if (own && foreign.length && !carries(content, own.tag)) {
      ctx.emit({
        code: "semantic_conflict",
        severity: "info",
        elementIds: [element.id],
        kind: `role:${role}`,
        message: `This element has role "${role}" (${own.tag} in the board profile) but its text carries ${foreign.map((entry) => `${entry.tag} (${entry.name})`).join(", ")}.`,
        suggestion: reasonSuggestion(
          `Either recolor it to the role the tag belongs to (update_elements {id:"${element.id}", role:"${foreign[0].name}"}) or change the text to ${own.tag}.`,
        ),
      });
    }

    // Only a drawn outline carries a stroke meaning; a standalone text's
    // strokeColor is its glyph color and its strokeStyle says nothing.
    if (element.type === "text" || isFrameLike(element)) {
      continue;
    }
    const style = typeof element.strokeStyle === "string" ? element.strokeStyle : "solid";
    const ownStroke = strokeTags.find((entry) => entry.name === style);
    const foreignStroke = strokeTags.filter(
      (entry) => entry.name !== style && carries(content, entry.tag),
    );
    if (foreignStroke.length && (!ownStroke || !carries(content, ownStroke.tag))) {
      ctx.emit({
        code: "semantic_conflict",
        severity: "info",
        elementIds: [element.id],
        kind: `strokeStyle:${style}`,
        message: `This element is drawn ${style}${ownStroke ? ` (${ownStroke.tag} in the board profile)` : ""} but its text carries ${foreignStroke.map((entry) => `${entry.tag} (${entry.name})`).join(", ")}.`,
        suggestion: updateSuggestion(
          [{ id: element.id, strokeStyle: foreignStroke[0].name }],
          "review",
          `Redraws it ${foreignStroke[0].name}, which is what ${foreignStroke[0].tag} means on this board.`,
        ),
      });
    }
  }
};

// ---- role_color_mismatch ----------------------------------------------------

const sameColor = (value: unknown, expected: string): boolean =>
  typeof value === "string" && value.toLowerCase() === expected.toLowerCase();

const colorMismatchRule = (ctx: LintContext): void => {
  if (!ctx.on("role_color_mismatch")) {
    return;
  }
  const mismatched: ExcalidrawElement[] = [];
  for (const element of ctx.scoped) {
    const role = roleOf(element);
    if (!role) {
      continue;
    }
    const tone = (element.customData as { tone?: unknown } | undefined)?.tone === "subtle" ? "subtle" : "solid";
    const palette = resolveRole(role, tone);
    if (!palette) {
      continue;
    }
    // A text carries only the glyph color; a shape carries stroke and fill.
    // `transparent` is a deliberate opt-out (the note role ships with it).
    const off =
      element.type === "text"
        ? !sameColor(element.strokeColor, palette.labelColor)
        : !sameColor(element.strokeColor, palette.strokeColor) ||
          (!isTransparent(element.backgroundColor) !== !isTransparent(palette.backgroundColor) ||
            (!isTransparent(palette.backgroundColor) &&
              !sameColor(element.backgroundColor, palette.backgroundColor)));
    if (off) {
      mismatched.push(element);
    }
  }
  for (const element of ordered(ctx, mismatched).slice(0, MAX_LISTED_IDS)) {
    const role = roleOf(element)!;
    ctx.emit({
      code: "role_color_mismatch",
      severity: "info",
      elementIds: [element.id],
      kind: role,
      message: `This element is recorded as role "${role}" but its colors were changed by hand, so the palette no longer says what it is.`,
      suggestion: updateSuggestion(
        [{ id: element.id, role }],
        "review",
        "Re-applies the role's palette colors.",
      ),
    });
  }
};

export const profileRules = (ctx: LintContext): void => {
  const profile = ctx.boardProfile;
  if (!profile) {
    return;
  }
  offProfileRule(ctx, profile);
  scaleViolationRule(ctx, profile);
  hierarchyRule(ctx);
  conflictRule(ctx, profile);
  colorMismatchRule(ctx);
};
