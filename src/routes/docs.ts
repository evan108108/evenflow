// /docs/llms.txt — the whole documentation set as one text/plain document.
//
// WHY A WORKER ROUTE RATHER THAN AN SPA PAGE
//
// The docs have two audiences that want opposite shapes. A human wants seven
// navigable pages; an agent wants ONE fetch. Serving the agent version from
// the SPA would mean an agent has to execute JavaScript and crawl seven
// client-rendered routes to learn an API — which is exactly the "assume a
// human clicks through" failure this documentation exists to avoid.
//
// So this is a real HTTP route: `curl https://evenflow.work/docs/llms.txt`
// returns everything, no JS, one request, in the Markdown a language model
// reads best. The SPA pages and this document are generated from the SAME
// content in src/docs/sections.ts, so they cannot drift — the failure mode of
// a hand-maintained machine-readable dump is that it silently goes stale and
// the only reader who would notice is a robot.
//
// The API reference inside it is generated from the route manifest, so a URL
// documented here is a URL the server serves.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import type { AppHonoEnv } from "../http";
import { apiReferenceMarkdown } from "../docs/api-reference";
import { sectionsToMarkdown } from "../docs/model";
import { SECTIONS } from "../docs/sections";

// Rendered once per isolate rather than per request: the content is static for
// the life of the deploy, and this document is large enough that regenerating
// it on every crawl would be a gift to anyone pointing a scraper at it.
let cached: string | null = null;

const document = (): string => {
  if (cached === null) cached = sectionsToMarkdown(SECTIONS, apiReferenceMarkdown);
  return cached;
};

export const makeDocsRouter = () => {
  const docs = new Hono<AppHonoEnv>();
  docs.get(path("docs.llms"), (c) =>
    c.text(document(), 200, {
      // text/plain, not markdown: every client renders it, and the audience
      // is reading it as text anyway.
      "Content-Type": "text/plain; charset=utf-8",
      // Public and stable for the life of a deploy.
      "Cache-Control": "public, max-age=3600",
    }),
  );
  return docs;
};
