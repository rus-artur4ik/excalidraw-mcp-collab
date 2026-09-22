import type {ExcalidrawElement} from "../types";
import {type BoardProfile, fontSizeFor} from "../profile";
import {customDataOf} from "../customData";
import {BOUND_TEXT_PADDING, DEFAULT_FONT_FAMILY, isFrameLike} from "../verify/model";
import {MUTED_TEXT_COLOR, SURFACES} from "../verify/styles";
import {
  AUTO_WIDTH_SLACK,
  itemBounds,
  liveBoundsOf,
  liveById,
  measureBlock,
  outerGroupIds,
  staleIds,
  unionBounds,
} from "./common";
import type {ComposePlan, PlannedItem} from "./types";

export type CodeCardInput = {
  id: string;
  // Top-left of the whole card, title included.
  x: number;
  y: number;
  code: string;
  title?: string;
  source?: string;
  fontSize?: number;
  // 'auto' (default): wide enough that no line wraps.
  width?: "auto" | number;
  frameId?: string;
};

const CODE_FONT_FAMILY = 3;
const DEFAULT_CODE_FONT_SIZE = 14;
const TITLE_GAP = 6;
const SOURCE_GAP = 6;
const MIN_BODY_CONTENT = 40;
const TAB = "    ";

// Tabs become spaces because the client would otherwise expand them to eight
// and our widths would be off; NBSPs (an old workaround for eaten indents)
// become plain spaces so code copied off the board compiles.
export const normalizeCode = (code: string): string =>
  code
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, TAB)
    .replace(/ /g, " ")
    .replace(/\n+$/, "");

export const planCodeCard = (
  input: CodeCardInput,
  live: readonly ExcalidrawElement[],
  profile?: BoardProfile | null,
): ComposePlan => {
  const { id } = input;
  if (typeof id !== "string" || !id.length) {
    throw new Error("code card id must be a non-empty string");
  }
  if (typeof input.x !== "number" || typeof input.y !== "number") {
    throw new Error(`code card "${id}" needs x and y`);
  }
  const code = normalizeCode(String(input.code ?? ""));
  if (!code.trim().length) {
    throw new Error(`code card "${id}" needs non-empty code`);
  }
  const byId = liveById(live);
  const body = byId.get(id);
  if (body && customDataOf(body).kind !== "code") {
    throw new Error(`element "${id}" exists and is not a code card; pick another id`);
  }
  if (input.frameId) {
    const frame = byId.get(input.frameId);
    if (!frame || !isFrameLike(frame)) {
      throw new Error(`frame "${input.frameId}" not found`);
    }
  }
  const frameId = input.frameId ?? body?.frameId ?? null;
  const groupId = `${id}:group`;
  const groupIds = [groupId, ...outerGroupIds(body, groupId)];
  const common = () => ({
    frameId,
    groupIds: [...groupIds],
    roughness: 0,
    opacity: 100,
    fillStyle: "solid",
    strokeStyle: "solid",
    roundness: null,
    customData: { kind: "code" },
  });

  const fontSize =
    input.fontSize ?? (profile ? fontSizeFor(profile, "code") : DEFAULT_CODE_FONT_SIZE);
  // Without a profile the title and the source line stay tied to the code
  // size (+2 / -2); with one they take the scale's own steps.
  const titleFontSize = profile ? fontSizeFor(profile, "body") : fontSize + 2;
  const sourceFontSize = profile ? fontSizeFor(profile, "caption") : Math.max(10, fontSize - 2);
  const surface = SURFACES.code;
  const items: PlannedItem[] = [];
  let cursorY = input.y;

  const caption = (
    suffix: "title" | "source",
    text: string,
    size: number,
    fontFamily: number,
    color: string,
    y: number,
  ): PlannedItem => {
    const block = measureBlock(text, size, fontFamily);
    return {
      ...common(),
      id: `${id}:${suffix}`,
      type: "text",
      x: input.x,
      y,
      width: block.width,
      height: block.height,
      text,
      fontSize: size,
      fontFamily,
      textAlign: "left",
      verticalAlign: "top",
      strokeColor: color,
      backgroundColor: "transparent",
    };
  };

  if (input.title) {
    const title = caption("title", input.title, titleFontSize, DEFAULT_FONT_FAMILY, SURFACES.base.textColor, cursorY);
    items.push(title);
    cursorY += (title.height ?? 0) + TITLE_GAP;
  }

  // Left/top aligned label sits BOUND_TEXT_PADDING inside the body, and the
  // body is sized so that padding is the same on all four sides.
  const naturalWidth = measureBlock(code, fontSize, CODE_FONT_FAMILY).width;
  const width = Math.ceil(
    typeof input.width === "number"
      ? Math.max(input.width, MIN_BODY_CONTENT + 2 * BOUND_TEXT_PADDING)
      : naturalWidth + 2 * BOUND_TEXT_PADDING + AUTO_WIDTH_SLACK,
  );
  const wrapped = measureBlock(code, fontSize, CODE_FONT_FAMILY, width - 2 * BOUND_TEXT_PADDING);
  const height = wrapped.height + 2 * BOUND_TEXT_PADDING;
  items.push({
    ...common(),
    id,
    type: "rectangle",
    x: input.x,
    y: cursorY,
    width,
    height,
    backgroundColor: surface.backgroundColor,
    strokeColor: surface.strokeColor,
    strokeWidth: 1,
    label: code,
    labelFontSize: fontSize,
    labelFontFamily: CODE_FONT_FAMILY,
    labelColor: surface.textColor,
    textAlign: "left",
    verticalAlign: "top",
  });
  cursorY += height + SOURCE_GAP;

  if (input.source) {
    items.push(
      caption("source", input.source, sourceFontSize, CODE_FONT_FAMILY, MUTED_TEXT_COLOR, cursorY),
    );
  }

  const partIds = [id, `${id}:title`, `${id}:source`];
  const previousBounds = liveBoundsOf(partIds, byId);
  return {
    items,
    removeIds: staleIds(
      live,
      new Set(items.map((item) => item.id)),
      (element) => partIds.includes(element.id) && customDataOf(element).kind === "code",
    ),
    bounds: unionBounds(items.map(itemBounds)),
    ...(previousBounds ? { previousBounds } : {}),
  };
};
