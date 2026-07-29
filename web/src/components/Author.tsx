// <Author pubkey={x} /> — the one way a pubkey becomes a human name.
// Resolution rides the shared profileStore (batched, deduped, 60s TTL);
// until the profile lands it shows the best local fallback: the signed-in
// user's login prefix for their own pubkey, the 8-char prefix for anyone
// else. The full pubkey survives in the title attribute — never inline.

import { createMemo, createRenderEffect } from "solid-js";
import { decodeJwtClaims, pubkeyOfJwt } from "../lib/jwt";
import { authorLabel, profileFor, requestProfile } from "../lib/profileStore";

const selfIdentity = (): { pubkey: string; login: string } | null => {
  let jwt: string | null = null;
  try {
    jwt = window.localStorage.getItem("evenflow.jwt");
  } catch {
    return null; // no storage in this environment (tests) — fall back to prefix
  }
  if (jwt === null) return null;
  const claims = decodeJwtClaims(jwt);
  const pubkey = pubkeyOfJwt(jwt);
  if (claims === null || pubkey === null) return null;
  return { pubkey, login: claims.login };
};

export const Author = (props: { pubkey: string; class?: string }) => {
  const self = selfIdentity();
  createRenderEffect(() => requestProfile(props.pubkey));
  const label = createMemo(() => authorLabel(profileFor(props.pubkey), props.pubkey, self));
  return (
    <span class={props.class ?? "author"} title={props.pubkey}>
      {label()}
    </span>
  );
};
