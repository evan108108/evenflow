// Vite/vitest resolve an import suffixed with `?raw` to the file's contents as
// a string. Declared here because the Worker tsconfig pins `types` to
// @cloudflare/workers-types — there is no @types/node in this program, so the
// node:fs route to the same string does not typecheck. Used by
// dbMock-dispatch.test.ts to read dbMock's own source. See EFB-35.
declare module "*?raw" {
  const content: string;
  export default content;
}
