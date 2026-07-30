// `{{ path.to.value }}` substitution for add_comment templates.
//
// Deliberately DUMB — no expressions, no conditionals, no loops. A rule
// author is writing a comment body, not a program, and every construct this
// doesn't have is one that can't misfire against an attacker-shaped webhook
// payload. Same shape as the sonata webhook route promptTemplate design.
//
// Rendering rules:
//   * scalars (string/number/boolean) render as text
//   * null/undefined → the path is UNKNOWN (see below)
//   * objects/arrays render as a fenced JSON block
//
// An unknown path renders as the literal `{{ path }}` it came from and is
// reported in `unknownPaths`. Silently emptying it would produce a comment
// that reads fine and says the wrong thing — the exact failure mode the
// audit log exists to prevent. The test panel surfaces these as warnings
// before a rule ever goes live.

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.[\]]+)\s*\}\}/g;

/** Longest template we will render; guards a runaway comment body. */
export const TEMPLATE_MAX_LENGTH = 4000;

/** `a.b[0].c` → ["a","b","0","c"]. */
const splitPath = (path: string): string[] =>
  path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((seg) => seg !== "");

const lookup = (root: unknown, path: string): unknown => {
  let current: unknown = root;
  for (const segment of splitPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const renderValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
};

export interface RenderResult {
  readonly text: string;
  /** Paths that resolved to nothing; left verbatim in `text`. */
  readonly unknownPaths: ReadonlyArray<string>;
}

/**
 * Render a template against a context object. `context` is typically
 * `{ pull_request, check_run, review, repository, issue, board, … }` —
 * see buildTemplateContext in engine.ts for exactly what a rule may reach.
 */
export const renderTemplate = (template: string, context: unknown): RenderResult => {
  const unknown: string[] = [];
  const text = template.slice(0, TEMPLATE_MAX_LENGTH).replace(PLACEHOLDER_RE, (whole, path: string) => {
    const value = lookup(context, path);
    if (value === undefined || value === null) {
      if (!unknown.includes(path)) unknown.push(path);
      return whole;
    }
    return renderValue(value);
  });
  return { text, unknownPaths: unknown };
};

/** Every `{{ path }}` a template references — powers the editor's hints. */
export const templatePaths = (template: string): ReadonlyArray<string> => {
  const paths: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const p = m[1];
    if (p !== undefined && !paths.includes(p)) paths.push(p);
  }
  return paths;
};
