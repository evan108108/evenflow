// Client-side JWT payload peek — display + own-comment checks only. The
// server verifies signatures; the browser just reads its own claims to know
// which pubkey stand-in it is (same provider:oauth_id derivation as
// src/authz.ts callerPubkey on the Worker).

interface JwtClaims {
  readonly provider: string;
  readonly oauth_id: string;
  readonly login: string;
}

export const decodeJwtClaims = (jwt: string): JwtClaims | null => {
  const payload = jwt.split(".")[1];
  if (payload === undefined) return null;
  try {
    const b64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(b64)) as Record<string, unknown>;
    if (
      typeof parsed["provider"] !== "string" ||
      typeof parsed["oauth_id"] !== "string" ||
      typeof parsed["login"] !== "string"
    ) {
      return null;
    }
    return {
      provider: parsed["provider"],
      oauth_id: parsed["oauth_id"],
      login: parsed["login"],
    };
  } catch {
    return null;
  }
};

export const pubkeyOfJwt = (jwt: string): string | null => {
  const claims = decodeJwtClaims(jwt);
  return claims === null ? null : `${claims.provider}:${claims.oauth_id}`;
};

/** Compact display form for pubkey stand-ins: "github:1234567…" */
export const shortPubkey = (pubkey: string): string =>
  pubkey.length <= 14 ? pubkey : `${pubkey.slice(0, 13)}…`;
