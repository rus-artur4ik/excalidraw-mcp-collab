import type {ExcalidrawElement} from "../../types";
import {createItems, type CreateItem} from "../create";
import {SceneTxn} from "../txn";

// A tiny in-memory board: every call plans in a SceneTxn and commits the
// staged elements into the map, like CollabBot does minus the I/O.
export class Board {
  readonly elements = new Map<string, ExcalidrawElement>();

  txn(): SceneTxn {
    return new SceneTxn(this.elements);
  }

  commit(txn: SceneTxn): SceneTxn {
    for (const element of txn.changed()) {
      this.elements.set(element.id, element);
    }
    return txn;
  }

  run(fn: (txn: SceneTxn) => void): SceneTxn {
    const txn = this.txn();
    fn(txn);
    return this.commit(txn);
  }

  create(items: CreateItem[]): SceneTxn {
    return this.run((txn) => {
      createItems(txn, items);
    });
  }

  get(id: string): ExcalidrawElement {
    const element = this.elements.get(id);
    if (!element) {
      throw new Error(`no element ${id}`);
    }
    return element;
  }

  live(): ExcalidrawElement[] {
    return [...this.elements.values()].filter((element) => !element.isDeleted);
  }
}
