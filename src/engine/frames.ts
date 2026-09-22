import type {ExcalidrawElement} from "../types";
import {applyUpdate} from "../elements";
import {customDataOf} from "../customData";
import {invalidArgs, notFound} from "./errors";
import {moveElements} from "./move";
import {fitFrameToChildren} from "./update";
import type {SceneTxn} from "./txn";

export type FrameLayoutOptions = {
  order: string[];
  mode?: "flow" | "column" | "grid";
  maxRowWidth?: number;
  gap?: number;
  columns?: number;
  origin?: { x: number; y: number };
  fitToContent?: boolean;
  padding?: number;
};

// Lay frames out as a reading sequence (I24): flow wraps rows at maxRowWidth,
// column stacks them, grid uses fixed columns. Frames move with their content
// and remember their reading order in customData.order.
export const layoutFrames = (txn: SceneTxn, options: FrameLayoutOptions): { moved: string[] } => {
  const frames: ExcalidrawElement[] = [];
  for (const id of options.order) {
    const frame = txn.live(id);
    if (!frame) throw notFound(`frame not found: ${id}`, [id]);
    if (frame.type !== "frame" && frame.type !== "magicframe") {
      throw invalidArgs(`${id} is a ${frame.type}, not a frame`, { ids: [id] });
    }
    frames.push(frame);
  }
  if (!frames.length) {
    return { moved: [] };
  }
  if (options.fitToContent) {
    for (const frame of frames) {
      fitFrameToChildren(txn, frame.id, { padding: options.padding, shrink: true });
    }
  }
  const sized = frames.map((frame) => txn.live(frame.id)!);
  const gap = options.gap ?? 160;
  const mode = options.mode ?? "flow";
  const maxRowWidth = options.maxRowWidth ?? 2200;
  const originX = options.origin?.x ?? Math.min(...sized.map((frame) => frame.x));
  const originY = options.origin?.y ?? Math.min(...sized.map((frame) => frame.y));
  const targets = new Map<string, { x: number; y: number }>();

  if (mode === "column") {
    let y = originY;
    for (const frame of sized) {
      targets.set(frame.id, { x: originX, y });
      y += frame.height + gap;
    }
  } else if (mode === "grid") {
    const columns = Math.max(1, options.columns ?? Math.ceil(Math.sqrt(sized.length)));
    const colWidths: number[] = [];
    const rowHeights: number[] = [];
    sized.forEach((frame, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      colWidths[col] = Math.max(colWidths[col] ?? 0, frame.width);
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, frame.height);
    });
    sized.forEach((frame, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = originX + colWidths.slice(0, col).reduce((sum, width) => sum + width + gap, 0);
      const y = originY + rowHeights.slice(0, row).reduce((sum, height) => sum + height + gap, 0);
      targets.set(frame.id, { x, y });
    });
  } else {
    let x = originX;
    let y = originY;
    let rowHeight = 0;
    for (const frame of sized) {
      if (x > originX && x + frame.width > originX + maxRowWidth) {
        x = originX;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      targets.set(frame.id, { x, y });
      x += frame.width + gap;
      rowHeight = Math.max(rowHeight, frame.height);
    }
  }

  const moved: string[] = [];
  sized.forEach((frame, order) => {
    const target = targets.get(frame.id)!;
    const current = txn.live(frame.id)!;
    const dx = target.x - current.x;
    const dy = target.y - current.y;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      moved.push(...moveElements(txn, [current], dx, dy).moved);
    }
    const after = txn.live(frame.id)!;
    if (customDataOf(after).order !== order) {
      txn.put(applyUpdate(after, { customData: { ...customDataOf(after), order } }));
    }
  });
  return { moved };
};
