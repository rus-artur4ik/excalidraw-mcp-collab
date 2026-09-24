import {describe, expect, it} from "vitest";

import {getVerticalOffset} from "../fonts";
import {isPngAvailable, renderSvg, resvgRenderOptions} from "../render";
import {el, textEl} from "./factory";

const textTags = (svg: string): string[] => svg.match(/<text [^>]*>[^<]*<\/text>/g) ?? [];

const attr = (tag: string, name: string): number =>
  Number(tag.match(new RegExp(` ${name}="([^"]+)"`))![1]);

describe("text rendering", () => {
  it("keeps leading and repeated spaces", () => {
    const { svg } = renderSvg([textEl({ id: "code", text: "    return  42;", fontFamily: 3 })]);
    const tag = textTags(svg).find((t) => t.includes("return"))!;
    expect(tag).toContain('xml:space="preserve"');
    expect(tag).toContain("white-space:pre");
    expect(tag).toContain(">    return  42;</text>");
  });

  it("draws fontFamily 3 with the vendored monospace font", () => {
    const { svg } = renderSvg([textEl({ text: "mono", fontFamily: 3 })]);
    expect(textTags(svg)[0]).toContain(`font-family="'Cascadia Code', monospace"`);
  });

  it("puts each line on the client's alphabetic baseline", () => {
    const { svg } = renderSvg([textEl({ text: "one\ntwo", x: 0, y: 100 })], { scale: 1 });
    const [first, second] = textTags(svg);
    const offset = getVerticalOffset(5, 20, 25);
    expect(attr(first, "y")).toBeCloseTo(100 + offset, 1);
    expect(attr(second, "y")).toBeCloseTo(100 + offset + 25, 1);
  });

  it("draws glyphs from another font as their own chunk", () => {
    const tags = textTags(renderSvg([textEl({ text: "A → B" })], { showLabels: false }).svg);
    expect(tags).toHaveLength(3);
    expect(tags[1]).toContain("Liberation Sans");
    expect(tags[1]).toContain(">→</text>");
    expect(attr(tags[1], "x")).toBeGreaterThan(attr(tags[0], "x"));
    expect(attr(tags[2], "x")).toBeGreaterThan(attr(tags[1], "x"));
  });

  it("drops characters XML cannot carry", () => {
    const control = String.fromCharCode(1);
    expect(renderSvg([textEl({ text: `a${control}b` })]).svg).not.toContain(control);
  });
});

describe("arrow labels", () => {
  const arrow = el({
    type: "arrow",
    id: "arr",
    x: 100,
    y: 50,
    width: 200,
    height: 0,
    points: [[0, 0], [200, 0]],
    endArrowhead: "arrow",
    boundElements: [{ id: "lbl", type: "text" }],
    index: "a2",
  });
  // Stale x/y on purpose: the client places arrow labels from the arrow's points.
  const label = textEl({ id: "lbl", text: "calls", containerId: "arr", textAlign: "center", index: "a1" });

  it("places the label on the arrow midpoint and cuts the stroke out under it", () => {
    const { svg } = renderSvg([arrow, label], { scale: 1, showLabels: false });
    const tag = textTags(svg).find((t) => t.includes("calls"))!;
    // Text coordinates are scene coordinates (the scene group carries the transform).
    expect(attr(tag, "x")).toBeCloseTo(200, 1);
    const mask = svg.match(/<mask id="([^"]+)"[^>]*>.*?<\/mask>/)!;
    const hole = mask[0].match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#000"/)!;
    const width = label.width;
    const height = label.height;
    expect(Number(hole[1])).toBeCloseTo(200 - width / 2 - 5, 1);
    expect(Number(hole[2])).toBeCloseTo(50 - height / 2 - 5, 1);
    expect(Number(hole[3])).toBeCloseTo(width + 10, 1);
    expect(Number(hole[4])).toBeCloseTo(height + 10, 1);
    expect(svg).toContain(`mask="url(#${mask[1]})"`);
  });

  it("draws the label with its arrow even when the label sorts below it", () => {
    const { svg } = renderSvg([arrow, label], { showLabels: false });
    expect(svg.indexOf(">calls<")).toBeGreaterThan(svg.indexOf("<path"));
  });

  it("puts the label of a three-point arrow on its middle point", () => {
    const bent = el({
      type: "arrow",
      id: "bent",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      points: [[0, 0], [100, 100], [200, 0]],
      boundElements: [{ id: "bl", type: "text" }],
    });
    const bentLabel = textEl({ id: "bl", text: "x", containerId: "bent", textAlign: "center" });
    const { svg } = renderSvg([bent, bentLabel], { showLabels: false });
    const tag = textTags(svg).find((t) => t.includes(">x<"))!;
    expect(attr(tag, "x")).toBeCloseTo(100, 1);
    expect(attr(tag, "y")).toBeGreaterThan(100 - bentLabel.height / 2);
  });
});

describe("arrowheads", () => {
  const arrowWith = (overrides: Record<string, unknown>) =>
    el({ type: "arrow", x: 0, y: 0, width: 300, height: 0, points: [[0, 0], [300, 0]], ...overrides });

  const headsOf = (svg: string): string => {
    const start = svg.indexOf("<path");
    return svg.slice(svg.indexOf(">", start) + 1, svg.indexOf("</g>", start));
  };
  const draw = (overrides: Record<string, unknown>) =>
    headsOf(renderSvg([arrowWith({ strokeColor: "#123456", ...overrides })], { showLabels: false }).svg);

  it("draws heads solid even on dotted arrows", () => {
    const { svg } = renderSvg([arrowWith({ strokeStyle: "dotted", endArrowhead: "arrow" })], { showLabels: false });
    expect(svg).toMatch(/<path [^>]*stroke-dasharray/);
    expect(headsOf(svg)).toContain("<polyline");
    expect(headsOf(svg)).not.toContain("stroke-dasharray");
  });

  it("draws the head types like the client", () => {
    expect(draw({ endArrowhead: "triangle" })).toMatch(/<polygon [^>]*fill="#123456"/);
    expect(draw({ endArrowhead: "triangle_outline" })).toMatch(/<polygon [^>]*fill="#ffffff"/);
    expect(draw({ endArrowhead: "dot" })).toMatch(/<circle [^>]*fill="#123456"/);
    expect(draw({ endArrowhead: "circle_outline" })).toMatch(/<circle [^>]*fill="#ffffff"/);
    expect(draw({ endArrowhead: "diamond" }).match(/<polygon points="([^"]+)"/)![1].split(" ")).toHaveLength(4);
    expect(draw({ endArrowhead: "bar" })).toContain("<polyline");
    expect(draw({ endArrowhead: "crowfoot_many" }).match(/<polyline points="([^"]+)"/)![1].split(" ")).toHaveLength(3);
    expect(draw({ endArrowhead: "cardinality_zero_or_many" })).toContain("<circle");
    expect(draw({ endArrowhead: null })).toBe("");
    expect(draw({ endArrowhead: null, startArrowhead: "triangle" })).toContain("<polygon");
  });

  it("gives an arrow without an endArrowhead field the default head", () => {
    expect(draw({})).toContain("<polyline");
  });

  it("scales the arrow head down on a short last segment", () => {
    const long = draw({ endArrowhead: "triangle" }).match(/<polygon points="([^"]+)"/)![1];
    const short = headsOf(
      renderSvg([el({ type: "arrow", x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [10, 0]], endArrowhead: "triangle" })], {
        showLabels: false,
        scale: 1,
      }).svg,
    ).match(/<polygon points="([^"]+)"/)![1];
    const spanX = (points: string) => {
      const xs = points.split(" ").map((p) => Number(p.split(",")[0]));
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spanX(short)).toBeLessThan(spanX(long));
  });
});

describe("frames", () => {
  const frame = el({ type: "frame", id: "f1", x: 0, y: 0, width: 400, height: 200, name: "Read path", index: "a1" });
  const child = el({ type: "rectangle", id: "c1", x: 20, y: 20, width: 100, height: 50, frameId: "f1", index: "a2" });

  it("draws frames as outlines with their name above, like the client", () => {
    const { svg, transform } = renderSvg([frame, child], { scale: 1, showLabels: false });
    expect(svg).toMatch(/<rect [^>]*rx="8" fill="none" stroke="#bbb"/);
    const name = textTags(svg).find((t) => t.includes("Read path"))!;
    expect(name).toContain('fill="#999999"');
    expect(name).toContain('font-size="14"');
    // The name's baseline sits above the frame's top edge.
    expect(attr(name, "y")).toBeLessThan(transform.offsetY * transform.scale);
    expect(attr(name, "y")).toBeGreaterThan(0);
  });

  it("clips frame children to the frame", () => {
    const { svg } = renderSvg([frame, child], { showLabels: false });
    const clip = svg.match(/<clipPath id="([^"]+)"/)![1];
    expect(svg).toContain(`<g clip-path="url(#${clip})"><g><rect x="20"`);
  });

  it("truncates long names to the frame width and can hide them", () => {
    const narrow = el({ type: "frame", x: 0, y: 0, width: 60, height: 60, name: "A very long frame name" });
    expect(textTags(renderSvg([narrow], { scale: 1 }).svg).some((t) => t.includes("...</text>"))).toBe(true);
    expect(renderSvg([frame], { showFrameNames: false }).svg).not.toContain("Read path");
  });

  it("names unnamed frames like the client", () => {
    const { svg } = renderSvg([el({ type: "frame", x: 0, y: 0, width: 300, height: 100, name: null })]);
    expect(svg).toContain(">Frame</text>");
  });
});

describe("render fidelity", () => {
  it("is ok when every glyph comes from the vendored client fonts", () => {
    expect(renderSvg([textEl({ text: "Привет → world" })]).fidelity).toEqual({ ok: true });
  });

  it("lists text ids that need a system font", () => {
    const result = renderSvg([
      textEl({ id: "fine", text: "fine" }),
      textEl({ id: "emoji", text: "done ✓", y: 50 }),
    ]);
    expect(result.fidelity).toEqual({ ok: false, fontFallback: ["emoji"], arrowLabelMasking: true });
  });
});

type RawImage = { pixels: Buffer; width: number; height: number };

describe.skipIf(!isPngAvailable())("rasterized text", () => {
  const rasterize = (svg: string): RawImage => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Resvg } = require("@resvg/resvg-js");
    const options = resvgRenderOptions();
    // Vendored fonts only: faster, and nothing else could draw the text.
    const image = new Resvg(svg, { ...options, font: { ...options.font, loadSystemFonts: false } }).render();
    // `pixels` is a getter that copies the whole RGBA buffer on every access: read it
    // once. Indexing it per pixel allocated width*height copies (8 GB peak, which got
    // the CI agent OOMKilled).
    return { pixels: image.pixels, width: image.width, height: image.height };
  };

  const inkColumns = (image: RawImage): [number, number] => {
    let min = Infinity;
    let max = -Infinity;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        if (image.pixels[i] < 128) {
          min = Math.min(min, x);
          max = Math.max(max, x);
        }
      }
    }
    return [min, max];
  };

  it.each([
    [5, "Кольцо чтения: getMessage"],
    [6, "Nunito renders Nunito"],
    [3, "const x = 42;"],
  ])("draws family %i as wide as measureText says", (fontFamily, text) => {
    const element = textEl({ text, fontFamily, fontSize: 40 });
    const { svg } = renderSvg([element], { scale: 1, padding: 10, showLabels: false });
    const [min, max] = inkColumns(rasterize(svg));
    const ink = max - min + 1;
    // Ink leaves out the side bearings, so it is a little narrower than the
    // advance width; a substituted font (DejaVu was 12–15 % wider) overshoots.
    expect(ink).toBeLessThanOrEqual(element.width + 2);
    expect(ink).toBeGreaterThan(element.width * 0.9);
  });
});
