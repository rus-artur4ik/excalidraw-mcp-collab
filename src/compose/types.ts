import type {CreateAttrs} from "../elements";

export type ComposeRoute = "direct" | "straight" | "orthogonal";

// Key remapping instead of Omit: Omit over CreateAttrs' index signature would
// drop every known field.
type WithoutRoute<T> = { [K in keyof T as K extends "route" ? never : K]: T[K] };

// `route` is widened because "straight" is newer than the RouteMode that
// CreateAttrs was typed against; otherwise this is `CreateAttrs & { id }`.
export type PlannedItem = WithoutRoute<CreateAttrs> & {
  id: string;
  route?: ComposeRoute;
};

export type PlanBounds = { x: number; y: number; width: number; height: number };

export type ComposePlan = {
  // Full desired state of the composite, bottom→top in z-order.
  items: PlannedItem[];
  // Live elements of the composite that are no longer wanted (incl. their labels).
  removeIds: string[];
  bounds: PlanBounds;
  // Bounds of the composite before this call, when it already existed.
  previousBounds?: PlanBounds;
  // Patches for elements outside the composite (e.g. the badge's anchor).
  extraPatches?: Array<{ id: string; patch: Record<string, unknown> }>;
  // Non-fatal notes for the caller (e.g. a callout that found no free spot).
  warnings?: string[];
};
