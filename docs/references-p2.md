# References — P2 guided assembly builder

Verified 2026-07-23 via WebFetch before implementation.

## Next.js

- `useSearchParams` (App Router): returns read-only `URLSearchParams`; a
  client component calling it on a statically prerendered route MUST be
  wrapped in a `<Suspense>` boundary or `next build` fails with
  missing-suspense-with-csr-bailout. Works without Suspense in dev, so the
  failure only appears at build time. Applied in `app/assemble/page.tsx`
  (`AssemblePage` wraps `AssembleInner` in `Suspense`).
  https://nextjs.org/docs/app/api-reference/functions/use-search-params
  (docs version 16.2.11, behavior identical for Next 15)

## Web platform

- Canvas crispness on high-DPI phones: size the backing store as
  `cssSize * devicePixelRatio`, then `ctx.scale(dpr, dpr)` (implemented as
  `ctx.setTransform(dpr,0,0,dpr,0,0)` per frame) so drawing code stays in
  CSS-pixel coordinates. Applied in `components/Overlay.tsx`.
  https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio
- SVG SMIL `<animate>` for the pulsing target rings: Baseline "widely
  available" across browsers since January 2020; syntax
  `<animate attributeName="r" values="10;22;10" dur="1.2s" repeatCount="indefinite"/>`.
  Applied in `components/BoardView.tsx`.
  https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/animate

## Node.js (test runner constraint)

- Native TypeScript type stripping: flagless since Node 23.6.0 (backported
  to 22.18.0); this repo runs Node 24.14.0. Constraints that shaped the
  code layout:
  - Import specifiers MUST include the `.ts` extension at runtime, but
    `tsc` rejects `.ts` extensions without `allowImportingTsExtensions`.
    Resolution: `lib/assembly/stepgraph.ts` and `lib/assembly/circuits.ts`
    contain ONLY type-only imports (`import type ... from "@/lib/types"`),
    which are erased before module resolution, so `node --test` can load
    them directly and `tsc` still typechecks the alias. This is also why
    `humanizeRef` lives in stepgraph.ts instead of importing `refLabel`
    from circuits.ts.
  - `tsconfig` `paths` are not transformed at runtime; a runtime import of
    `@/lib/types` would error under Node. Type-only imports avoid this.
  - Erasable-syntax only (no enums, no namespaces with runtime code, no
    parameter properties); both modules comply.
  https://nodejs.org/api/typescript.html

## Internal contracts consumed (not external, listed for the integrator)

- `lib/perception/index.ts` `createBackend(mode, opts)` from the scaffold:
  "mock" takes `MockScriptEntry[]`, "manual" relays `inject()`, "live"
  throws until the perception builder ships it. `lib/assembly/usePerception.ts`
  wraps it and surfaces the throw as `error` instead of crashing the page.
- `/api/codegen` (codegen builder): request `{ netlist, circuitHint,
  intent? }`, response validated with zod against the `CodegenResult`
  shape plus an optional `note` string. On any failure the page falls back
  to `lib/assembly/codegenFallback.ts` (deterministic template, `via:
  "template"`).
- `/api/commits` (timeline builder): request `{ message, netlist,
  firmware: { code, hash } }`; only `res.ok` is relied on.
