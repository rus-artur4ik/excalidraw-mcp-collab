import {describe, expect, it} from "vitest";

import {getSyncableElements} from "../../scene";
import {el} from "./factory";

describe("getSyncableElements (linear persistence fix)", () => {
  it("keeps an axis-aligned arrow with zero bbox height as long as it has points", () => {
    const arrow = el({
      type: "arrow",
      id: "AR",
      x: 106,
      y: 30,
      width: 188,
      height: 0,
      points: [
        [0, 0],
        [188, 0],
      ],
    });
    const syncable = getSyncableElements([arrow]);
    expect(syncable.map((e) => e.id)).toContain("AR");
  });

  it("keeps a same-column arrow with zero width", () => {
    const arrow = el({
      type: "arrow",
      id: "VR",
      x: 0,
      y: 0,
      width: 0,
      height: 120,
      points: [
        [0, 0],
        [0, 120],
      ],
    });
    expect(getSyncableElements([arrow]).map((e) => e.id)).toContain("VR");
  });

  it("keeps a freshly created line/arrow that has no points yet (default size)", () => {
    const line = el({ type: "line", id: "LN", width: 100, height: 100 });
    expect(getSyncableElements([line]).map((e) => e.id)).toContain("LN");
  });

  it("still drops zero-area shapes", () => {
    const rect = el({ type: "rectangle", id: "R", width: 0, height: 50 });
    expect(getSyncableElements([rect])).toHaveLength(0);
  });

  it("drops an arrow with fewer than two points", () => {
    const arrow = el({ type: "arrow", id: "A1", width: 0, height: 0, points: [[0, 0]] });
    expect(getSyncableElements([arrow])).toHaveLength(0);
  });
});
