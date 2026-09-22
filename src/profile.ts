import {db} from "./firebase";
import {invalidArgs} from "./engine/errors";
import {logError, logInfo} from "./logger";
import {STROKE_STYLES} from "./verify/model";
import {ROLE_NAMES} from "./verify/styles";

// The style contract of a board or a whole series: what a role means, which
// font sizes exist, how wide a gutter is. It used to live in an external
// DRAW_GUIDE.md that drifted across 13 boards; here it is one document the
// planners read defaults from and the lint checks against.
//
// Its own collection, `boardProfiles/{scopeId}`: folder and board documents
// are validated field-by-field by firestore.rules for browser writes, so an
// extra key on them would break every later rename from the app. Only the
// server (Admin SDK) touches this collection.

export type TypeScale = {
  title?: number;
  frameTitle?: number;
  colHeader?: number;
  body?: number;
  caption?: number;
  code?: number;
};

export type ProfileSpacing = {
  unit?: number;
  cellPadding?: number;
  frameInset?: number;
  blockGap?: number;
};

export type ProfileRole = { tag?: string; meaning?: string };

export type BoardProfile = {
  // Palette role → what it stands for on this board, e.g. accent: {tag:"[YOU]"}.
  roles?: Record<string, ProfileRole>;
  // Stroke style → what it stands for, e.g. dashed: "[planned]".
  strokeStyles?: Record<string, string>;
  typeScale?: TypeScale;
  spacing?: ProfileSpacing;
  // Regex sources that must never be broken across lines.
  nowrap?: string[];
  updatedAt?: number;
};

export type ResolvedProfile = {
  roles: Record<string, ProfileRole>;
  strokeStyles: Record<string, string>;
  typeScale: Required<TypeScale>;
  spacing: Required<ProfileSpacing>;
  nowrap: string[];
  updatedAt?: number;
};

export type ProfileScope = { boardId?: string; folderId?: string };

export const TYPE_SCALE_ROLES = [
  "title",
  "frameTitle",
  "colHeader",
  "body",
  "caption",
  "code",
] as const;

export const SPACING_KEYS = ["unit", "cellPadding", "frameInset", "blockGap"] as const;

// Matches the client's own font-size range; anything outside is already an
// out_of_range lint finding, so the profile must not be able to mandate it.
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 72;

// A text may sit 1px off a scale step (the client rounds label sizes when it
// refits a container), so `style_font_size_off_profile` tolerates that much.
export const FONT_SIZE_TOLERANCE = 1;

export const DEFAULT_PROFILE: Required<Pick<BoardProfile, "typeScale" | "spacing">> &
  BoardProfile = {
  typeScale: { title: 36, frameTitle: 28, colHeader: 20, body: 16, caption: 14, code: 14 },
  spacing: { unit: 8, cellPadding: 12, frameInset: 40, blockGap: 32 },
};

const PROFILE_KEYS = new Set([
  "roles",
  "strokeStyles",
  "typeScale",
  "spacing",
  "nowrap",
  "updatedAt",
]);

const COLLECTION = "boardProfiles";

// ---- validation -------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const assertFontSize = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidArgs(`${field} must be a number`, { field });
  }
  if (value < MIN_FONT_SIZE || value > MAX_FONT_SIZE) {
    throw invalidArgs(
      `${field} must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE} (got ${value})`,
      { field, hint: `Use a font size in ${MIN_FONT_SIZE}..${MAX_FONT_SIZE}.` },
    );
  }
  return value;
};

const assertSpacing = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidArgs(`${field} must be a number`, { field });
  }
  if (value < 0) {
    throw invalidArgs(`${field} must be 0 or more (got ${value})`, { field });
  }
  return value;
};

const assertString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw invalidArgs(`${field} must be a string`, { field });
  }
  return value;
};

const validateTypeScale = (raw: unknown): TypeScale => {
  if (!isPlainObject(raw)) {
    throw invalidArgs("typeScale must be an object", { field: "typeScale" });
  }
  const scale: TypeScale = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    if (!(TYPE_SCALE_ROLES as readonly string[]).includes(key)) {
      throw invalidArgs(
        `unknown typeScale role "${key}"; valid roles: ${TYPE_SCALE_ROLES.join(", ")}`,
        { field: `typeScale.${key}` },
      );
    }
    scale[key as keyof TypeScale] = assertFontSize(value, `typeScale.${key}`);
  }
  return scale;
};

const validateSpacing = (raw: unknown): ProfileSpacing => {
  if (!isPlainObject(raw)) {
    throw invalidArgs("spacing must be an object", { field: "spacing" });
  }
  const spacing: ProfileSpacing = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    if (!(SPACING_KEYS as readonly string[]).includes(key)) {
      throw invalidArgs(
        `unknown spacing key "${key}"; valid keys: ${SPACING_KEYS.join(", ")}`,
        { field: `spacing.${key}` },
      );
    }
    spacing[key as keyof ProfileSpacing] = assertSpacing(value, `spacing.${key}`);
  }
  return spacing;
};

const validateRoles = (raw: unknown): Record<string, ProfileRole> => {
  if (!isPlainObject(raw)) {
    throw invalidArgs("roles must be an object", { field: "roles" });
  }
  const roles: Record<string, ProfileRole> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    if (!ROLE_NAMES.includes(name)) {
      throw invalidArgs(
        `unknown role "${name}"; valid roles: ${ROLE_NAMES.join(", ")}`,
        { field: `roles.${name}` },
      );
    }
    if (!isPlainObject(value)) {
      throw invalidArgs(`roles.${name} must be an object with tag/meaning`, {
        field: `roles.${name}`,
      });
    }
    const entry: ProfileRole = {};
    for (const [key, text] of Object.entries(value)) {
      if (text === undefined) {
        continue;
      }
      if (key !== "tag" && key !== "meaning") {
        throw invalidArgs(`roles.${name}.${key} is not a known field (tag, meaning)`, {
          field: `roles.${name}.${key}`,
        });
      }
      entry[key] = assertString(text, `roles.${name}.${key}`);
    }
    roles[name] = entry;
  }
  return roles;
};

const validateStrokeStyles = (raw: unknown): Record<string, string> => {
  if (!isPlainObject(raw)) {
    throw invalidArgs("strokeStyles must be an object", { field: "strokeStyles" });
  }
  const styles: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    if (!STROKE_STYLES.has(name)) {
      throw invalidArgs(
        `unknown strokeStyle "${name}"; valid styles: ${[...STROKE_STYLES].join(", ")}`,
        { field: `strokeStyles.${name}` },
      );
    }
    styles[name] = assertString(value, `strokeStyles.${name}`);
  }
  return styles;
};

const validateNowrap = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    throw invalidArgs("nowrap must be an array of regex sources", { field: "nowrap" });
  }
  return raw.map((entry, index) => {
    const source = assertString(entry, `nowrap[${index}]`);
    try {
      // eslint-disable-next-line no-new
      new RegExp(source, "u");
    } catch (error) {
      throw invalidArgs(
        `nowrap[${index}] is not a valid regular expression: ${(error as Error).message}`,
        { field: `nowrap[${index}]`, hint: "Escape backslashes in JSON, e.g. \"auto-\\\\w+\"." },
      );
    }
    return source;
  });
};

/** Rejects unknown keys and bad values; returns the cleaned profile. */
export const validateProfile = (raw: unknown): BoardProfile => {
  if (!isPlainObject(raw)) {
    throw invalidArgs("profile must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!PROFILE_KEYS.has(key)) {
      throw invalidArgs(
        `unknown profile field "${key}"; valid fields: ${[...PROFILE_KEYS].join(", ")}`,
        { field: key },
      );
    }
  }
  const profile: BoardProfile = {};
  if (raw.roles !== undefined) {
    profile.roles = validateRoles(raw.roles);
  }
  if (raw.strokeStyles !== undefined) {
    profile.strokeStyles = validateStrokeStyles(raw.strokeStyles);
  }
  if (raw.typeScale !== undefined) {
    profile.typeScale = validateTypeScale(raw.typeScale);
  }
  if (raw.spacing !== undefined) {
    profile.spacing = validateSpacing(raw.spacing);
  }
  if (raw.nowrap !== undefined) {
    profile.nowrap = validateNowrap(raw.nowrap);
  }
  return profile;
};

// ---- scope ------------------------------------------------------------------

/**
 * `board:<boardId>` or `folder:<folderId>`. A scope naming both is a board
 * scope whose folder is only there for the read-time fallback.
 */
export const profileScopeId = (scope: ProfileScope): string => {
  if (typeof scope?.boardId === "string" && scope.boardId.length) {
    return `board:${scope.boardId}`;
  }
  if (typeof scope?.folderId === "string" && scope.folderId.length) {
    return `folder:${scope.folderId}`;
  }
  throw invalidArgs("a profile scope needs a boardId or a folderId", {
    field: "scope",
    hint: "Pass {boardId} for one board or {folderId} for a whole series.",
  });
};

const profileDoc = (scopeId: string) => db().collection(COLLECTION).doc(scopeId);

const readAt = async (scopeId: string): Promise<BoardProfile | null> => {
  const snap = await profileDoc(scopeId).get();
  if (!snap.exists) {
    return null;
  }
  const data = snap.data();
  return isPlainObject(data) ? (data as BoardProfile) : null;
};

// ---- storage ----------------------------------------------------------------

/**
 * The profile in force for a scope: the board's own, else the profile of the
 * folder it sits in, else null. The caller passes `folderId` whenever it knows
 * which folder holds the board — without it there is no series fallback.
 */
export async function loadProfile(scope: ProfileScope): Promise<BoardProfile | null> {
  const scopeId = profileScopeId(scope);
  try {
    const own = await readAt(scopeId);
    if (own) {
      return own;
    }
    if (scopeId.startsWith("board:") && typeof scope.folderId === "string" && scope.folderId.length) {
      return await readAt(`folder:${scope.folderId}`);
    }
    return null;
  } catch (error) {
    logError("firestore.profile.load_failed", error, { scopeId });
    throw error;
  }
}

const mergeRecord = <T>(
  base: Record<string, T> | undefined,
  patch: Record<string, T> | undefined,
): Record<string, T> | undefined => {
  if (!patch) {
    return base;
  }
  return { ...(base ?? {}), ...patch };
};

/**
 * Merges `profile` into whatever is stored at the scope: a second save changes
 * only the keys it passes, down to a single font size. `nowrap` is replaced as
 * a whole — it is one ordered list, not a bag of named entries.
 */
export async function saveProfile(
  scope: ProfileScope,
  profile: BoardProfile,
): Promise<BoardProfile> {
  const scopeId = profileScopeId(scope);
  const patch = validateProfile(profile);
  const current = (await readAt(scopeId)) ?? {};
  const merged: BoardProfile = {
    ...(mergeRecord(current.roles, patch.roles) ? { roles: mergeRecord(current.roles, patch.roles)! } : {}),
    ...(mergeRecord(current.strokeStyles, patch.strokeStyles)
      ? { strokeStyles: mergeRecord(current.strokeStyles, patch.strokeStyles)! }
      : {}),
    ...(current.typeScale || patch.typeScale
      ? { typeScale: { ...(current.typeScale ?? {}), ...(patch.typeScale ?? {}) } }
      : {}),
    ...(current.spacing || patch.spacing
      ? { spacing: { ...(current.spacing ?? {}), ...(patch.spacing ?? {}) } }
      : {}),
    ...(patch.nowrap ?? current.nowrap ? { nowrap: patch.nowrap ?? current.nowrap! } : {}),
    updatedAt: Date.now(),
  };
  try {
    await profileDoc(scopeId).set(merged);
  } catch (error) {
    logError("firestore.profile.save_failed", error, { scopeId });
    throw error;
  }
  logInfo("firestore.profile.saved", { scopeId, fields: Object.keys(patch) });
  return merged;
}

// ---- reading ----------------------------------------------------------------

/** The profile with every default filled in; safe to read without checks. */
export const resolveProfile = (profile: BoardProfile | null | undefined): ResolvedProfile => ({
  roles: profile?.roles ?? {},
  strokeStyles: profile?.strokeStyles ?? {},
  typeScale: { ...DEFAULT_PROFILE.typeScale, ...(profile?.typeScale ?? {}) } as Required<TypeScale>,
  spacing: { ...DEFAULT_PROFILE.spacing, ...(profile?.spacing ?? {}) } as Required<ProfileSpacing>,
  nowrap: profile?.nowrap ?? [],
  ...(typeof profile?.updatedAt === "number" ? { updatedAt: profile.updatedAt } : {}),
});

export const fontSizeFor = (
  profile: BoardProfile | null | undefined,
  textRole: keyof TypeScale,
): number => {
  const size = profile?.typeScale?.[textRole];
  return typeof size === "number" ? size : DEFAULT_PROFILE.typeScale[textRole]!;
};

/** Distinct font sizes the profile allows, ascending. */
export const typeScaleSizes = (profile: BoardProfile | null | undefined): number[] => {
  const scale = profile?.typeScale ?? {};
  const sizes = TYPE_SCALE_ROLES.map((role) => scale[role]).filter(
    (size): size is number => typeof size === "number",
  );
  return [...new Set(sizes)].sort((a, b) => a - b);
};

/**
 * The scale step closest to `size`, or undefined when the profile pins no
 * sizes at all. Ties go to the larger step: shrinking text is the change more
 * likely to make it overflow.
 */
export const nearestScaleSize = (
  profile: BoardProfile | null | undefined,
  size: number,
): number | undefined => {
  let best: number | undefined;
  let bestDistance = Infinity;
  for (const candidate of typeScaleSizes(profile)) {
    const distance = Math.abs(candidate - size);
    if (distance < bestDistance || (distance === bestDistance && candidate > (best ?? -Infinity))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

/** True when `size` is on the scale (or within FONT_SIZE_TOLERANCE of a step). */
export const isOnTypeScale = (
  profile: BoardProfile | null | undefined,
  size: number,
): boolean => {
  const sizes = typeScaleSizes(profile);
  return !sizes.length || sizes.some((step) => Math.abs(step - size) <= FONT_SIZE_TOLERANCE);
};
