import type {ExcalidrawElement} from "../types";
import {customDataOf} from "../customData";
import {DEFAULT_FONT_FAMILY} from "../verify/model";
import {isRoleName, resolveRole, ROLE_NAMES} from "../verify/styles";
import {containerSizeForText} from "../verify/textMetrics";
import {
  AUTO_WIDTH_SLACK,
  boundLabelsOf,
  elementBounds,
  liveBoundsOf,
  liveById,
  measureBlock,
  resolveAnchor,
} from "./common";
import type {ComposePlan, PlannedItem} from "./types";

export type BadgeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type BadgeInput = {
  id: string;
  anchorId: string;
  text: string;
  corner?: BadgeCorner;
  // Palette role, solid tone; default accent.
  role?: string;
};

const FONT_SIZE = 14;
const MIN_DIAMETER = 32;
const CORNERS: readonly BadgeCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

// One group per anchor holds the anchor and all of its badges: a group per
// badge would give the anchor two sibling groups, which Excalidraw cannot nest.
export const badgeGroupId = (anchorId: string): string => `${anchorId}:badges`;

export const planBadge = (
  input: BadgeInput,
  live: readonly ExcalidrawElement[],
): ComposePlan => {
  const { id } = input;
  if (typeof id !== "string" || !id.length) {
    throw new Error("badge id must be a non-empty string");
  }
  if (typeof input.text !== "string" || !input.text.trim().length) {
    throw new Error(`badge "${id}" needs text`);
  }
  const corner = input.corner ?? "top-left";
  if (!CORNERS.includes(corner)) {
    throw new Error(`corner must be one of ${CORNERS.join(", ")}`);
  }
  if (input.role !== undefined && !isRoleName(input.role)) {
    throw new Error(`unknown role "${input.role}"; valid roles: ${ROLE_NAMES.join(", ")}`);
  }
  const byId = liveById(live);
  const anchor = resolveAnchor(input.anchorId, byId);
  if (anchor.id === id) {
    throw new Error(`badge "${id}" cannot anchor to itself`);
  }
  const existing = byId.get(id);
  if (existing && customDataOf(existing).kind !== "badge") {
    throw new Error(`element "${id}" exists and is not a badge; pick another id`);
  }

  // Fixed per text: the smallest circle whose inscribed label box holds the
  // text without the client wrapping it.
  const text = measureBlock(input.text, FONT_SIZE, DEFAULT_FONT_FAMILY);
  const fitted = containerSizeForText("ellipse", text.width + AUTO_WIDTH_SLACK, text.height);
  const diameter = Math.ceil(Math.max(MIN_DIAMETER, fitted.width, fitted.height) / 2) * 2;

  const a = elementBounds(anchor);
  const cx = corner.endsWith("left") ? a.x : a.x + a.width;
  const cy = corner.startsWith("top") ? a.y : a.y + a.height;
  const style = resolveRole(input.role ?? "accent")!;

  const groupId = badgeGroupId(anchor.id);
  const withGroup = (element: ExcalidrawElement): string[] => [
    groupId,
    ...(element.groupIds ?? []).filter((candidate) => candidate !== groupId),
  ];
  const extraPatches = [anchor, ...boundLabelsOf(anchor, live)]
    .filter((element) => !(element.groupIds ?? []).includes(groupId))
    .map((element) => ({ id: element.id, patch: { groupIds: withGroup(element) } }));

  const badge: PlannedItem = {
    id,
    type: "ellipse",
    x: Math.round(cx - diameter / 2),
    y: Math.round(cy - diameter / 2),
    width: diameter,
    height: diameter,
    frameId: anchor.frameId ?? null,
    groupIds: withGroup(anchor),
    backgroundColor: style.backgroundColor,
    strokeColor: style.strokeColor,
    strokeWidth: 1,
    strokeStyle: "solid",
    fillStyle: "solid",
    roughness: 0,
    opacity: 100,
    roundness: null,
    label: input.text,
    labelFontSize: FONT_SIZE,
    labelFontFamily: DEFAULT_FONT_FAMILY,
    labelColor: style.labelColor,
    textAlign: "center",
    verticalAlign: "middle",
    customData: { kind: "badge" },
  };

  const previousBounds = liveBoundsOf([id], byId);
  return {
    items: [badge],
    removeIds: [],
    bounds: { x: badge.x!, y: badge.y!, width: diameter, height: diameter },
    ...(previousBounds ? { previousBounds } : {}),
    ...(extraPatches.length ? { extraPatches } : {}),
  };
};
