# Browser tests

The suite lives in the Linux filesystem at `~/forge-e2e` because installing
Playwright and Chromium onto the Windows mount takes ten times longer. This
directory holds the committed copy of the specs; run them from `~/forge-e2e`:

    cd ~/forge-e2e && npx playwright test

Point them at a different server with `FORGE_URL=http://localhost:3123`.

What these tests cannot reach — live camera, screen share, physical hardware,
and human judgement — is documented in `../../TESTING-GAPS.md`.
