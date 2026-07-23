# Practice media moved

The curated practice photos, videos, `manifest.json`, and `ATTRIBUTION.md`
now live in `data/images/practice/` and are served at
`/api/images/practice/<file>` by `app/api/images/[...path]/route.ts`.

Reason: `public/` is snapshotted into production builds, so runtime-served
media must stream from `data/` via API routes. The unified storage root
`data/images/` holds user photos (`user/`), this curated set (`practice/`),
and live-view capture artifacts (`live-view/`) side by side.

The original files are in git history (baseline commit). See
`docs/references-storage.md`.
