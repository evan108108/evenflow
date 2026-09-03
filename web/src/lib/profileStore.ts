// profileStore — shared reactive pubkey → profile resolution.
//
// Every <Author> on screen calls requestProfile(pubkey); requests within
// one tick coalesce into a single bulk GET /api/v0/profile?pubkeys=…, and
// resolved rows land in a solid store so every chip re-renders reactively.
// Dedupe is two-layered: an entry fresher than AUTHOR_INMEM_TTL_MS is never
// re-requested, and a pubkey already pending/in-flight is never enqueued
// twice — which also means responses can't race (a pubkey has at most one
// outstanding fetch, so there is no stale response to cancel; anything
// already answered is skipped at enqueue time).

import { Effect } from "effect";
import { url } from "@routes-manifest";
import { createStore, reconcile } from "solid-js/store";
import { ApiClient, appRuntime } from "../effects";

export const AUTHOR_INMEM_TTL_MS = 60_000;
const BATCH_DELAY_MS = 10;
const BULK_CHUNK = 100;

export interface ProfileData {
  readonly pubkey: string;
  readonly name: string | null;
  readonly display_name: string | null;
  readonly picture: string | null;
  readonly about: string | null;
  readonly event_id: string | null;
  readonly updated_at_ms: number | null;
  /**
   * Email local-part seeded server-side at session bootstrap (migration
   * 0032). Read by `authorLabel` as the last friendly fallback before the
   * raw pubkey slice — see the fallback chain there.
   */
  readonly login_prefix: string | null;
}

interface ProfileEntry {
  readonly profile: ProfileData;
  readonly fetched_at_ms: number;
}

type Fetcher = (pubkeys: string[]) => Promise<ProfileData[]>;

const defaultFetcher: Fetcher = (pubkeys) =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      const res = yield* client.get<{ profiles: ProfileData[] }>(
        `${url("profile.list")}?pubkeys=${encodeURIComponent(pubkeys.join(","))}`,
      );
      return res.profiles;
    }),
  );

const [entries, setEntries] = createStore<Record<string, ProfileEntry>>({});

let fetcher: Fetcher = defaultFetcher;
const pending = new Set<string>();
const inflight = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const flush = () => {
  flushTimer = null;
  const batch = [...pending];
  pending.clear();
  for (const pubkey of batch) inflight.add(pubkey);
  for (let at = 0; at < batch.length; at += BULK_CHUNK) {
    const chunk = batch.slice(at, at + BULK_CHUNK);
    fetcher(chunk)
      .then((profiles) => {
        const now = Date.now();
        for (const profile of profiles) {
          setEntries(profile.pubkey, { profile, fetched_at_ms: now });
        }
      })
      .catch((err: unknown) => {
        console.warn(`[profileStore] bulk resolve failed for ${chunk.length} pubkey(s): ${String(err)}`);
      })
      .finally(() => {
        for (const pubkey of chunk) inflight.delete(pubkey);
      });
  }
};

/** Ask for a pubkey's profile; coalesced, deduped, TTL-guarded. Reactive
 *  consumers read profileFor() and re-render when the store fills in. */
export const requestProfile = (pubkey: string): void => {
  if (pubkey === "") return;
  if (pending.has(pubkey) || inflight.has(pubkey)) return;
  const entry = entries[pubkey];
  if (entry !== undefined && Date.now() - entry.fetched_at_ms < AUTHOR_INMEM_TTL_MS) return;
  pending.add(pubkey);
  flushTimer ??= setTimeout(flush, BATCH_DELAY_MS);
};

/** Reactive read — undefined until the profile lands. */
export const profileFor = (pubkey: string): ProfileData | undefined =>
  entries[pubkey]?.profile;

/** Seed/replace one entry (used by the Profile page after a PUT). */
export const primeProfile = (profile: ProfileData): void => {
  setEntries(profile.pubkey, { profile, fetched_at_ms: Date.now() });
};

/** Display name resolution shared by every author surface:
 *  display_name → name → login_prefix (server-seeded, migration 0032)
 *  → own login-prefix (self only, in case bootstrap hasn't run yet)
 *  → 8-char pubkey slice.
 *
 *  login_prefix is why an OAuth-signed member who never opened /profile
 *  still shows up as "evan.frohlich" instead of "google:1…" for everyone
 *  else on their boards — bootstrapSession seeds it on every app load,
 *  and the profile-store bulk fetch carries it back to every chip. */
export const authorLabel = (
  profile: ProfileData | undefined,
  pubkey: string,
  self: { pubkey: string; login: string } | null,
): string => {
  if (profile?.display_name != null && profile.display_name !== "") return profile.display_name;
  if (profile?.name != null && profile.name !== "") return profile.name;
  if (profile?.login_prefix != null && profile.login_prefix !== "") return profile.login_prefix;
  if (self !== null && self.pubkey === pubkey) return self.login.split("@")[0] ?? self.login;
  return `${pubkey.slice(0, 8)}…`;
};

/** Test seam: swap the transport and wipe state between cases. */
export const __setProfileFetcher = (next: Fetcher | null): void => {
  fetcher = next ?? defaultFetcher;
};
export const __resetProfileStore = (): void => {
  pending.clear();
  inflight.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  setEntries(reconcile({}));
};
