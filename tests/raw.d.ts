// Vite/vitest resolve an import suffixed with `?raw` to the file's contents as
// a string. Used by dbMock-dispatch.test.ts to read dbMock's own source.
// See EFB-35.
//
// CORRECTED (EFB-68): this used to say the declaration was needed because
// "there is no @types/node in this program". There is — vitest pulls it in
// transitively, so `node:fs` would in fact typecheck here.
//
// `?raw` is still the right tool, for a better reason than the one originally
// given: it is a BUILD-TIME resolution that vitest performs, so it works
// identically whatever the type surface happens to be, and it does not put a
// node built-in in a file that mostly runs against worker code. Reach for it
// rather than node:fs on that basis, not because the alternative fails to
// compile.
declare module "*?raw" {
  const content: string;
  export default content;
}
