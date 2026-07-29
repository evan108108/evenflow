// orgStore — session bootstrap state: who am I, which orgs am I in, which
// org was I last working in. Mirrors profileStore's shape: module-level
// signals + a test seam for the transport.
//
// bootstrap() POSTs /api/v0/session/bootstrap (idempotent server-side —
// auto-creates the personal org on first call). It forwards the claimed
// handle stashed by the sign-up CTA (?claim=<handle> flow) exactly once.

import { createSignal } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime } from "../effects";

const LAST_ACTIVE_ORG_KEY = "evenflow.lastActiveOrg";
const CLAIM_KEY = "evenflow.claimHandle";
const INVITE_CODE_KEY = "evenflow.pendingInvite";

export interface OrgSummary {
  readonly slug: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly kind: "personal" | "team";
  readonly role: string;
}

export interface BootstrapMe {
  readonly handle: string;
  readonly pubkey: string;
  readonly login: string;
  readonly orgs: ReadonlyArray<OrgSummary>;
}

export interface BootstrapResponse {
  readonly me: BootstrapMe;
  readonly last_active_org: string;
}

type BootstrapFetcher = (body: { claim?: string }) => Promise<BootstrapResponse>;

const defaultFetcher: BootstrapFetcher = (body) =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.post<BootstrapResponse>("/api/v0/session/bootstrap", body);
    }),
  );

let fetcher: BootstrapFetcher = defaultFetcher;

const [me, setMe] = createSignal<BootstrapMe | null>(null);
let inflight: Promise<BootstrapMe | null> | null = null;

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null; // jsdom without storage / privacy mode — degrade quietly
  }
};

/** Reactive read — null until bootstrap lands (or when signed out). */
export const currentMe = me;

/**
 * Run (or join) the session bootstrap. Coalesces concurrent callers onto
 * one request; resolves null on failure (signed out, network) so pages can
 * fall back rather than crash.
 */
export const bootstrap = (options?: { force?: boolean }): Promise<BootstrapMe | null> => {
  if (!options?.force) {
    const known = me();
    if (known !== null) return Promise.resolve(known);
    if (inflight !== null) return inflight;
  }
  const claim = takeClaimedHandle();
  inflight = fetcher(claim === null ? {} : { claim })
    .then((res) => {
      setMe(res.me);
      if (lastActiveOrg() === null) setLastActiveOrg(res.last_active_org);
      return res.me;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

export const clearMe = (): void => {
  setMe(null);
};

// ── last-active org (localStorage) ────────────────────────────────────────

export const lastActiveOrg = (): string | null => storage()?.getItem(LAST_ACTIVE_ORG_KEY) ?? null;

export const setLastActiveOrg = (slug: string): void => {
  storage()?.setItem(LAST_ACTIVE_ORG_KEY, slug);
};

// ── sign-up claim hint (?claim=<handle> CTA flow) ─────────────────────────

export const stashClaimedHandle = (handle: string): void => {
  storage()?.setItem(CLAIM_KEY, handle);
};

/** Read-and-clear: the claim is forwarded on exactly one bootstrap. */
export const takeClaimedHandle = (): string | null => {
  const s = storage();
  if (s === null) return null;
  const claim = s.getItem(CLAIM_KEY);
  if (claim !== null) s.removeItem(CLAIM_KEY);
  return claim;
};

// ── pending invite continuation (signed-out Accept → OAuth → back) ────────

export const stashPendingInvite = (code: string): void => {
  storage()?.setItem(INVITE_CODE_KEY, code);
};

export const takePendingInvite = (): string | null => {
  const s = storage();
  if (s === null) return null;
  const code = s.getItem(INVITE_CODE_KEY);
  if (code !== null) s.removeItem(INVITE_CODE_KEY);
  return code;
};

// ── test seams ────────────────────────────────────────────────────────────

export const __setBootstrapFetcher = (next: BootstrapFetcher | null): void => {
  fetcher = next ?? defaultFetcher;
};

export const __resetOrgStore = (): void => {
  setMe(null);
  inflight = null;
  const s = storage();
  s?.removeItem(LAST_ACTIVE_ORG_KEY);
  s?.removeItem(CLAIM_KEY);
  s?.removeItem(INVITE_CODE_KEY);
};
