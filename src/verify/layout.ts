import ELK, {type ElkExtendedEdge, type ElkNode} from "elkjs";

import {BOUND_TEXT_PADDING, DEFAULT_FONT_FAMILY} from "./model";
import {measureText, wrapText} from "./textMetrics";
import {ROLE_NAMES, ROLE_SHAPES, SIZE_LADDER} from "./styles";
import type {CreateAttrs} from "../elements";

export type DiagramNode = {
  id: string;
  label: string;
  role?: string;
  shape?: "rectangle" | "ellipse" | "diamond";
  width?: number;
  height?: number;
  group?: string;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
  strokeStyle?: "solid" | "dashed" | "dotted";
  startArrowhead?: string | null;
  endArrowhead?: string | null;
};

export type DiagramGroup = {
  id: string;
  label?: string;
};

export type DiagramInput = {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
  direction?: "DOWN" | "RIGHT" | "UP" | "LEFT";
  spacing?: number;
  origin?: { x: number; y: number };
  fontSize?: number;
  roughness?: number;
};

export type DiagramPlan = {
  items: CreateAttrs[];
  nodeElementIds: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number };
};

const NODE_MIN = SIZE_LADDER.secondary;
const NODE_TEXT_PADDING_X = 16;
const NODE_MAX_LABEL_WIDTH = 220;
const DEFAULT_SPACING = 48;
const DEFAULT_FONT_SIZE = 16;
const EDGE_LABEL_FONT_RATIO = 0.85;
const GROUP_PADDING = 24;
const GROUP_TITLE_SPACE = 36;
const GROUP_STROKE = "#868e96";

const MAX_DIAGRAM_NODES = 60;

const nodeSize = (
  node: DiagramNode,
  fontSize: number,
): { width: number; height: number } => {
  if (typeof node.width === "number" && typeof node.height === "number") {
    return { width: node.width, height: node.height };
  }
  const wrapped = wrapText(node.label, fontSize, DEFAULT_FONT_FAMILY, NODE_MAX_LABEL_WIDTH);
  const measured = measureText(wrapped, fontSize, DEFAULT_FONT_FAMILY);
  const textWidth = measured.width + NODE_TEXT_PADDING_X * 2 + BOUND_TEXT_PADDING * 2;
  const textHeight = measured.height + BOUND_TEXT_PADDING * 4;
  const shape = node.shape ?? ROLE_SHAPES[node.role ?? ""] ?? "rectangle";
  // Text is inscribed in ellipses/diamonds, so the shape needs extra room around it.
  const shapeFactor = shape === "rectangle" ? 1 : shape === "ellipse" ? Math.SQRT2 : 1.6;
  return {
    width: Math.ceil(Math.max(node.width ?? NODE_MIN.width, textWidth * shapeFactor)),
    height: Math.ceil(Math.max(node.height ?? NODE_MIN.height, textHeight * shapeFactor)),
  };
};

type Placed = { id: string; x: number; y: number; width: number; height: number };

const collectPlacements = (
  node: ElkNode,
  offsetX: number,
  offsetY: number,
  nodes: Map<string, Placed>,
  groups: Map<string, Placed>,
  groupIds: Set<string>,
): void => {
  for (const child of node.children ?? []) {
    const placed: Placed = {
      id: child.id,
      x: offsetX + (child.x ?? 0),
      y: offsetY + (child.y ?? 0),
      width: child.width ?? 0,
      height: child.height ?? 0,
    };
    if (groupIds.has(child.id)) {
      groups.set(child.id, placed);
      collectPlacements(child, placed.x, placed.y, nodes, groups, groupIds);
    } else {
      nodes.set(child.id, placed);
    }
  }
};

const validateInput = (input: DiagramInput): void => {
  if (!input.nodes.length) {
    throw new Error("diagram needs at least one node");
  }
  if (input.nodes.length > MAX_DIAGRAM_NODES) {
    throw new Error(
      `diagram has ${input.nodes.length} nodes; more than ${MAX_DIAGRAM_NODES} does not read well — split it into several diagrams`,
    );
  }
  const ids = new Set<string>();
  for (const node of input.nodes) {
    if (ids.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
    if (node.role && !ROLE_NAMES.includes(node.role)) {
      throw new Error(
        `unknown role "${node.role}" on node ${node.id}; valid roles: ${ROLE_NAMES.join(", ")}`,
      );
    }
  }
  const groupIds = new Set((input.groups ?? []).map((group) => group.id));
  for (const node of input.nodes) {
    if (node.group && !groupIds.has(node.group)) {
      throw new Error(`node ${node.id} references unknown group ${node.group}`);
    }
  }
  for (const edge of input.edges) {
    if (!ids.has(edge.from)) {
      throw new Error(`edge references unknown node: ${edge.from}`);
    }
    if (!ids.has(edge.to)) {
      throw new Error(`edge references unknown node: ${edge.to}`);
    }
  }
};

const buildElkGraph = (input: DiagramInput, fontSize: number): ElkNode => {
  const spacing = input.spacing ?? DEFAULT_SPACING;
  const groupChildren = new Map<string, ElkNode[]>();
  const rootChildren: ElkNode[] = [];
  for (const node of input.nodes) {
    const elkNode: ElkNode = { id: node.id, ...nodeSize(node, fontSize) };
    if (node.group) {
      const list = groupChildren.get(node.group) ?? [];
      list.push(elkNode);
      groupChildren.set(node.group, list);
    } else {
      rootChildren.push(elkNode);
    }
  }
  for (const group of input.groups ?? []) {
    rootChildren.push({
      id: group.id,
      layoutOptions: {
        "elk.padding": `[top=${GROUP_TITLE_SPACE + GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
      },
      children: groupChildren.get(group.id) ?? [],
    });
  }
  const edges: ElkExtendedEdge[] = input.edges.map((edge, i) => ({
    id: `edge_${i}`,
    sources: [edge.from],
    targets: [edge.to],
  }));
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": input.direction ?? "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": String(spacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(Math.round(spacing * 1.5)),
      "elk.spacing.componentComponent": String(spacing * 2),
    },
    children: rootChildren,
    edges,
  };
};

export const planDiagram = async (
  input: DiagramInput,
  newElementId: () => string,
): Promise<DiagramPlan> => {
  validateInput(input);
  const fontSize = input.fontSize ?? DEFAULT_FONT_SIZE;
  const roughness = input.roughness ?? 1;
  const originX = input.origin?.x ?? 0;
  const originY = input.origin?.y ?? 0;

  const graph = await new ELK().layout(buildElkGraph(input, fontSize));

  const groupIds = new Set((input.groups ?? []).map((group) => group.id));
  const nodePlacements = new Map<string, Placed>();
  const groupPlacements = new Map<string, Placed>();
  collectPlacements(graph, originX, originY, nodePlacements, groupPlacements, groupIds);

  const nodeElementIds: Record<string, string> = {};
  for (const node of input.nodes) {
    nodeElementIds[node.id] = newElementId();
  }

  const items: CreateAttrs[] = [];

  for (const group of input.groups ?? []) {
    const placed = groupPlacements.get(group.id);
    if (!placed) {
      continue;
    }
    items.push({
      type: "rectangle",
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      strokeColor: GROUP_STROKE,
      strokeStyle: "dashed",
      backgroundColor: "transparent",
      roughness,
    });
    if (group.label) {
      items.push({
        type: "text",
        text: group.label,
        x: placed.x + GROUP_PADDING,
        y: placed.y + (GROUP_TITLE_SPACE - fontSize) / 2,
        fontSize,
        strokeColor: GROUP_STROKE,
      });
    }
  }

  for (const node of input.nodes) {
    const placed = nodePlacements.get(node.id);
    if (!placed) {
      throw new Error(`layout produced no position for node ${node.id}`);
    }
    items.push({
      id: nodeElementIds[node.id],
      type: node.shape ?? ROLE_SHAPES[node.role ?? ""] ?? "rectangle",
      role: node.role ?? "process",
      label: node.label,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      fontSize,
      roughness,
    });
  }

  for (const edge of input.edges) {
    items.push({
      type: "arrow",
      fromId: nodeElementIds[edge.from],
      toId: nodeElementIds[edge.to],
      strokeStyle: edge.strokeStyle ?? "solid",
      roughness,
      ...(edge.startArrowhead !== undefined ? { startArrowhead: edge.startArrowhead } : {}),
      ...(edge.endArrowhead !== undefined ? { endArrowhead: edge.endArrowhead } : {}),
    });
    if (edge.label) {
      const from = nodePlacements.get(edge.from) as Placed;
      const to = nodePlacements.get(edge.to) as Placed;
      const labelFontSize = Math.round(fontSize * EDGE_LABEL_FONT_RATIO);
      const measured = measureText(edge.label, labelFontSize, DEFAULT_FONT_FAMILY);
      const midX = (from.x + from.width / 2 + to.x + to.width / 2) / 2;
      const midY = (from.y + from.height / 2 + to.y + to.height / 2) / 2;
      items.push({
        type: "text",
        text: edge.label,
        x: midX - measured.width / 2 + 8,
        y: midY - measured.height / 2,
        fontSize: labelFontSize,
        strokeColor: "#495057",
      });
    }
  }

  return {
    items,
    nodeElementIds,
    bounds: {
      x: originX,
      y: originY,
      width: graph.width ?? 0,
      height: graph.height ?? 0,
    },
  };
};
