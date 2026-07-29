// <Author> resolution: fallback label first, display_name once the shared
// profileStore's batched fetch lands, and one bulk call for many chips.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { Author } from "./Author";
import {
  __resetProfileStore,
  __setProfileFetcher,
  type ProfileData,
} from "../lib/profileStore";

const profile = (pubkey: string, display_name: string | null): ProfileData => ({
  pubkey,
  name: null,
  display_name,
  picture: null,
  about: null,
  event_id: display_name === null ? null : "evt",
  updated_at_ms: display_name === null ? null : 1,
});

const flushBatch = () => new Promise((r) => setTimeout(r, 30)); // > BATCH_DELAY_MS

let container: HTMLDivElement;
let dispose: (() => void) | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  window.localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  container.remove();
  __setProfileFetcher(null);
  __resetProfileStore();
});

describe("Author", () => {
  it("renders the 8-char prefix while loading, then swaps to display_name", async () => {
    const requested: string[][] = [];
    __setProfileFetcher((pubkeys) => {
      requested.push(pubkeys);
      return Promise.resolve(pubkeys.map((p) => profile(p, "Evan")));
    });

    dispose = render(() => <Author pubkey="google:104509077344032735108" />, container);
    // Fallback first — never the raw full pubkey.
    expect(container.textContent).toBe("google:1…");

    await flushBatch();
    expect(container.textContent).toBe("Evan");
    expect(requested).toEqual([["google:104509077344032735108"]]);
    // Full pubkey survives for hover/debugging.
    expect(container.querySelector("span")?.getAttribute("title")).toBe(
      "google:104509077344032735108",
    );
  });

  it("coalesces many chips into one bulk fetch and dedupes repeats", async () => {
    const requested: string[][] = [];
    __setProfileFetcher((pubkeys) => {
      requested.push(pubkeys);
      return Promise.resolve(pubkeys.map((p) => profile(p, null)));
    });

    dispose = render(
      () => (
        <>
          <Author pubkey="a:1" />
          <Author pubkey="b:2" />
          <Author pubkey="a:1" />
        </>
      ),
      container,
    );
    await flushBatch();
    expect(requested).toEqual([["a:1", "b:2"]]);
  });

  it("labels the signed-in user's own pubkey with the login prefix", () => {
    // Claims: {provider:"google", oauth_id:"42", login:"evan108108@gmail.com"}
    const payload = btoa(
      JSON.stringify({ provider: "google", oauth_id: "42", login: "evan108108@gmail.com" }),
    );
    window.localStorage.setItem("evenflow.jwt", `x.${payload}.y`);
    __setProfileFetcher(() => Promise.resolve([]));

    dispose = render(() => <Author pubkey="google:42" />, container);
    expect(container.textContent).toBe("evan108108");
  });
});
