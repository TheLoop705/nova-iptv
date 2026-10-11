/**
 * Field-level changes to a settings document. Saving ops instead of the whole document lets two
 * devices edit different favourites, progress entries or playlists without overwriting each other.
 * The server applies the same ops (server/index.mjs `applyOps`).
 */
import { createCheckpoint } from './cooperative';
export interface DocOp {
  /** a top-level field, or one entry of a top-level object field */
  path: [string] | [string, string];
  value?: unknown;
  delete?: true;
}

export type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** Keys that would reach an object's prototype instead of a data field (the server rejects them too). */
const safe = (k: string) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
const keys = (...objs: Doc[]) => new Set(objs.flatMap((o) => Object.keys(o)).filter(safe));

/** The ops that turn `from` into `to`: per entry for object fields, whole value otherwise. */
export function diffDoc(from: Doc, to: Doc): DocOp[] {
  const ops: DocOp[] = [];
  for (const k of keys(from, to)) {
    const a = from[k];
    const b = to[k];
    if (a === b) continue;
    if (b === undefined) ops.push({ path: [k], delete: true });
    else if (isObject(a) && isObject(b)) {
      for (const k2 of keys(a, b)) {
        if (same(a[k2], b[k2])) continue;
        ops.push(b[k2] === undefined ? { path: [k, k2], delete: true } : { path: [k, k2], value: b[k2] });
      }
    } else if (!same(a, b)) ops.push({ path: [k], value: b });
  }
  return ops;
}

/** Large watch-progress libraries are compared in slices while the remote stays responsive. */
export async function diffDocAsync(from: Doc, to: Doc, signal?: AbortSignal): Promise<DocOp[]> {
  const ops: DocOp[] = [];
  const checkpoint = createCheckpoint(signal, 4);
  let compared = 0;
  for (const k of keys(from, to)) {
    const a = from[k];
    const b = to[k];
    if (a === b) continue;
    if (b === undefined) ops.push({ path: [k], delete: true });
    else if (isObject(a) && isObject(b)) {
      for (const k2 of keys(a, b)) {
        if (!same(a[k2], b[k2])) ops.push(b[k2] === undefined ? { path: [k, k2], delete: true } : { path: [k, k2], value: b[k2] });
        if ((++compared & 63) === 0) {
          const pause = checkpoint();
          if (pause) await pause;
        }
      }
    } else if (!same(a, b)) ops.push({ path: [k], value: b });
    const pause = checkpoint();
    if (pause) await pause;
  }
  return ops;
}

/** Returns a copy of `doc` with `ops` applied; untouched fields keep their identity. */
export function applyOps<T extends Doc>(doc: T, ops: DocOp[]): T {
  const out: Doc = { ...doc };
  const copied = new Set<string>();
  for (const { path, value, delete: remove } of ops) {
    if (!path.every(safe)) continue;
    if (path.length === 1) {
      if (remove) delete out[path[0]];
      else out[path[0]] = value;
      copied.delete(path[0]);
      continue;
    }
    const [k, k2] = path;
    if (!copied.has(k)) {
      out[k] = isObject(out[k]) ? { ...(out[k] as Doc) } : {};
      copied.add(k);
    }
    const inner = out[k] as Doc;
    if (remove) delete inner[k2];
    else inner[k2] = value;
    out[k] = inner;
  }
  return out as T;
}
