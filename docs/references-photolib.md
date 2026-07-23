# References: photo library (server-side bench photos + cached identification)

Consulted 2026-07-24 while building `lib/photos/store.ts`, `lib/photos/contract.ts`,
`app/api/photos/**`, and the "Your photos" strip in `app/inventory/page.tsx`.

## Sources

- Next.js `route.js` file convention (docs site reports version 16.2.11; the
  relevant behaviors date from v15.0.0):
  https://nextjs.org/docs/app/api-reference/file-conventions/route
  - Binary / non-UI responses: return `new Response(body, { status, headers })`
    with a custom `Content-Type` header ("Non-UI Responses" section). The
    file route sends a fresh `Uint8Array` copy of the stored bytes with
    `Content-Type`, `Content-Length`, and `Cache-Control` headers.
  - `context.params` is a Promise since v15.0.0 (`{ params }: { params:
    Promise<{ id: string }> }` then `await params`), matching the existing
    `app/api/commits/[id]/route.ts` pattern.
  - Default caching for `GET` handlers changed from static to dynamic in
    v15.0.0; routes still declare `export const dynamic = "force-dynamic"`
    to match the repo convention.
  - Route handlers read JSON bodies with `await request.json()` and need no
    `bodyParser` configuration (unlike Pages Router API routes).

## Landmine this design avoids

In production builds the `public/` folder is snapshotted at build time; files
written there at runtime 404. Runtime-stored user photos therefore live under
`data/photos/` and stream through `GET /api/photos/<id>/file`, never `public/`.
