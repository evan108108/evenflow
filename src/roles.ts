// Role tiers, reserved slugs, and invite constants for the org layer
// (phase 16). Single source of truth — routes, authz, and the backfill
// script (scripts/backfill-orgs.mjs mirrors RESERVED_ORG_SLUGS) all key off
// these names.

/** Org-scope roles, strongest first. */
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Board-scope roles, strongest first. */
export const BOARD_ROLES = ["admin", "contributor", "viewer"] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

/**
 * One comparable ladder across both scopes: owner > admin > contributor >
 * viewer. Org `member` sits at contributor strength — plain org membership
 * lets you work on the org's boards but not administer them.
 */
export const ROLE_RANK: Record<string, number> = {
  owner: 4,
  admin: 3,
  contributor: 2,
  member: 2,
  viewer: 1,
};

export const roleAtLeast = (role: string | null, min: string): boolean =>
  role !== null && (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[min] ?? Number.POSITIVE_INFINITY);

/** Board visibility states. Public boards read anonymously; writes always require membership. */
export const VISIBILITIES = ["private", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/**
 * Slugs that can never name an org: they collide with top-level routes of
 * the /@{handle} namespace or adjacent infrastructure. Checked at org
 * creation AND personal-org auto-slugging (which suffixes past them).
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  "boards",
  "profile",
  "settings",
  "i",
  "o",
  "api",
  "auth",
  "mcp",
  "new",
  "admin",
  "evenflow",
  "sona",
  "sonata",
  "enginable",
  "4a",
  "webhook",
  "healthz",
  ".well-known",
  "assets",
]);

export const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ORG_SLUG_MAX = 64;

/** Invite codes look like inv-a1b2c3d4 — prefix + 8 random base36 chars. */
export const INVITE_CODE_PREFIX = "inv-";
export const INVITE_CODE_RANDOM_LEN = 8;
export const INVITE_DEFAULT_EXPIRES_HOURS = 168; // 7 days
export const INVITE_MAX_EXPIRES_HOURS = 24 * 90;
/** Per-admin, per-target creation ceiling over a trailing 24h window. */
export const INVITE_RATE_LIMIT_PER_DAY = 50;

/** Lowercase a display string into an org slug (no uniqueness handling). */
export const slugifyHandle = (input: string): string =>
  input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORG_SLUG_MAX)
    .replace(/-+$/g, "");

/**
 * First slug that is neither reserved nor taken: the base itself, else
 * digit-suffixed (evan → evan2 → evan3), trimming to stay within
 * ORG_SLUG_MAX. Empty bases fall back to "user".
 */
export const uniqueOrgSlug = (base: string, taken: ReadonlySet<string>): string => {
  const start = base === "" ? "user" : base;
  if (!RESERVED_ORG_SLUGS.has(start) && !taken.has(start)) return start;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = start.slice(0, ORG_SLUG_MAX - suffix.length) + suffix;
    if (!RESERVED_ORG_SLUGS.has(candidate) && !taken.has(candidate)) return candidate;
  }
};
