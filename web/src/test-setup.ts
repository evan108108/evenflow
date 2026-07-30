// Vitest setup — repair `window.localStorage` under jsdom.
//
// Node 22+ ships a built-in `localStorage` global (gated behind
// --localstorage-file). On Node 25 it wins over jsdom's implementation but is
// inert without a backing file, so every `getItem`/`setItem` call throws
// "s.getItem is not a function" and takes 7 of the 13 web test files down with
// it. Nothing in the app is at fault — this is purely the test environment.
//
// Install a plain in-memory Storage before any module reads it, and reset it
// between tests so persisted keys (evenflow.jwt, last-active org, the claimed
// handle) can't leak across cases.

import { beforeEach } from "vitest";

const makeStorage = (): Storage => {
  let map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void (map = new Map()),
  } as Storage;
};

const install = () => {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(window, key, {
      value: makeStorage(),
      configurable: true,
      writable: true,
    });
  }
};

install();
beforeEach(install);
