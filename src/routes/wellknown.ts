// /.well-known/oauth-protected-resource — RFC 9728 Protected Resource
// Metadata. MCP clients (Claude, Cursor, …) fetch this to discover that 4a's
// OAuth AS at api.4a4.ai mints the JWTs this server accepts, then run the
// OAuth flow there automatically.

import { Hono } from "hono";

export const makeWellKnownRouter = () => {
  const wellKnown = new Hono();
  wellKnown.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: "https://evenflow.work",
      authorization_servers: ["https://api.4a4.ai"],
      scopes_supported: ["publish"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://evenflow.work",
    }),
  );
  return wellKnown;
};
