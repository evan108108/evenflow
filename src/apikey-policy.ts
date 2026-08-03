// API key POLICY constants — the numbers, and nothing else (EFB-99).
//
// This file exists to be importable from BOTH sides. web/ states the rotation
// grace window in prose ("the current key keeps working for 24 hours"), and a
// hardcoded copy there would keep saying 24 after someone changed the server's
// value — telling a user something false about how long a compromised key
// stays live. So the client reads the same constant the auth path enforces.
//
// DEPENDENCY-FREE BY CONSTRUCTION, and that is the whole requirement rather
// than a nicety — the same rule src/routes-manifest.ts follows for the same
// reason. src/apikeys.ts cannot serve this purpose despite holding the rest of
// the key constants: it carries `import type { Claims } from "./effects"`,
// which esbuild erases but tsc still RESOLVES, so aliasing it into the web
// program drags the Workers type graph (D1Database, DurableObjectState,
// Fetcher) into a browser tsconfig that has no business knowing them. A type
// import is free at runtime and not free at typecheck.
//
// Anything added here must stay a plain value with no imports at all.

/**
 * How long a rotated key keeps working after its successor is minted.
 *
 * The point of rotation is to change a secret WITHOUT a gap: callers get a
 * window to pick up the new key while the old one still authenticates. 24h is
 * long enough to redeploy the things holding it and short enough that a
 * compromised key is not usable for long.
 *
 * A CONSTANT, deliberately not a request field. A grace window taken from the
 * caller is a foot-gun: anyone who can reach the endpoint picks a ten-year
 * window and the rotation becomes a no-op that still READS as remediation —
 * the owner believes they have re-keyed and has not. If this ever needs to
 * vary it becomes server config, not caller input.
 */
export const API_KEY_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
