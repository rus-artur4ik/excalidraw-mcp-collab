export type StyleRole = {
  backgroundColor: string;
  strokeColor: string;
  labelColor: string;
};

// The note stroke doubles as the color of note-styled standalone text, so it
// must pass low_contrast (4.5:1) on white and on the `subtle` surface; #868e96
// only reached 3.3:1. #6a727a is the same hue, one lightness step darker.
export const STYLE_ROLES: Record<string, StyleRole> = {
  process: { backgroundColor: "#a5d8ff", strokeColor: "#1971c2", labelColor: "#1e1e1e" },
  decision: { backgroundColor: "#ffec99", strokeColor: "#f08c00", labelColor: "#1e1e1e" },
  terminal: { backgroundColor: "#b2f2bb", strokeColor: "#2f9e44", labelColor: "#1e1e1e" },
  error: { backgroundColor: "#ffc9c9", strokeColor: "#e03131", labelColor: "#1e1e1e" },
  external: { backgroundColor: "#e9ecef", strokeColor: "#495057", labelColor: "#1e1e1e" },
  accent: { backgroundColor: "#d0bfff", strokeColor: "#6741d9", labelColor: "#1e1e1e" },
  note: { backgroundColor: "transparent", strokeColor: "#6a727a", labelColor: "#495057" },
  neutral: { backgroundColor: "transparent", strokeColor: "#1e1e1e", labelColor: "#1e1e1e" },
};

export const ROLE_NAMES = Object.keys(STYLE_ROLES) as [string, ...string[]];

export const ROLE_TONES = ["solid", "subtle"] as const;

export type RoleTone = (typeof ROLE_TONES)[number];

// `subtle` keeps the role's stroke and swaps the fill for the lightest tint of
// the same hue (open-color shade 0, also offered by the client's color picker),
// so a highlighted cell or a callout reads as colored without looking like a node.
const SUBTLE_FILLS: Record<string, string> = {
  process: "#e7f5ff",
  decision: "#fff9db",
  terminal: "#ebfbee",
  error: "#fff5f5",
  external: "#f8f9fa",
  accent: "#f3f0ff",
  note: "#f8f9fa",
  neutral: "#f8f9fa",
};

export type Surface = {
  backgroundColor: string;
  strokeColor: string;
  textColor: string;
};

export const SURFACE_NAMES = ["base", "subtle", "strong", "header", "code"] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

// Backgrounds for structure (table header, zebra rows, code cards, panels):
// grays only, so they never compete with the role colors of the nodes.
export const SURFACES: Record<SurfaceName, Surface> = {
  base: { backgroundColor: "#ffffff", strokeColor: "#dee2e6", textColor: "#1e1e1e" },
  subtle: { backgroundColor: "#f8f9fa", strokeColor: "#e9ecef", textColor: "#1e1e1e" },
  strong: { backgroundColor: "#dee2e6", strokeColor: "#adb5bd", textColor: "#1e1e1e" },
  header: { backgroundColor: "#e9ecef", strokeColor: "#ced4da", textColor: "#1e1e1e" },
  code: { backgroundColor: "#f1f3f5", strokeColor: "#ced4da", textColor: "#1e1e1e" },
};

// Secondary text (captions, sources, group titles).
export const MUTED_TEXT_COLOR = STYLE_ROLES.note.strokeColor;

export const ROLE_SHAPES: Record<string, string> = {
  decision: "diamond",
  terminal: "ellipse",
};

export const SIZE_LADDER = {
  hero: { width: 300, height: 150 },
  primary: { width: 180, height: 90 },
  secondary: { width: 120, height: 60 },
  small: { width: 60, height: 40 },
} as const;

export const PALETTE_STROKES = [
  ...new Set(Object.values(STYLE_ROLES).map((role) => role.strokeColor)),
];

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

export const isRoleName = (name: unknown): name is string =>
  typeof name === "string" && hasOwn(STYLE_ROLES, name);

export const isRoleTone = (tone: unknown): tone is RoleTone =>
  typeof tone === "string" && (ROLE_TONES as readonly string[]).includes(tone);

export const isSurfaceName = (name: unknown): name is SurfaceName =>
  typeof name === "string" && hasOwn(SURFACES, name);

export const resolveRole = (
  name: string | undefined,
  tone: RoleTone = "solid",
): StyleRole | undefined => {
  if (!isRoleName(name)) {
    return undefined;
  }
  const role = STYLE_ROLES[name];
  return tone === "subtle"
    ? { ...role, backgroundColor: SUBTLE_FILLS[name] ?? SURFACES.subtle.backgroundColor }
    : role;
};

export const resolveSurface = (name: string | undefined): Surface | undefined =>
  isSurfaceName(name) ? SURFACES[name] : undefined;

type Styleable = {
  type?: unknown;
  role?: string;
  tone?: string;
  surface?: string;
  label?: string;
  backgroundColor?: string;
  strokeColor?: string;
  labelColor?: string;
};

const withLabelColor = <T extends { label?: string; labelColor?: string }>(
  attrs: T,
  color: string,
): { labelColor?: string } =>
  typeof attrs.label === "string" ? { labelColor: attrs.labelColor ?? color } : {};

// Explicit colors always win over the role/surface defaults.
export const applyRole = <T extends Styleable>(
  attrs: T,
): Omit<T, "role" | "tone" | "surface"> & Partial<StyleRole> => {
  const { role: roleName, tone, surface: surfaceName, ...rest } = attrs;
  if (tone !== undefined && !isRoleTone(tone)) {
    throw new Error(`unknown tone "${tone}"; valid tones: ${ROLE_TONES.join(", ")}`);
  }
  if (roleName && surfaceName) {
    throw new Error(
      `role and surface are mutually exclusive (got role "${roleName}" and surface "${surfaceName}")`,
    );
  }
  if (surfaceName) {
    const surface = resolveSurface(surfaceName);
    if (!surface) {
      throw new Error(
        `unknown surface "${surfaceName}"; valid surfaces: ${SURFACE_NAMES.join(", ")}`,
      );
    }
    // On a standalone text the stroke is the glyph color, so it takes the
    // surface's text color rather than its (deliberately faint) border.
    if (attrs.type === "text") {
      return { ...rest, strokeColor: rest.strokeColor ?? surface.textColor };
    }
    return {
      ...rest,
      backgroundColor: rest.backgroundColor ?? surface.backgroundColor,
      strokeColor: rest.strokeColor ?? surface.strokeColor,
      ...withLabelColor(rest, surface.textColor),
    };
  }
  const role = resolveRole(roleName, tone ?? "solid");
  if (!role) {
    if (roleName) {
      throw new Error(
        `unknown role "${roleName}"; valid roles: ${ROLE_NAMES.join(", ")}`,
      );
    }
    return rest;
  }
  return {
    ...rest,
    backgroundColor: rest.backgroundColor ?? role.backgroundColor,
    strokeColor: rest.strokeColor ?? role.strokeColor,
    ...withLabelColor(rest, role.labelColor),
  };
};
