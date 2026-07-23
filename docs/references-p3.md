# P3 git-for-hardware: references

Sources verified on 2026-07-23 before writing `lib/vcs/**`, `app/api/commits/**`,
`app/timeline/page.tsx`, `tests/vcs.test.mjs`.

## Next.js route handlers (app/api/commits/**)

- https://nextjs.org/docs/app/api-reference/file-conventions/route
  - Handlers export `GET`/`POST` functions receiving a Web `Request` (or
    `NextRequest`); JSON responses via `Response.json` / `NextResponse.json`
    with `{ status }`.
  - Since v15.0.0 `context.params` is a **Promise**; dynamic segment handlers
    must `await params`:
    `export async function GET(request: Request, { params }: { params: Promise<{ id: string }> })`.
  - Query strings: `request.nextUrl.searchParams` on `NextRequest` (used by
    `rollback-plan`).
  - Segment config `export const runtime = "nodejs"` / `dynamic = "force-dynamic"`
    documented on the same page.

## Node.js native TypeScript execution (tests/vcs.test.mjs)

- https://nodejs.org/api/typescript.html
  - Type stripping is on by default since v23.6.0 (Node here is v24.14.0);
    only erasable syntax runs: no enums, no runtime namespaces, no parameter
    properties, no decorators. `lib/vcs/*.ts` avoids all of these.
  - Import specifiers targeting `.ts` files must include the `.ts` extension.
  - Locally probed (scratchpad, exit 0): a `.mjs` entry file CAN import a `.ts`
    module (`import { x } from "./mod.ts"`), including classes; this is why
    `tests/vcs.test.mjs` imports `../lib/vcs/diff.ts` and `../lib/vcs/store.ts`
    directly with no build step.
  - Consequence inside `lib/vcs`: `store.ts` must not runtime-import `diff.ts`
    (tsconfig `moduleResolution: "bundler"` without `allowImportingTsExtensions`
    forbids extensionful specifiers, while Node requires them). Types cross
    files via `import type`, which type stripping erases before resolution.

## Test runner

- `node --test tests/vcs.test.mjs` (package.json already ships
  `"test": "node --test tests/"`). Assertions use `node:assert/strict`.
