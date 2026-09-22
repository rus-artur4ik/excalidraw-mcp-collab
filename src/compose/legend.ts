import type {ExcalidrawElement} from "../types";
import {type BoardProfile, fontSizeFor, resolveProfile} from "../profile";
import {customDataOf} from "../customData";
import {DEFAULT_FONT_FAMILY, isFrameLike, lineHeightForFamily, STROKE_STYLES} from "../verify/model";
import {
  isRoleName,
  isRoleTone,
  resolveRole,
  ROLE_NAMES,
  ROLE_TONES,
  type RoleTone,
  SURFACES,
} from "../verify/styles";
import {
  elementBounds,
  itemBounds,
  liveById,
  measureBlock,
  outerGroupIds,
  staleIds,
  unionBounds,
} from "./common";
import type {ComposePlan, PlannedItem} from "./types";

export type LegendItemInput = {
  // Colors the chip (or the stroke of a line/arrow sample); default neutral.
  role?: string;
  tone?: RoleTone;
  // Given without `arrow`: the sample is a line in this style instead of a chip.
  strokeStyle?: "solid" | "dashed" | "dotted";
  // The sample is an arrow (in `strokeStyle`, default solid).
  arrow?: boolean;
  label: string;
};

export type LegendInput = {
  legendId: string;
  // Required for a new legend; defaults to the legend's current position.
  origin?: { x: number; y: number };
  frameId?: string;
  items: LegendItemInput[];
  layout?: "row" | "grid";
  // Grid only; default ceil(sqrt(items)).
  columns?: number;
  fontSize?: number;
};

const DEFAULT_FONT_SIZE = 16;
const PANEL_PADDING = 12;
const SAMPLE_TEXT_GAP = 8;
const COLUMN_GAP = 24;
const ROW_GAP = 10;
const CHIP_ASPECT = 1.6;
const LINE_SAMPLE_EMS = 2.5;
const SAMPLE_STROKE_WIDTH = 2;

type Slot = {
  item: LegendItemInput;
  sample: "chip" | "line" | "arrow";
  sampleWidth: number;
  sampleHeight: number;
  textWidth: number;
  textHeight: number;
  width: number;
  height: number;
};

const validateItem = (item: LegendItemInput, index: number): void => {
  if (!item || typeof item.label !== "string") {
    throw new Error(`legend item ${index} needs a label`);
  }
  if (item.role !== undefined && !isRoleName(item.role)) {
    throw new Error(
      `legend item ${index}: unknown role "${item.role}"; valid roles: ${ROLE_NAMES.join(", ")}`,
    );
  }
  if (item.tone !== undefined && !isRoleTone(item.tone)) {
    throw new Error(
      `legend item ${index}: unknown tone "${String(item.tone)}"; valid tones: ${ROLE_TONES.join(", ")}`,
    );
  }
  if (item.strokeStyle !== undefined && !STROKE_STYLES.has(item.strokeStyle)) {
    throw new Error(`legend item ${index}: strokeStyle must be solid, dashed or dotted`);
  }
};

export const planLegend = (
  input: LegendInput,
  live: readonly ExcalidrawElement[],
  profile?: BoardProfile | null,
): ComposePlan => {
  const { legendId } = input;
  if (typeof legendId !== "string" || !legendId.length) {
    throw new Error("legendId must be a non-empty string");
  }
  if (!Array.isArray(input.items) || !input.items.length) {
    throw new Error("a legend needs at least one item");
  }
  input.items.forEach(validateItem);
  const byId = liveById(live);
  const root = byId.get(legendId);
  if (root && customDataOf(root).kind !== "legend") {
    throw new Error(`element "${legendId}" exists and is not a legend; pick another legendId`);
  }
  const origin = input.origin ?? (root ? { x: root.x, y: root.y } : undefined);
  if (!origin) {
    throw new Error(`legend "${legendId}" does not exist yet: pass origin to create it`);
  }
  if (input.frameId) {
    const frame = byId.get(input.frameId);
    if (!frame || !isFrameLike(frame)) {
      throw new Error(`frame "${input.frameId}" not found`);
    }
  }
  const frameId = input.frameId ?? root?.frameId ?? null;
  const groupId = `${legendId}:group`;
  const groupIds = [groupId, ...outerGroupIds(root, groupId)];
  // Fresh objects per item: the core may mutate what it is handed.
  const common = () => ({
    frameId,
    groupIds: [...groupIds],
    roughness: 0,
    opacity: 100,
    fillStyle: "solid",
    roundness: null,
    customData: { kind: "legend", legendId },
  });

  const fontSize =
    input.fontSize ?? (profile ? fontSizeFor(profile, "caption") : DEFAULT_FONT_SIZE);
  const padding = profile ? resolveProfile(profile).spacing.cellPadding : PANEL_PADDING;
  const fontFamily = DEFAULT_FONT_FAMILY;
  const lineHeight = Math.round(fontSize * lineHeightForFamily(fontFamily));
  const chipHeight = lineHeight;
  const chipWidth = Math.round(chipHeight * CHIP_ASPECT);
  const lineWidth = Math.round(fontSize * LINE_SAMPLE_EMS);

  const slots: Slot[] = input.items.map((item) => {
    const sample = item.arrow ? "arrow" : item.strokeStyle ? "line" : "chip";
    const text = measureBlock(item.label, fontSize, fontFamily);
    const sampleWidth = sample === "chip" ? chipWidth : lineWidth;
    const sampleHeight = sample === "chip" ? chipHeight : SAMPLE_STROKE_WIDTH;
    return {
      item,
      sample,
      sampleWidth,
      sampleHeight,
      textWidth: text.width,
      textHeight: text.height,
      width: sampleWidth + SAMPLE_TEXT_GAP + text.width,
      height: Math.max(sampleHeight, text.height),
    };
  });

  const columnCount =
    input.layout === "grid"
      ? Math.max(1, Math.min(slots.length, Math.round(input.columns ?? Math.ceil(Math.sqrt(slots.length)))))
      : slots.length;
  const columnWidths: number[] = [];
  const rowHeights: number[] = [];
  slots.forEach((slot, index) => {
    const col = index % columnCount;
    const row = Math.floor(index / columnCount);
    columnWidths[col] = Math.max(columnWidths[col] ?? 0, slot.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, slot.height);
  });
  const columnX = columnWidths.map((_, col) =>
    columnWidths.slice(0, col).reduce((sum, width) => sum + width + COLUMN_GAP, origin.x + padding),
  );
  const rowY = rowHeights.map((_, row) =>
    rowHeights.slice(0, row).reduce((sum, height) => sum + height + ROW_GAP, origin.y + padding),
  );

  const itemElements: PlannedItem[] = [];
  slots.forEach((slot, index) => {
    const col = index % columnCount;
    const row = Math.floor(index / columnCount);
    const x = columnX[col];
    const centerY = rowY[row] + rowHeights[row] / 2;
    const role = resolveRole(slot.item.role ?? "neutral", slot.item.tone ?? "solid")!;
    if (slot.sample === "chip") {
      itemElements.push({
        ...common(),
        id: `${legendId}:${index}:chip`,
        type: "rectangle",
        x,
        y: Math.round(centerY - chipHeight / 2),
        width: chipWidth,
        height: chipHeight,
        backgroundColor: role.backgroundColor,
        strokeColor: role.strokeColor,
        strokeWidth: SAMPLE_STROKE_WIDTH,
        strokeStyle: "solid",
      });
    } else {
      itemElements.push({
        ...common(),
        id: `${legendId}:${index}:chip`,
        type: slot.sample,
        x,
        y: Math.round(centerY),
        width: lineWidth,
        height: 0,
        points: [
          [0, 0],
          [lineWidth, 0],
        ],
        backgroundColor: "transparent",
        strokeColor: role.strokeColor,
        strokeWidth: SAMPLE_STROKE_WIDTH,
        strokeStyle: slot.item.strokeStyle ?? "solid",
        startArrowhead: null,
        endArrowhead: slot.sample === "arrow" ? "arrow" : null,
      });
    }
    itemElements.push({
      ...common(),
      id: `${legendId}:${index}:text`,
      type: "text",
      x: x + slot.sampleWidth + SAMPLE_TEXT_GAP,
      y: Math.round(centerY - slot.textHeight / 2),
      width: slot.textWidth,
      height: slot.textHeight,
      text: slot.item.label,
      fontSize,
      fontFamily,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: SURFACES.base.textColor,
      backgroundColor: "transparent",
      strokeStyle: "solid",
    });
  });

  const content = unionBounds(itemElements.map(itemBounds));
  const panel = {
    x: origin.x,
    y: origin.y,
    width: Math.ceil(content.x + content.width + padding - origin.x),
    height: Math.ceil(content.y + content.height + padding - origin.y),
  };
  const rootItem: PlannedItem = {
    ...common(),
    id: legendId,
    type: "rectangle",
    ...panel,
    backgroundColor: SURFACES.base.backgroundColor,
    strokeColor: SURFACES.base.strokeColor,
    strokeWidth: 1,
    strokeStyle: "solid",
  };
  const items = [rootItem, ...itemElements];

  return {
    items,
    removeIds: staleIds(
      live,
      new Set(items.map((item) => item.id)),
      (element) =>
        element.id.startsWith(`${legendId}:`) && customDataOf(element).legendId === legendId,
    ),
    bounds: panel,
    ...(root ? { previousBounds: elementBounds(root) } : {}),
  };
};
