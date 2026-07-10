export type StyleRole = {
  backgroundColor: string;
  strokeColor: string;
  labelColor: string;
};

export const STYLE_ROLES: Record<string, StyleRole> = {
  process: { backgroundColor: "#a5d8ff", strokeColor: "#1971c2", labelColor: "#1e1e1e" },
  decision: { backgroundColor: "#ffec99", strokeColor: "#f08c00", labelColor: "#1e1e1e" },
  terminal: { backgroundColor: "#b2f2bb", strokeColor: "#2f9e44", labelColor: "#1e1e1e" },
  error: { backgroundColor: "#ffc9c9", strokeColor: "#e03131", labelColor: "#1e1e1e" },
  external: { backgroundColor: "#e9ecef", strokeColor: "#495057", labelColor: "#1e1e1e" },
  accent: { backgroundColor: "#d0bfff", strokeColor: "#6741d9", labelColor: "#1e1e1e" },
  note: { backgroundColor: "transparent", strokeColor: "#868e96", labelColor: "#495057" },
  neutral: { backgroundColor: "transparent", strokeColor: "#1e1e1e", labelColor: "#1e1e1e" },
};

export const ROLE_NAMES = Object.keys(STYLE_ROLES) as [string, ...string[]];

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

type Styleable = {
  role?: string;
  label?: string;
  backgroundColor?: string;
  strokeColor?: string;
  labelColor?: string;
};

export const resolveRole = (name: string | undefined): StyleRole | undefined =>
  name ? STYLE_ROLES[name] : undefined;

export const applyRole = <T extends Styleable>(
  attrs: T,
): Omit<T, "role"> & Partial<StyleRole> => {
  const { role: roleName, ...rest } = attrs;
  const role = resolveRole(roleName);
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
    ...(typeof rest.label === "string"
      ? { labelColor: rest.labelColor ?? role.labelColor }
      : {}),
  };
};
