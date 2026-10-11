/**
 * Browser stand-in for `zod` (aliased in next.config.ts for client bundles only).
 *
 * Contract schemas exist in the browser only for their types: the web never
 * validates with them — the API parses every input and returns per-field
 * messages (`ApiError.fields`). Building ~70 contract modules' schemas with
 * real zod costs ~90 kB gzip on every route (PRD budget: 180 kB), so here
 * every zod call returns the same inert chainable value.
 */
const inert = new Proxy(function zodInert() {}, {
  get(_target, key) {
    if (key === 'then' || key === Symbol.iterator || key === Symbol.asyncIterator) return undefined;
    if (key === Symbol.toPrimitive) return () => '';
    if (key === 'safeParse' || key === 'parse' || key === 'parseAsync' || key === 'safeParseAsync') {
      return () => {
        throw new Error('Contract schemas cannot validate in the browser — let the API validate and show ApiError.fields');
      };
    }
    return inert;
  },
  apply: () => inert,
  construct: () => inert,
});

class ZodError extends Error {}

module.exports = { z: inert, default: inert, ZodError, ZodType: inert };
