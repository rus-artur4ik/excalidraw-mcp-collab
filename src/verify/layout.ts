import ELK, {type ElkExtendedEdge, type ElkNode} from "elkjs";

import {BOUND_TEXT_PADDING, DEFAULT_FONT_FAMILY} from "./model";
import {containerSizeForText, measureText, wrapText} from "./textMetrics";
import {MUTED_TEXT_COLOR, ROLE_NAMES, ROLE_SHAPES, SIZE_LADDER} from "./styles";
import type {CreateItem} from "../engine/create";

export type DiagramNode = {
  id: string;
  label: string;
  role?: string;
  shape?: "rectangle" | "ellipse" | "diamond";
  width?: number;
  height?: number;
  group?: string;
  layer?: number;
  order?: number;
};

export type DiagramEdge = {
  id?: string;
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
  strokeStyle?: "solid" | "dashed" | "dotted";
};

export type DiagramConstraint =
  | { sameRank: string[] }
  | { before: [string, string] };

export type DiagramInput = {
  diagramId?: string;
  idPrefix?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
  direction?: "DOWN" | "RIGHT" | "UP" | "LEFT";
  spacing?: number;
  layout?: { nodeSpacing?: number; layerSpacing?: number; groupPadding?: number };
  constraints?: DiagramConstraint[];
  origin?: { x: number; y: number };
  fontSize?: number;
  roughness?: number;
  frameId?: string;
};

export type DiagramPlan = {
  items: CreateItem[];
  nodeElementIds: Record<string, string>;
  edgeElementIds: string[];
  groupElementIds: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number };
};

const NODE_MIN = SIZE_LADDER.secondary;
const NODE_TEXT_PADDING_X = 16;
const NODE_MAX_LABEL_WIDTH = 220;
const DEFAULT_SPACING = 48;
const DEFAULT_FONT_SIZE = 16;
const EDGE_LABEL_FONT_RATIO = 0.85;
const DEFAULT_GROUP_PADDING = 32;
const GROUP_STROKE = MUTED_TEXT_COLOR;
const EDGE_LABEL_COLOR = "#495057";

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
  const shape = node.shape ?? ROLE_SHAPES[node.role ?? ""] ?? "rectangle";
  const box = containerSizeForText(
    shape,
    measured.width + NODE_TEXT_PADDING_X * 2,
    measured.height + BOUND_TEXT_PADDING * 2,
  );
  return {
    width: Math.ceil(Math.max(node.width ?? NODE_MIN.width, box.width)),
    height: Math.ceil(Math.max(node.height ?? NODE_MIN.height, box.height)),
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
  for (const group of input.groups ?? []) {
    if (ids.has(group.id)) {
      throw new Error(`group id ${group.id} is also a node id; ids must be unique`);
    }
  }
  for (const node of input.nodes) {
    if (node.group && !groupIds.has(node.group)) {
      throw new Error(`node ${node.id} references unknown group ${node.group}`);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of input.edges) {
    if (!ids.has(edge.from)) {
      throw new Error(`edge references unknown node: ${edge.from}`);
    }
    if (!ids.has(edge.to)) {
      throw new Error(`edge references unknown node: ${edge.to}`);
    }
    if (edge.id) {
      if (edgeIds.has(edge.id) || ids.has(edge.id) || groupIds.has(edge.id)) {
        throw new Error(`duplicate id: ${edge.id}`);
      }
      edgeIds.add(edge.id);
    }
  }
  for (const constraint of input.constraints ?? []) {
    const referenced = "sameRank" in constraint ? constraint.sameRank : constraint.before;
    for (const id of referenced) {
      if (!ids.has(id)) {
        throw new Error(`constraint references unknown node: ${id}`);
      }
    }
  }
};

const spacingOptions = (input: DiagramInput): Record<string, string> => {
  const nodeSpacing = input.layout?.nodeSpacing ?? input.spacing ?? DEFAULT_SPACING;
  const layerSpacing = input.layout?.layerSpacing ?? Math.round(nodeSpacing * 1.5);
  return {
    "elk.spacing.nodeNode": String(nodeSpacing),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
    "elk.spacing.edgeNode": String(Math.round(nodeSpacing / 2)),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(Math.round(nodeSpacing / 2)),
    "elk.spacing.edgeLabel": "6",
    "elk.edgeLabels.placement": "CENTER",
  };
};

// Layer (partition) per node: explicit `layer`, then sameRank groups share
// the smallest layer given to any of their members (or a fresh one).
const partitionsOf = (input: DiagramInput): Map<string, number> => {
  const partitions = new Map<string, number>();
  for (const node of input.nodes) {
    if (typeof node.layer === "number") partitions.set(node.id, Math.max(0, Math.round(node.layer)));
  }
  let next = Math.max(-1, ...partitions.values()) + 1;
  for (const constraint of input.constraints ?? []) {
    if (!("sameRank" in constraint)) continue;
    const given = constraint.sameRank.map((id) => partitions.get(id)).filter((v): v is number => v !== undefined);
    const layer = given.length ? Math.min(...given) : next++;
    for (const id of constraint.sameRank) partitions.set(id, layer);
  }
  return partitions;
};

// Model order: nodes with `order` first by it; `before` pairs are enforced by
// moving the later node right after the earlier one.
const orderedNodes = (input: DiagramInput): DiagramNode[] => {
  const nodes = [...input.nodes].sort((a, b) => {
    const oa = typeof a.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
    const ob = typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });
  for (const constraint of input.constraints ?? []) {
    if (!("before" in constraint)) continue;
    const [first, second] = constraint.before;
    const i = nodes.findIndex((node) => node.id === first);
    const j = nodes.findIndex((node) => node.id === second);
    if (i > j) {
      const [moved] = nodes.splice(i, 1);
      nodes.splice(j, 0, moved);
    }
  }
  return nodes;
};

const edgeLabelFont = (fontSize: number): number => Math.round(fontSize * EDGE_LABEL_FONT_RATIO);

const buildElkGraph = (input: DiagramInput, fontSize: number): ElkNode => {
  const groupPadding = input.layout?.groupPadding ?? DEFAULT_GROUP_PADDING;
  const partitions = partitionsOf(input);
  const usesOrder =
    input.nodes.some((node) => typeof node.order === "number") ||
    (input.constraints ?? []).some((constraint) => "before" in constraint);
  const groupChildren = new Map<string, ElkNode[]>();
  const rootChildren: ElkNode[] = [];
  for (const node of orderedNodes(input)) {
    const partition = partitions.get(node.id);
    const elkNode: ElkNode = {
      id: node.id,
      ...nodeSize(node, fontSize),
      ...(partition !== undefined
        ? { layoutOptions: { "elk.partitioning.partition": String(partition) } }
        : {}),
    };
    if (node.group) {
      const list = groupChildren.get(node.group) ?? [];
      list.push(elkNode);
      groupChildren.set(node.group, list);
    } else {
      rootChildren.push(elkNode);
    }
  }
  const spacing = spacingOptions(input);
  for (const group of input.groups ?? []) {
    const titleSpace = group.label ? Math.ceil(measureText(group.label, fontSize, DEFAULT_FONT_FAMILY).height) + BOUND_TEXT_PADDING * 2 : 0;
    rootChildren.push({
      id: group.id,
      layoutOptions: {
        // Spacing is per parent in ELK: without repeating it here the nodes
        // inside a group fall back to ELK's cramped defaults.
        ...spacing,
        "elk.padding": `[top=${groupPadding + titleSpace},left=${groupPadding},bottom=${groupPadding},right=${groupPadding}]`,
      },
      children: groupChildren.get(group.id) ?? [],
    });
  }
  const labelFont = edgeLabelFont(fontSize);
  const edges: ElkExtendedEdge[] = input.edges.map((edge, i) => {
    const measured = edge.label ? measureText(edge.label, labelFont, DEFAULT_FONT_FAMILY) : null;
    return {
      id: `edge_${i}`,
      sources: [edge.from],
      targets: [edge.to],
      ...(measured
        ? {
            labels: [
              {
                id: `edge_${i}_label`,
                text: edge.label,
                width: Math.ceil(measured.width) + 8,
                height: Math.ceil(measured.height) + 4,
              },
            ],
          }
        : {}),
    };
  });
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": input.direction ?? "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      ...spacing,
      "elk.spacing.componentComponent": String(
        (input.layout?.nodeSpacing ?? input.spacing ?? DEFAULT_SPACING) * 2,
      ),
      ...(partitions.size ? { "elk.partitioning.activate": "true" } : {}),
      ...(usesOrder
        ? {
            "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
            "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
          }
        : {}),
    },
    children: rootChildren,
    edges,
  };
};

const edgeIdFor = (edge: DiagramEdge, prefix: string, used: Set<string>): string => {
  if (edge.id) return `${prefix}${edge.id}`;
  const base = `${prefix}${edge.from}->${edge.to}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}#${n}`;
  return id;
};

export const planDiagram = async (input: DiagramInput): Promise<DiagramPlan> => {
  validateInput(input);
  const fontSize = input.fontSize ?? DEFAULT_FONT_SIZE;
  const roughness = input.roughness ?? 1;
  const originX = input.origin?.x ?? 0;
  const originY = input.origin?.y ?? 0;
  const prefix = input.idPrefix ?? (input.diagramId ? `${input.diagramId}:` : "");

  const graph = await new ELK().layout(buildElkGraph(input, fontSize));

  const groupIds = new Set((input.groups ?? []).map((group) => group.id));
  const nodePlacements = new Map<string, Placed>();
  const groupPlacements = new Map<string, Placed>();
  collectPlacements(graph, originX, originY, nodePlacements, groupPlacements, groupIds);

  const nodeElementIds: Record<string, string> = {};
  for (const node of input.nodes) {
    nodeElementIds[node.id] = `${prefix}${node.id}`;
  }
  const groupElementIds: Record<string, string> = {};
  const tag = (kind?: string): Record<string, unknown> => ({
    ...(input.diagramId ? { customData: { diagramId: input.diagramId } } : {}),
    ...(kind ? { kind } : {}),
    ...(input.frameId ? { frameId: input.frameId } : {}),
  });

  const items: CreateItem[] = [];

  for (const group of input.groups ?? []) {
    const placed = groupPlacements.get(group.id);
    if (!placed) {
      continue;
    }
    const id = `${prefix}${group.id}`;
    groupElementIds[group.id] = id;
    items.push({
      ...tag("group-frame"),
      id,
      type: "rectangle",
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      strokeColor: GROUP_STROKE,
      // Dashed means "[planned]" on these boards; a cluster is solid.
      strokeStyle: group.strokeStyle ?? "solid",
      backgroundColor: "transparent",
      roughness,
      ...(group.label
        ? {
            label: group.label,
            textAlign: "left",
            verticalAlign: "top",
            labelFontSize: fontSize,
            labelColor: "#495057",
            fit: "none",
          }
        : {}),
    } as CreateItem);
  }

  for (const node of input.nodes) {
    const placed = nodePlacements.get(node.id);
    if (!placed) {
      throw new Error(`layout produced no position for node ${node.id}`);
    }
    items.push({
      ...tag(),
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
    } as CreateItem);
  }

  const edgeElementIds: string[] = [];
  const used = new Set<string>();
  const labelFont = edgeLabelFont(fontSize);
  for (const edge of input.edges) {
    const id = edgeIdFor(edge, prefix, used);
    used.add(id);
    edgeElementIds.push(id);
    items.push({
      ...tag(),
      id,
      type: "arrow",
      fromId: nodeElementIds[edge.from],
      toId: nodeElementIds[edge.to],
      strokeStyle: edge.strokeStyle ?? "solid",
      roughness,
      ...(edge.startArrowhead !== undefined ? { startArrowhead: edge.startArrowhead } : {}),
      ...(edge.endArrowhead !== undefined ? { endArrowhead: edge.endArrowhead } : {}),
      // Edge labels are bound to their arrow (they ride along and stay on it).
      ...(edge.label
        ? { label: edge.label, labelFontSize: labelFont, labelColor: EDGE_LABEL_COLOR }
        : {}),
    } as CreateItem);
  }

  return {
    items,
    nodeElementIds,
    edgeElementIds,
    groupElementIds,
    bounds: {
      x: originX,
      y: originY,
      width: graph.width ?? 0,
      height: graph.height ?? 0,
    },
  };
};
