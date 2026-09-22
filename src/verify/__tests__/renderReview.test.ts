import {describe, expect, it} from "vitest";

import {sceneToPixel} from "../geometry";
import type {Bounds} from "../model";
import {renderSvg} from "../render";
import {el, textEl} from "./factory";

const container = el({
  type: "rectangle",
  id: "box",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  index: "a1",
  boundElements: [{ id: "box:label", type: "text" }],
});
const label = textEl({
  id: "box:label",
  text: "Read   path\nsecond line",
  x: 20,
  y: 15,
  containerId: "box",
  index: "a2",
});
const frame = el({ type: "frame", id: "f1", x: -50, y: -50, width: 500, height: 300, name: "Frame one", index: "a0" });
const free = textEl({ id: "note", text: "free note", x: 260, y: 20, index: "a3" });
const scene = [frame, container, label, free];

describe("legend modes", () => {
  it("keeps the full legend by default", () => {
    const result = renderSvg(scene);
    expect(result.legendMode).toBe("full");
    expect(result.legend.map((entry) => entry.id)).toEqual(["f1", "box", "box:label", "note"]);
    expect(result.legend.map((entry) => entry.label)).toEqual(["1", "2", "3", "4"]);
  });

  it("omits the legend with none", () => {
    const result = renderSvg(scene, { legend: "none" });
    expect(result.legendMode).toBe("none");
    expect(result.legend).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('"legend"');
  });

  it("lists ids in z-order with ids", () => {
    expect(renderSvg(scene, { legend: "ids" }).legend).toEqual(["f1", "box", "box:label", "note"]);
  });

  it("writes one compact line per element, label text on its container", () => {
    const { legend } = renderSvg(scene, { legend: "compact" });
    expect(legend).toEqual([
      "f1 frame -50 -50 500 300 Frame one",
      "box rectangle 0 0 200 80 Read path second line",
      `note text 260 20 ${Math.round(free.width)} ${Math.round(free.height)} free note`,
    ]);
  });

  it("describes frames with frames", () => {
    expect(renderSvg(scene, { legend: "frames" }).legend).toEqual([
      { id: "f1", name: "Frame one", x: -50, y: -50, width: 500, height: 300 },
    ]);
  });

  it("numbers the Set-of-Mark badges like the full legend", () => {
    const withBadges = renderSvg(scene, { legend: "none", showLabels: true });
    const badges = [...withBadges.svg.matchAll(/font-size="10" fill="#ffffff" text-anchor="middle">(\d+)<\/text>/g)].map(
      (m) => m[1],
    );
    expect(badges).toEqual(renderSvg(scene).legend.map((entry) => entry.label));
  });
});

describe("highlight", () => {
  it("outlines the given ids outside their bounds", () => {
    const { svg, transform } = renderSvg(scene, { highlight: ["box"], showLabels: false });
    const rect = svg.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="none" stroke="#e03131" stroke-width="3" stroke-dasharray="8 4"/)!;
    expect(rect).toBeTruthy();
    const [px, py] = sceneToPixel(transform, 0, 0);
    expect(Number(rect[1])).toBeLessThan(px);
    expect(Number(rect[2])).toBeLessThan(py);
    expect(Number(rect[3])).toBeGreaterThan(200 * transform.scale);
  });

  it("ignores unknown ids", () => {
    expect(renderSvg(scene, { highlight: ["nope"] }).svg).not.toContain('stroke="#e03131" stroke-width="3"');
  });
});

describe("scale and readability", () => {
  it("reports the scale used and the smallest text in output pixels", () => {
    const result = renderSvg([container, label, textEl({ text: "tiny", fontSize: 12, x: 0, y: 100 })], { scale: 1.5 });
    expect(result.readability).toEqual({ fitScale: 1.5, minEffectiveFontPx: 18 });
    expect(renderSvg([container]).readability.minEffectiveFontPx).toBeNull();
  });

  it("fits wide scenes into maxPixelWidth by default", () => {
    const wide = [el({ type: "rectangle", x: 0, y: 0, width: 4000, height: 300 })];
    expect(renderSvg(wide).width).toBeLessThanOrEqual(1600);
    expect(renderSvg(wide, { maxPixelWidth: 800 }).width).toBeLessThanOrEqual(800);
  });

  it("zooms small scenes up to 2x and honours an explicit scale", () => {
    const small = [el({ type: "rectangle", x: 0, y: 0, width: 100, height: 50 })];
    expect(renderSvg(small).transform.scale).toBe(2);
    expect(renderSvg(small, { scale: 1 }).transform.scale).toBe(1);
  });

  it("still caps the pixel count", () => {
    const huge = [el({ type: "rectangle", x: 0, y: 0, width: 3000, height: 3000 })];
    const result = renderSvg(huge, { scale: 4 });
    expect(result.width * result.height).toBeLessThanOrEqual(4_000_001);
  });
});

describe("tiles", () => {
  const region: Bounds = [0, 0, 6000, 2000];
  const texts = [
    textEl({ id: "t1", text: "small print", fontSize: 12, x: 100, y: 100 }),
    textEl({ id: "t2", text: "far right", fontSize: 12, x: 5800, y: 1900 }),
  ];

  it("splits a large region into readable tiles", () => {
    const result = renderSvg(texts, { region, layout: "tiles", legend: "none" });
    expect(result.layout).toBe("tiles");
    expect(result.readability.minEffectiveFontPx!).toBeLessThan(10);
    const tiles = result.tiles!;
    expect(tiles.length).toBeGreaterThan(1);
    for (const tile of tiles) {
      expect(tile.width).toBeLessThanOrEqual(1600.01);
      expect(tile.svg.startsWith("<svg")).toBe(true);
      if (tile.readability.minEffectiveFontPx !== null) {
        expect(tile.readability.minEffectiveFontPx).toBeGreaterThanOrEqual(10);
      }
    }
    // Together the tiles cover the region.
    expect(Math.min(...tiles.map((t) => t.region[0]))).toBe(0);
    expect(Math.max(...tiles.map((t) => t.region[2]))).toBe(6000);
    expect(tiles.some((t) => t.svg.includes(">far right<"))).toBe(true);
  });

  it("keeps an explicit scale and tiles what does not fit maxPixelWidth", () => {
    const result = renderSvg(texts, { region, layout: "tiles", scale: 1, legend: "none" });
    expect(result.tiles!.length).toBeGreaterThan(1);
    for (const tile of result.tiles!) {
      expect(tile.transform.scale).toBe(1);
      expect(tile.width).toBeLessThanOrEqual(1600.01);
    }
  });

  it("returns the single render as the only tile when it is readable already", () => {
    const result = renderSvg([textEl({ text: "big enough", fontSize: 20 })], { layout: "tiles" });
    expect(result.tiles).toHaveLength(1);
    expect(result.tiles![0].svg).toBe(result.svg);
  });
});

describe("sheet", () => {
  const a = el({ type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 60 });
  const b = el({ type: "ellipse", id: "b", x: 2000, y: 0, width: 80, height: 80 });
  const c = el({ type: "diamond", id: "c", x: 0, y: 1500, width: 120, height: 90 });

  it("lays out one labelled crop per id", () => {
    const result = renderSvg([a, b, c], { ids: ["a", "b", "c"], layout: "sheet", legend: "ids" });
    expect(result.layout).toBe("sheet");
    expect(result.sheet!.map((cell) => cell.id)).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) {
      expect(result.svg).toContain(`>${id}</text>`);
    }
    expect(result.legend).toEqual(["a", "b", "c"]);
    for (const cell of result.sheet!) {
      const element = [a, b, c].find((e) => e.id === cell.id)!;
      const [x, y] = sceneToPixel(cell.transform, element.x + element.width / 2, element.y + element.height / 2);
      expect(x).toBeGreaterThan(cell.x);
      expect(x).toBeLessThan(cell.x + cell.width);
      expect(y).toBeGreaterThan(cell.y);
      expect(y).toBeLessThan(cell.y + cell.height);
    }
    expect(result.width).toBeLessThanOrEqual(1600);
  });

  it("renders a single id normally", () => {
    expect(renderSvg([a, b], { ids: ["a"], layout: "sheet" }).layout).toBe("single");
  });
});

describe("ids", () => {
  it("brings a container's label and a frame's children along", () => {
    const child = el({ type: "rectangle", id: "kid", x: 0, y: 0, width: 50, height: 50, frameId: "f1" });
    expect(renderSvg(scene, { ids: ["box"], legend: "ids" }).legend).toEqual(["box", "box:label"]);
    expect(renderSvg([...scene, child], { ids: ["f1"], legend: "ids" }).legend).toContain("kid");
  });
});
