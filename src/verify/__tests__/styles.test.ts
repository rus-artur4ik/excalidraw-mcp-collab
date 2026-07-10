import {describe, expect, it} from "vitest";

import {applyRole, PALETTE_STROKES, STYLE_ROLES} from "../styles";
import {planCreations} from "../../elements";

describe("applyRole", () => {
  it("fills colors from the role", () => {
    const styled = applyRole({ type: "rectangle", role: "decision", label: "Ok?" });
    expect(styled).not.toHaveProperty("role");
    expect(styled.backgroundColor).toBe(STYLE_ROLES.decision.backgroundColor);
    expect(styled.strokeColor).toBe(STYLE_ROLES.decision.strokeColor);
    expect(styled.labelColor).toBe(STYLE_ROLES.decision.labelColor);
  });

  it("keeps explicit colors over the role", () => {
    const styled = applyRole({
      type: "rectangle",
      role: "process",
      backgroundColor: "#123456",
    });
    expect(styled.backgroundColor).toBe("#123456");
    expect(styled.strokeColor).toBe(STYLE_ROLES.process.strokeColor);
  });

  it("does not set labelColor when there is no label", () => {
    const styled = applyRole({ type: "rectangle", role: "process" });
    expect(styled).not.toHaveProperty("labelColor");
  });

  it("passes role-less attrs through untouched", () => {
    const attrs = { type: "rectangle", backgroundColor: "#fff" };
    expect(applyRole(attrs)).toEqual(attrs);
  });

  it("rejects unknown roles", () => {
    expect(() => applyRole({ type: "rectangle", role: "banana" })).toThrow(/unknown role/);
  });

  it("exposes a deduplicated stroke palette", () => {
    expect(PALETTE_STROKES.length).toBeGreaterThan(3);
    expect(new Set(PALETTE_STROKES).size).toBe(PALETTE_STROKES.length);
  });
});

describe("planCreations with role", () => {
  it("styles the container and its bound label", () => {
    const { created } = planCreations(
      [{ type: "rectangle", role: "error", label: "Boom", width: 160, height: 60 }],
      [],
    );
    const container = created.find((element) => element.type === "rectangle")!;
    const label = created.find((element) => element.type === "text")!;
    expect(container.backgroundColor).toBe(STYLE_ROLES.error.backgroundColor);
    expect(container.strokeColor).toBe(STYLE_ROLES.error.strokeColor);
    expect(label.strokeColor).toBe(STYLE_ROLES.error.labelColor);
    expect(container).not.toHaveProperty("role");
  });
});
