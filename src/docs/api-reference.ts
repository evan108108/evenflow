/**
 * EFB-103: every endpoint the server serves, derived from the manifest.
 *
 * NOT A CURATED LIST, and that is the whole point. web/src/pages/docs/rest-spec.ts
 * documents a hand-picked SUBSET with hand-written prose, and its own header
 * records why even that much had to derive its paths from the manifest: every
 * hand-written path in its first version had gone stale, advertising URLs the
 * server had renamed or deleted. A docs page is a URL-DISPENSING SURFACE — a
 * reader copies the curl and gets a 404.
 *
 * This file takes the same lesson one level up. The reference RENDERS FROM
 * `ROUTES`, so "every endpoint appears in the documentation" is a property of
 * the build rather than a promise someone keeps. Declare route 108 and it is
 * documented the same minute, with its method, path, auth level, derived scope
 * requirement and a runnable curl — whether or not anyone wrote prose for it.
 * A curated list is correct until the next route; this cannot go stale without
 * the manifest itself being wrong.
 *
 * Hand-written prose still wins where it exists: rest-spec.ts entries enrich
 * the generated row. Depth where someone invested it, coverage everywhere else.
 */

import {
  API_BASE,
  ROUTES,
  effectivePaths,
  type RouteEntry,
} from "../routes-manifest";
import { derivedRequirement } from "../scopes";

const HOST = "https://evenflow.work";

/** Human-readable scope requirement for a route, from the same derivation the server enforces. */
export const scopeLabel = (entry: RouteEntry): string => {
  const requirement = derivedRequirement(entry);
  switch (requirement.kind) {
    case "public":
      return "none (public)";
    case "never":
      return "unreachable by API keys — JWT sessions only";
    case "scope":
      return requirement.domain === "board"
        ? `board:<slug>:${requirement.access} (or board:*:${requirement.access})`
        : `${requirement.domain}:${requirement.access}`;
  }
};

/**
 * A curl that runs.
 *
 * Path parameters are left as their `:name` placeholders deliberately rather
 * than filled with plausible-looking fakes: a reader who pastes this gets an
 * obvious "replace this" rather than a request that 404s against an id that
 * never existed. The one substitution made is the API key, because a curl
 * without an Authorization header is not a runnable example of an
 * authenticated endpoint.
 */
export const curlFor = (entry: RouteEntry): string => {
  const url = `${HOST}${effectivePaths(entry)[0]}`;
  const auth = derivedRequirement(entry).kind === "public" ? "" : ` \\\n  -H "Authorization: Bearer $EVENFLOW_KEY"`;
  const body =
    entry.method === "POST" || entry.method === "PUT" || entry.method === "PATCH"
      ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '{}'`
      : "";
  const method = entry.method === "GET" ? "" : ` -X ${entry.method}`;
  return `curl -s${method} "${url}"${auth}${body}`;
};

export interface ApiRow {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  /** The org-scoped spelling, when the router also mounts one. */
  readonly orgPath: string | null;
  readonly auth: string;
  readonly scope: string;
  readonly curl: string;
  readonly file: string;
}

/** Every declared route, in manifest order, ready to render. */
export const apiRows = (): readonly ApiRow[] =>
  ROUTES.map((entry) => {
    const paths = effectivePaths(entry);
    return {
      id: entry.id,
      method: entry.method,
      path: paths[0] ?? "",
      orgPath: entry.orgScoped ? (paths[1] ?? null) : null,
      auth: entry.auth,
      scope: scopeLabel(entry),
      curl: curlFor(entry),
      file: entry.file,
    };
  });

/** Routes grouped by owning family, which is how a reader looks for one. */
export const apiRowsByFamily = (): ReadonlyArray<{
  readonly family: string;
  readonly rows: readonly ApiRow[];
}> => {
  const byFile = new Map<string, ApiRow[]>();
  for (const row of apiRows()) {
    const family = row.file.replace(/\.ts$/, "");
    const list = byFile.get(family) ?? [];
    list.push(row);
    byFile.set(family, list);
  }
  return [...byFile]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, rows]) => ({ family, rows }));
};

/** The reference as Markdown, for the single-document form agents read. */
export const apiReferenceMarkdown = (): string =>
  [
    `Base URL: \`${HOST}${API_BASE}\`. Every path below is generated from the`,
    "server's route manifest, so it is a URL the server actually serves.",
    "",
    "Ten routers are mounted twice — bare, and again under `/org/:org_slug` —",
    "and both spellings are listed where that applies.",
    "",
    ...apiRowsByFamily().flatMap(({ family, rows }) => [
      `### ${family}`,
      "",
      "| Method | Path | Auth | Scope required |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (r) => `| ${r.method} | \`${r.path}\` | ${r.auth} | ${r.scope} |`,
      ),
      "",
      ...rows.flatMap((r) => [
        `**${r.method} ${r.path}** (\`${r.id}\`)`,
        ...(r.orgPath === null ? [] : [`Also served at \`${r.orgPath}\`.`]),
        "",
        "```bash",
        r.curl,
        "```",
        "",
      ]),
    ]),
  ].join("\n");
