import type {ExcalidrawElement} from "../types";
import {isTableCellRef, kindOf, tableRefOf} from "../customData";
import {
    ARROWHEADS,
    asLinear,
    asText,
    BOUND_TEXT_PADDING,
    type Bounds,
    DEFAULT_FONT_FAMILY,
    FILL_STYLES,
    FONT_LINE_HEIGHTS,
    isFrameLike,
    isLinear,
    isTransparent,
    ROUGHNESS_VALUES,
    STROKE_STYLES,
} from "./model";
import {
    fitTextToContainer,
    getBoundTextMaxWidth,
    largestFittingFontSize,
    measureText,
    OVERFLOW_EPSILON,
    wrapText,
} from "./textMetrics";
import {
    containerIdOf,
    deleteSuggestion,
    fontFamilyOf,
    fontSizeOf,
    frameBounds,
    isInvisibleBox,
    labelSource,
    layoutLabelIn,
    type LintContext,
    moveSuggestion,
    reasonSuggestion,
    repairSuggestion,
    round,
    standaloneTextBox,
    textContent,
    unionBounds,
    updateSuggestion,
    isCompositePart,
} from "./lintContext";

const LABEL_CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond", "arrow"]);
const SIZED_TYPES = new Set(["rectangle", "ellipse", "diamond", "image", "frame", "magicframe", "text"]);
const SHAPE_FACTOR: Record<string, number> = { ellipse: Math.SQRT2, diamond: 2 };

const isTableCell = (element: ExcalidrawElement): boolean =>
  kindOf(element) === "table-cell" || isTableCellRef(tableRefOf(element));

// ---- structural ---------------------------------------------------------

const structuralRules = (ctx: LintContext, element: ExcalidrawElement): void => {
  const id = element.id;
  const isText = element.type === "text";
  const empty = isText && !textContent(element).trim();
  const containerId = containerIdOf(element);

  if (
    ctx.on("degenerate_size") &&
    SIZED_TYPES.has(element.type) &&
    ((element.width || 0) <= 0 || (element.height || 0) <= 0) &&
    !empty
  ) {
    ctx.emit({
      code: "degenerate_size",
      severity: "error",
      elementIds: [id],
      message: `${element.type} has non-positive size (${element.width}×${element.height}).`,
      suggestion: degenerateSuggestion(ctx, element),
    });
  }

  if (ctx.on("empty_text") && empty) {
    ctx.emit(emptyTextFinding(ctx, element, containerId));
  }

  const opacity = element.opacity ?? 100;
  if (ctx.on("invisible_opacity") && opacity === 0) {
    ctx.emit({
      code: "invisible_opacity",
      severity: "warning",
      elementIds: [id],
      message: "Element opacity is 0 (invisible).",
      suggestion: updateSuggestion([{ id, opacity: 100 }], "review", "Delete it instead if it is meant to be gone."),
    });
  }

  if (ctx.on("out_of_range")) {
    const outOfRange = (message: string, patch: Record<string, unknown>) =>
      ctx.emit({
        code: "out_of_range",
        severity: "warning",
        elementIds: [id],
        kind: Object.keys(patch)[0],
        message,
        suggestion: updateSuggestion([{ id, ...patch }], "safe"),
      });
    if (opacity < 0 || opacity > 100) {
      outOfRange(`opacity ${opacity} is outside 0–100.`, { opacity: 100 });
    }
    if (!ROUGHNESS_VALUES.has(element.roughness)) {
      const nearest = Number.isFinite(element.roughness)
        ? Math.max(0, Math.min(2, Math.round(element.roughness)))
        : 1;
      outOfRange(`roughness ${element.roughness} is not one of 0, 1, 2.`, { roughness: nearest });
    }
    if ((element.strokeWidth || 0) <= 0 && !isTransparent(element.strokeColor)) {
      outOfRange("strokeWidth is non-positive.", { strokeWidth: 2 });
    }
    if (isText && fontSizeOf(element) <= 0) {
      outOfRange("fontSize is non-positive.", { fontSize: 20 });
    }
  }

  if (ctx.on("invalid_enum")) {
    const invalid = (message: string, patch: Record<string, unknown>) =>
      ctx.emit({
        code: "invalid_enum",
        severity: "warning",
        elementIds: [id],
        kind: Object.keys(patch)[0],
        message,
        suggestion: updateSuggestion([{ id, ...patch }], "safe"),
      });
    if (!FILL_STYLES.has(element.fillStyle)) {
      invalid(`Unknown fillStyle "${element.fillStyle}".`, { fillStyle: "solid" });
    }
    if (!STROKE_STYLES.has(element.strokeStyle)) {
      invalid(`Unknown strokeStyle "${element.strokeStyle}".`, { strokeStyle: "solid" });
    }
    const family = fontFamilyOf(element);
    if (isText && family !== undefined && !(family in FONT_LINE_HEIGHTS)) {
      invalid(`Unknown fontFamily ${family}.`, { fontFamily: DEFAULT_FONT_FAMILY });
    }
    if (isLinear(element)) {
      const linear = asLinear(element);
      if (linear.startArrowhead && !ARROWHEADS.has(linear.startArrowhead)) {
        invalid(`Unknown arrowhead "${linear.startArrowhead}".`, { startArrowhead: "arrow" });
      }
      if (linear.endArrowhead && !ARROWHEADS.has(linear.endArrowhead)) {
        invalid(`Unknown arrowhead "${linear.endArrowhead}".`, { endArrowhead: "arrow" });
      }
    }
  }
};

const degenerateSuggestion = (ctx: LintContext, element: ExcalidrawElement) => {
  const id = element.id;
  const containerId = containerIdOf(element);
  if (containerId && ctx.byId.has(containerId)) {
    return updateSuggestion([{ id: containerId, label: labelSource(element) }], "safe", "Re-setting the label re-lays it out.");
  }
  if (element.type === "text") {
    const measured = measureText(textContent(element), fontSizeOf(element), fontFamilyOf(element));
    return updateSuggestion(
      [{ id, width: Math.ceil(measured.width), height: Math.ceil(measured.height) }],
      "safe",
    );
  }
  if (isFrameLike(element)) {
    return ctx.frameChildren.get(id)?.length
      ? updateSuggestion([{ id, fitToChildren: { padding: 24 } }], "safe")
      : deleteSuggestion([id], "review", "An empty zero-size frame has nothing to show.");
  }
  if (ctx.labelOf(element)) {
    return updateSuggestion([{ id, fit: "both" }], "review");
  }
  if (element.type === "image") {
    return reasonSuggestion("Give the image a positive width and height (update_elements {id, width, height}).");
  }
  return deleteSuggestion([id], "review", "A zero-size shape without a label is invisible.");
};

const emptyTextFinding = (
  ctx: LintContext,
  element: ExcalidrawElement,
  containerId: string | undefined,
) => {
  const id = element.id;
  const original = asText(element).originalText;
  const raw = (element as { rawText?: unknown }).rawText;
  const recoverable =
    typeof original === "string" && original.trim()
      ? original
      : typeof raw === "string" && raw.trim()
        ? raw
        : undefined;
  if (containerId) {
    const container = ctx.byId.get(containerId);
    // Never suggest deleting a label: the server may have emptied it itself.
    return {
      code: "empty_text",
      severity: "error" as const,
      elementIds: container ? [id, containerId] : [id],
      kind: "label",
      message: `The label of ${containerId} is empty.`,
      suggestion:
        container && recoverable
          ? updateSuggestion([{ id: containerId, label: recoverable }], "review", "Restores the label's last known text.")
          : reasonSuggestion(
              `The label of ${containerId} is empty and nothing recoverable remains; set it again with update_elements {id: "${containerId}", label: "…"}.`,
            ),
    };
  }
  return {
    code: "empty_text",
    severity: "error" as const,
    elementIds: [id],
    message: "Text element has no visible text.",
    suggestion: recoverable
      ? updateSuggestion([{ id, text: recoverable }], "review", "Restores the last known text.")
      : deleteSuggestion([id], "safe"),
  };
};

// ---- text: fit, overflow, integrity --------------------------------------

type Side = "left" | "right" | "top" | "bottom";

// Container size that fits the label with at least minPadding of free space
// on every side the label is not anchored to (anchored sides keep the
// client's fixed 5px). Only ever grows.
const sizeToFit = (
  ctx: LintContext,
  container: ExcalidrawElement,
  text: ExcalidrawElement,
  growWidth: boolean,
): { width?: number; height?: number } => {
  const fontSize = fontSizeOf(text);
  const fontFamily = fontFamilyOf(text) ?? DEFAULT_FONT_FAMILY;
  const source = labelSource(text);
  const view = asText(text);
  const pad = Math.max(ctx.minPadding, BOUND_TEXT_PADDING);
  const horizontalPad =
    view.textAlign === "left" || view.textAlign === "right" ? BOUND_TEXT_PADDING + pad : pad * 2;
  const verticalPad =
    view.verticalAlign === "top" || view.verticalAlign === "bottom"
      ? BOUND_TEXT_PADDING + pad
      : pad * 2;
  const factor = SHAPE_FACTOR[container.type] ?? 1;
  const currentWidth = container.width || 0;
  const currentHeight = container.height || 0;
  let width = currentWidth;
  if (growWidth) {
    const wrapped = wrapText(source, fontSize, fontFamily, getBoundTextMaxWidth(container, fontSize));
    const textWidth = measureText(wrapped, fontSize, fontFamily).width;
    width = Math.max(currentWidth, Math.ceil((textWidth + horizontalPad) * factor));
  }
  const rewrapped = wrapText(
    source,
    fontSize,
    fontFamily,
    getBoundTextMaxWidth({ ...container, width } as ExcalidrawElement, fontSize),
  );
  const textHeight = measureText(rewrapped, fontSize, fontFamily).height;
  const height = Math.max(currentHeight, Math.ceil((textHeight + verticalPad) * factor));
  return {
    ...(width !== currentWidth ? { width } : {}),
    ...(height !== currentHeight ? { height } : {}),
  };
};

const containerTextRules = (
  ctx: LintContext,
  text: ExcalidrawElement,
  container: ExcalidrawElement,
): void => {
  const source = labelSource(text);
  if (!source.trim()) {
    return;
  }
  const fontSize = fontSizeOf(text);
  const fontFamily = fontFamilyOf(text) ?? DEFAULT_FONT_FAMILY;
  const cell = isTableCell(container) || isTableCell(text);
  const code = cell ? "table_cell_overflow" : "text_overflow";
  if (!ctx.on(code)) {
    return;
  }
  const fit = fitTextToContainer(container, source, fontSize, fontFamily);
  const ids = [text.id, container.id];

  if (isLinear(container)) {
    if (!fit.widthOverflow || cell) {
      return;
    }
    const smaller = largestFittingFontSize(container, source, fontFamily, fontSize);
    ctx.emit({
      code: "text_overflow",
      severity: "error",
      elementIds: ids,
      kind: "overflow",
      message: `A word of the ${container.type} label is wider (${fit.textWidth}) than the label may be (${fit.usableWidth}), so it breaks mid-word.`,
      suggestion: smaller
        ? updateSuggestion([{ id: text.id, fontSize: smaller }], "review")
        : reasonSuggestion(`Shorten the label of ${container.id} or lengthen the ${container.type}.`),
    });
    return;
  }

  if (fit.widthOverflow || fit.heightOverflow) {
    if (cell) {
      ctx.emit({
        code: "table_cell_overflow",
        severity: "error",
        elementIds: ids,
        kind: "overflow",
        message: `Cell text does not fit its cell: ${fit.textWidth}×${fit.textHeight} of text in a ${fit.usableWidth}×${fit.usableHeight} label area.`,
        suggestion: reasonSuggestion(
          `Re-run set_table for table ${tableRefOf(container)?.tableId ?? tableRefOf(text)?.tableId ?? "?"} (it sizes columns and rows to their content) or shorten the text; resizing one cell breaks the grid.`,
        ),
      });
      return;
    }
    const patch = sizeToFit(ctx, container, text, fit.widthOverflow);
    const smaller = largestFittingFontSize(container, source, fontFamily, fontSize);
    ctx.emit({
      code: "text_overflow",
      severity: "error",
      elementIds: ids,
      kind: "overflow",
      message: overflowMessage(container, fit),
      suggestion: Object.keys(patch).length
        ? updateSuggestion([{ id: container.id, ...patch }], "review")
        : updateSuggestion([{ id: container.id, fit: "height" }], "review"),
      ...(smaller
        ? { alternative: updateSuggestion([{ id: text.id, fontSize: smaller }], "review") }
        : {}),
    });
    return;
  }

  if (cell || isInvisibleBox(container) || container.angle) {
    return;
  }
  const layout = layoutLabelIn(container, text);
  const view = asText(text);
  const free: Record<Side, number> = {
    left: layout.box[0] - layout.contentBox[0],
    right: layout.contentBox[2] - layout.box[2],
    top: layout.box[1] - layout.contentBox[1],
    bottom: layout.contentBox[3] - layout.box[3],
  };
  // Wrapped text fills the label width by construction, and an anchored side
  // keeps the client's fixed padding: neither is fixable by resizing.
  const checked: Side[] = [];
  if (!layout.softWrapped) {
    if (view.textAlign !== "left") checked.push("left");
    if (view.textAlign !== "right") checked.push("right");
  }
  if (view.verticalAlign !== "top") checked.push("top");
  if (view.verticalAlign !== "bottom") checked.push("bottom");
  const tight = checked.filter((side) => free[side] < ctx.minPadding - 0.5);
  // Planned composites (table cells, code cards, legend chips) size their
  // padding on purpose; only a real overflow is worth reporting there.
  if (!tight.length || isCompositePart(container)) {
    return;
  }
  const growWidth = tight.includes("left") || tight.includes("right");
  const patch = sizeToFit(ctx, container, text, growWidth);
  const growHeight = tight.includes("top") || tight.includes("bottom");
  const trimmed = {
    ...(growWidth && patch.width !== undefined ? { width: patch.width } : {}),
    ...(growHeight && patch.height !== undefined ? { height: patch.height } : {}),
  };
  ctx.emit({
    code: "text_overflow",
    severity: "warning",
    elementIds: ids,
    kind: "tight",
    message: `Label fits but leaves only ${tight
      .map((side) => `${Math.max(0, Math.round(free[side]))}px ${side}`)
      .join(", ")} of free space inside its ${container.type} (minPadding ${ctx.minPadding}).`,
    details: { free: Object.fromEntries(tight.map((side) => [side, Math.round(free[side])])) },
    suggestion: Object.keys(trimmed).length
      ? updateSuggestion([{ id: container.id, ...trimmed }], "review")
      : reasonSuggestion("Shorten the label or reduce its font size."),
  });
};

const INSCRIBED_TYPES = new Set(["diamond", "ellipse"]);

const overflowMessage = (
  container: ExcalidrawElement,
  fit: ReturnType<typeof fitTextToContainer>,
): string => {
  const shape = container.type;
  const inscribed = INSCRIBED_TYPES.has(shape)
    ? ` A ${shape} inscribes its label, so its ${Math.round(container.width || 0)}×${Math.round(container.height || 0)} box only offers a ${fit.usableWidth}×${fit.usableHeight} label area.`
    : "";
  if (fit.widthOverflow && fit.heightOverflow) {
    return `Text does not fit its ${shape}: ${fit.textWidth}×${fit.textHeight} of text against a ${fit.usableWidth}×${fit.usableHeight} label area.${inscribed}`;
  }
  if (fit.widthOverflow) {
    return `Text is too WIDE for its ${shape}: needs ${fit.textWidth}, the label area is ${fit.usableWidth}.${inscribed}`;
  }
  return `Text is too TALL for its ${shape}: it wraps to ${fit.textHeight} high, the label area is ${fit.usableHeight}.${inscribed}`;
};

const standaloneOverflow = (ctx: LintContext, text: ExcalidrawElement): void => {
  if (!ctx.on("text_overflow") || asText(text).autoResize !== false || (text.width || 0) <= 0) {
    return;
  }
  const content = textContent(text);
  if (!content.trim()) {
    return;
  }
  const fontSize = fontSizeOf(text);
  const fontFamily = fontFamilyOf(text);
  const measured = measureText(wrapText(content, fontSize, fontFamily, text.width || 0), fontSize, fontFamily);
  if (measured.height <= (text.height || 0) + OVERFLOW_EPSILON) {
    return;
  }
  ctx.emit({
    code: "text_overflow",
    severity: "error",
    elementIds: [text.id],
    kind: "overflow",
    message: `Wrapped text is taller (${Math.ceil(measured.height)}) than the text box height (${Math.round(text.height || 0)}).`,
    suggestion: updateSuggestion([{ id: text.id, height: Math.ceil(measured.height) }], "safe"),
  });
};

const withoutWhitespace = (value: string): string => value.replace(/\s+/g, "");

const boundTextRules = (
  ctx: LintContext,
  text: ExcalidrawElement,
  containerId: string,
): void => {
  const container = ctx.byId.get(containerId);
  const anyContainer = ctx.anyById.get(containerId);
  if (!container || !LABEL_CONTAINER_TYPES.has(container.type)) {
    if (ctx.on("orphan_bound_text")) {
      ctx.emit({
        code: "orphan_bound_text",
        severity: "error",
        elementIds: [text.id],
        kind: "container_missing",
        message: !anyContainer
          ? `Label points to container ${containerId}, which does not exist.`
          : anyContainer.isDeleted
            ? `Label points to container ${containerId}, which was deleted.`
            : `Label points to ${containerId}, a ${anyContainer.type} that cannot hold a label.`,
        suggestion: repairSuggestion("orphan_bound_text", [text.id]),
      });
    }
    return;
  }
  const listed = (container.boundElements ?? []).some((entry) => entry.id === text.id);
  if (!listed && ctx.on("orphan_bound_text")) {
    ctx.emit({
      code: "orphan_bound_text",
      severity: "error",
      elementIds: [text.id, container.id],
      kind: "backref_missing",
      message: `${container.type} ${container.id} does not list this label in boundElements, so the label will not move or resize with it.`,
      suggestion: repairSuggestion("orphan_bound_text", [text.id, container.id]),
    });
  }
  if (
    ctx.on("frame_membership_mismatch") &&
    (text.frameId ?? null) !== (container.frameId ?? null)
  ) {
    ctx.emit({
      code: "frame_membership_mismatch",
      severity: "error",
      elementIds: [text.id, container.id],
      message: `Label is in frame ${text.frameId ?? "none"} but its container is in frame ${container.frameId ?? "none"}; the frame clips or leaves it behind.`,
      suggestion: repairSuggestion("frame_membership_mismatch", [text.id, container.id]),
    });
  }
  const original = asText(text).originalText;
  if (
    ctx.on("text_original_mismatch") &&
    typeof original === "string" &&
    withoutWhitespace(original) !== withoutWhitespace(textContent(text))
  ) {
    const shown = textContent(text);
    const label = original.includes("\n") ? shown : shown.split("\n").join(" ");
    ctx.emit({
      code: "text_original_mismatch",
      severity: "warning",
      elementIds: [text.id, container.id],
      message: `Label shows "${truncate(shown)}" but originalText is "${truncate(original)}"; the client re-wraps from originalText and would bring the old text back.`,
      suggestion: updateSuggestion(
        [{ id: container.id, label }],
        "review",
        "Writes the shown text into both text and originalText.",
      ),
    });
  }
  if (
    ctx.on("bound_text_below_container") &&
    typeof text.index === "string" &&
    typeof container.index === "string" &&
    text.index <= container.index
  ) {
    ctx.emit({
      code: "bound_text_below_container",
      severity: "error",
      elementIds: [text.id, container.id],
      message: `Bound text is stacked below its ${container.type} container, so the fill hides the label.`,
      suggestion: repairSuggestion("bound_text_below_container", [text.id, container.id]),
    });
  }
  containerTextRules(ctx, text, container);
};

const truncate = (value: string, max = 40): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

// ---- bindings and frames --------------------------------------------------

const bindingRules = (ctx: LintContext, arrow: ExcalidrawElement): void => {
  const linear = asLinear(arrow);
  const reported = new Set<string>();
  for (const [side, binding] of [
    ["start", linear.startBinding],
    ["end", linear.endBinding],
  ] as const) {
    if (!binding) {
      continue;
    }
    if (!binding.mode || !binding.fixedPoint) {
      if (ctx.on("binding_invalid")) {
        ctx.emit({
          code: "binding_invalid",
          severity: "error",
          elementIds: [arrow.id],
          kind: side,
          message: `${side} binding is missing mode/fixedPoint and will be dropped on load.`,
          suggestion: repairSuggestion("binding_invalid", [arrow.id]),
        });
      }
      continue;
    }
    const target = ctx.byId.get(binding.elementId);
    if (!target) {
      if (ctx.on("binding_target_missing")) {
        const tombstone = ctx.anyById.get(binding.elementId);
        ctx.emit({
          code: "binding_target_missing",
          severity: "error",
          elementIds: [arrow.id],
          kind: side,
          message: `${side} binding points to ${binding.elementId}, which ${tombstone ? "was deleted" : "does not exist"}.`,
          suggestion: repairSuggestion("binding_target_missing", [arrow.id]),
        });
      }
      continue;
    }
    const backref = (target.boundElements ?? []).some((entry) => entry.id === arrow.id);
    if (!backref && ctx.on("binding_backref_missing") && !reported.has(target.id)) {
      reported.add(target.id);
      ctx.emit({
        code: "binding_backref_missing",
        severity: "error",
        elementIds: [arrow.id, target.id],
        message: `${target.type} ${target.id} is missing a boundElements back-reference to this ${arrow.type}; it will not follow the shape when moved.`,
        suggestion: repairSuggestion("binding_backref_missing", [arrow.id, target.id]),
      });
    }
  }
};

const staleBackrefRules = (ctx: LintContext, element: ExcalidrawElement): void => {
  if (!ctx.on("binding_backref_stale") || !Array.isArray(element.boundElements)) {
    return;
  }
  const seen = new Set<string>();
  for (const entry of element.boundElements) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    const target = ctx.byId.get(entry.id);
    let problem: string | null = null;
    if (!target) {
      problem = ctx.anyById.has(entry.id)
        ? `lists ${entry.type ?? "element"} ${entry.id}, which was deleted`
        : `lists ${entry.type ?? "element"} ${entry.id}, which does not exist`;
    } else if (isLinear(target)) {
      const linear = asLinear(target);
      if (
        linear.startBinding?.elementId !== element.id &&
        linear.endBinding?.elementId !== element.id
      ) {
        problem = `lists ${target.type} ${target.id}, which is not bound to it`;
      }
    } else if (target.type === "text") {
      if (containerIdOf(target) !== element.id) {
        problem = `lists text ${target.id}, which is not its label`;
      }
    } else {
      problem = `lists ${target.type} ${target.id}, which cannot be bound`;
    }
    if (problem) {
      ctx.emit({
        code: "binding_backref_stale",
        severity: "error",
        elementIds: [element.id, entry.id],
        message: `${element.type} ${element.id} ${problem}; the stale entry makes the client move or delete the wrong things.`,
        suggestion: repairSuggestion("binding_backref_stale", [element.id, entry.id]),
      });
    }
  }
};

const frameMissingRule = (ctx: LintContext, element: ExcalidrawElement): void => {
  if (!ctx.on("frame_missing") || typeof element.frameId !== "string") {
    return;
  }
  const frame = ctx.byId.get(element.frameId);
  if (frame && isFrameLike(frame)) {
    return;
  }
  const any = ctx.anyById.get(element.frameId);
  ctx.emit({
    code: "frame_missing",
    severity: "error",
    elementIds: [element.id],
    message: `frameId points to ${element.frameId}, which ${
      !any ? "does not exist" : any.isDeleted ? "was deleted" : `is a ${any.type}, not a frame`
    }.`,
    suggestion: repairSuggestion("frame_missing", [element.id]),
  });
};

// ---- text outside its frame ---------------------------------------------

const OUTSIDE_TOLERANCE = 1;

const outsideFrameRules = (ctx: LintContext): void => {
  if (!ctx.on("text_outside_frame")) {
    return;
  }
  for (const [frameId, children] of ctx.frameChildren) {
    const frame = ctx.byId.get(frameId);
    if (!frame || !isFrameLike(frame) || frame.angle) {
      continue;
    }
    if (ctx.scope && !ctx.scope.has(frameId) && !children.some((child) => ctx.scope!.has(child.id))) {
      continue;
    }
    const fb = frameBounds(frame);
    const outside: Array<{ element: ExcalidrawElement; box: Bounds; moveId: string; moveBox: Bounds }> = [];
    const flagged = new Set<string>();
    const isOutside = (box: Bounds) =>
      box[0] < fb[0] - OUTSIDE_TOLERANCE ||
      box[1] < fb[1] - OUTSIDE_TOLERANCE ||
      box[2] > fb[2] + OUTSIDE_TOLERANCE ||
      box[3] > fb[3] + OUTSIDE_TOLERANCE;
    // Containers first, so a label whose container is already out is not
    // reported twice.
    const ordered = [...children].sort((a, b) => Number(a.type === "text") - Number(b.type === "text"));
    for (const child of ordered) {
      if (isLinear(child) || isFrameLike(child)) {
        continue;
      }
      let box: Bounds;
      let moveId = child.id;
      let moveBox: Bounds;
      const containerId = containerIdOf(child);
      if (child.type === "text" && containerId) {
        const container = ctx.byId.get(containerId);
        if (!container || flagged.has(containerId) || !textContent(child).trim()) {
          continue;
        }
        if (container.angle) {
          continue;
        }
        box = layoutLabelIn(container, child).box;
        moveId = container.id;
        moveBox = isLinear(container) ? box : unionBounds(box, ctx.bounds(container));
      } else if (child.type === "text") {
        if (!textContent(child).trim()) {
          continue;
        }
        box = standaloneTextBox(child);
        moveBox = box;
      } else {
        box = ctx.bounds(child);
        moveBox = box;
      }
      if (isOutside(box)) {
        flagged.add(child.id);
        outside.push({ element: child, box, moveId, moveBox });
      }
    }
    if (!outside.length) {
      continue;
    }
    const pad = ctx.minPadding;
    let grown = fb;
    for (const { box } of outside) {
      grown = unionBounds(grown, [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]);
    }
    const x = Math.floor(grown[0]);
    const y = Math.floor(grown[1]);
    const growFrame = updateSuggestion(
      [{ id: frameId, x, y, width: Math.ceil(grown[2]) - x, height: Math.ceil(grown[3]) - y }],
      "review",
      "Grows the frame to cover every child that sticks out; neighbouring frames may need to move.",
    );
    for (const { element, box, moveId, moveBox } of outside) {
      const over = Math.round(
        Math.max(fb[0] - box[0], fb[1] - box[1], box[2] - fb[2], box[3] - fb[3]),
      );
      const fitsInside =
        moveBox[2] - moveBox[0] <= fb[2] - fb[0] - pad * 2 &&
        moveBox[3] - moveBox[1] <= fb[3] - fb[1] - pad * 2;
      const dx =
        moveBox[0] < fb[0] + pad ? fb[0] + pad - moveBox[0] : moveBox[2] > fb[2] - pad ? fb[2] - pad - moveBox[2] : 0;
      const dy =
        moveBox[1] < fb[1] + pad ? fb[1] + pad - moveBox[1] : moveBox[3] > fb[3] - pad ? fb[3] - pad - moveBox[3] : 0;
      ctx.emit({
        code: "text_outside_frame",
        severity: "error",
        elementIds: moveId === element.id ? [element.id, frameId] : [element.id, moveId, frameId],
        message: `${element.type === "text" ? "Text" : element.type} extends ${over}px past its frame ${frameId}; the frame clips it.`,
        suggestion: growFrame,
        ...(fitsInside && (dx || dy)
          ? { alternative: moveSuggestion([moveId], round(dx), round(dy), "review") }
          : {}),
      });
    }
  }
};

// ---- persistence ----------------------------------------------------------

const notPersistedRules = (ctx: LintContext): void => {
  if (!ctx.stored || !ctx.on("not_persisted")) {
    return;
  }
  const stored = new Map(ctx.stored.map((element) => [element.id, element]));
  for (const element of ctx.scoped) {
    const copy = stored.get(element.id);
    const problem = !copy
      ? "is missing from the stored scene"
      : copy.isDeleted
        ? "is stored as deleted"
        : (copy.version ?? 0) > (element.version ?? 0)
          ? `has a newer stored copy (v${copy.version} stored, v${element.version} in memory)`
          : null;
    if (problem) {
      ctx.emit({
        code: "not_persisted",
        severity: "error",
        elementIds: [element.id],
        message: `${element.type} ${element.id} ${problem}; it will vanish on the next reload.`,
        suggestion: repairSuggestion("not_persisted", [element.id]),
      });
    }
  }
};

export const elementRules = (ctx: LintContext): void => {
  for (const element of ctx.live) {
    if (!ctx.relevant(element)) {
      continue;
    }
    structuralRules(ctx, element);
    frameMissingRule(ctx, element);
    staleBackrefRules(ctx, element);
    if (isLinear(element)) {
      bindingRules(ctx, element);
    }
    if (element.type === "text") {
      const containerId = containerIdOf(element);
      if (containerId) {
        boundTextRules(ctx, element, containerId);
      } else {
        standaloneOverflow(ctx, element);
      }
    }
  }
  outsideFrameRules(ctx);
  notPersistedRules(ctx);
};

