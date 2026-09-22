import type {ExcalidrawElement} from "../types";

export type IgnoredField = {
  id: string;
  field: string;
  reason: string;
  hint?: string;
};

export type Collateral = { id: string; reason: string };

export type Skipped = { id: string; reason: string; actual?: Record<string, unknown> };

// What one write did besides the element changes themselves. It becomes the
// shared response envelope, so every write tool reports the same fields.
export class WriteReport {
  readonly created = new Set<string>();
  readonly revived = new Map<string, number>();
  readonly deleted = new Set<string>();
  readonly labels: Record<string, string> = {};
  readonly ignoredFields: IgnoredField[] = [];
  readonly missing: string[] = [];
  readonly skipped: Skipped[] = [];
  readonly alreadyApplied: string[] = [];
  readonly relaidOut = new Set<string>();
  readonly rerouted = new Set<string>();
  readonly collateral: Collateral[] = [];
  readonly warnings: string[] = [];
  readonly fit: Array<{ id: string; overflowBy?: number; grewTo?: { width: number; height: number }; pushed?: number }> = [];
  readonly moved = new Set<string>();
  // Ids this write deliberately (re)creates: at persist time they must beat
  // any stored copy of the same id, tombstones included.
  readonly forceWin = new Set<string>();
  readonly snapped = new Set<string>();

  ignore(id: string, field: string, reason: string, hint?: string): void {
    this.ignoredFields.push({ id, field, reason, ...(hint ? { hint } : {}) });
  }
}

// A staged view over the bot's element map: every write plans its changes
// here first, so a dry run, the lint diff and the commit all see one
// consistent result and nothing touches the live map until commit.
export class SceneTxn {
  private readonly base: ReadonlyMap<string, ExcalidrawElement>;
  private readonly staged = new Map<string, ExcalidrawElement>();
  readonly report = new WriteReport();

  constructor(base: ReadonlyMap<string, ExcalidrawElement> | readonly ExcalidrawElement[]) {
    this.base = Array.isArray(base)
      ? new Map((base as readonly ExcalidrawElement[]).map((element) => [element.id, element]))
      : (base as ReadonlyMap<string, ExcalidrawElement>);
  }

  get(id: string): ExcalidrawElement | undefined {
    return this.staged.get(id) ?? this.base.get(id);
  }

  live(id: string): ExcalidrawElement | undefined {
    const element = this.get(id);
    return element && !element.isDeleted ? element : undefined;
  }

  original(id: string): ExcalidrawElement | undefined {
    return this.base.get(id);
  }

  put(element: ExcalidrawElement): void {
    this.staged.set(element.id, element);
  }

  all(): ExcalidrawElement[] {
    const result: ExcalidrawElement[] = [];
    for (const [id, element] of this.base) {
      result.push(this.staged.get(id) ?? element);
    }
    for (const [id, element] of this.staged) {
      if (!this.base.has(id)) {
        result.push(element);
      }
    }
    return result;
  }

  liveElements(): ExcalidrawElement[] {
    return this.all().filter((element) => !element.isDeleted);
  }

  baseLiveElements(): ExcalidrawElement[] {
    return [...this.base.values()].filter((element) => !element.isDeleted);
  }

  changed(): ExcalidrawElement[] {
    return [...this.staged.values()];
  }

  hasChanges(): boolean {
    return this.staged.size > 0;
  }

  isStaged(id: string): boolean {
    return this.staged.has(id);
  }
}
