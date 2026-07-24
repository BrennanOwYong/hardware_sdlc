# Verification report

Date: 2026-07-23. Verified against the production build (`next build` output already present in `.next/`), served with `npm run start` on port 3123 inside WSL2. Server log for this run: `forge/.verify-server.log`.

## Results

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | GET `/` | PASS | HTTP 200; markers `Forge`, `Ctrl-F`, nav links to Inventory / Assemble / Timeline |
| 2 | GET `/inventory` | PASS | HTTP 200; markers `Inventory`, `Ctrl-F` |
| 3 | GET `/assemble` | PASS | HTTP 200; markers `Assemble`, `assembly` (page body hydrates client-side) |
| 4 | GET `/timeline` | PASS | HTTP 200; markers `Timeline`, `git for hardware`, `commit` |
| 5 | POST `/api/identify` `{}` | PASS (with nuance) | `{}` is schema-valid (all fields optional) and returns 200 via the keyless mock path with a note. Zod rejection confirmed with `{"useSample":"yes"}` -> 400 `Expected boolean, received string` and non-JSON body -> 400 |
| 6 | POST `/api/identify` `{"useSample":true}` | PASS | 200; 12 parts (>= 5); `source: "mock"`; note explains ANTHROPIC_API_KEY absence |
| 7 | POST `/api/codegen` canonical button-led netlist | PASS | 200; `via: "template"`; code contains `BUTTON_PIN = 2` (INPUT_PULLUP) and `LED_PIN = 13` (OUTPUT); `pinsUsed: ["UNO:D2","UNO:D13","UNO:GND"]` (UNO:GND included beyond D2/D13 because the GND wire is part of the observed netlist) |
| 8 | Commits: create | PASS | 201; commit created on `main` with parent = seeded root (`empty board`) |
| 9 | Commits: list | PASS | GET returns commits oldest-first; both created commits present with correct parent chain |
| 10 | Commits: fork | PASS | 201; new commit on branch `verify-fork`, parent = forked-from id, board state copied |
| 11 | Commits: rollback-plan | PASS | GET with `from`/`to` returns ordered ops (removals first: resistor, then LED) plus `targetFirmwareHash` of the target commit |
| 12 | POST `/api/perceive` without key | PASS | 200; `{"events":[],"note":"no ANTHROPIC_API_KEY: use mock or manual mode"}` |
| 13 | `npm run test` | PASS | 38/38 node --test assertions pass, 0 fail (perceive contract, step graph two-stage state machine, vcs diff/store, codegen) |

## Notes

- ANTHROPIC_API_KEY was absent for the whole run; every API degraded to its deterministic mock path with a note field, as designed.
- The identify schema treats `{}` as a valid "no image" request and serves the mock inventory instead of rejecting; invalid types and malformed JSON get 400. Recorded here so the pitch demo does not depend on a 4xx for empty bodies.
- Non-blocking warning during tests: node suggests adding `"type": "module"` to package.json when importing `.ts` helpers; tests pass regardless. package.json is read-only per build rules, left untouched.

## How to run

1. `cd forge && npm run dev` (serves on port 3123).
2. Open http://localhost:3123.
3. 90-second demo: home -> Run demo -> watch the 7 assembly steps go green -> firmware code appears -> commit -> open Timeline.
4. Screen-simulation recipe: arrange JPEG cutouts of parts in Google Slides or MS Paint, choose Live screen mode in the app (getDisplayMedia screen capture), drag cutouts to simulate wiring; set `ANTHROPIC_API_KEY` in `forge/.env.local` for live vision, otherwise every feature runs on the deterministic mock path.
5. Phone over LAN: camera capture (getUserMedia) requires a secure context, so plain `http://<lan-ip>:3123` blocks the camera on a phone. Use localhost on the demo machine, or front the dev server with an HTTPS tunnel (e.g. `npx ngrok http 3123`) for phone testing.

## Delta build 2 verification (2026-07-23)

Production server: `.next` build reused, `npx next start -p 3123`, ready in 40.5s. ANTHROPIC_API_KEY absent for the whole run; no board plugged in; arduino-cli present as a Linux binary at `forge/bin/arduino-cli` with the AVR core installed.

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | GET `/`, `/inventory`, `/assemble`, `/timeline`, `/bench` | PASS | All 200. Home nav carries a Bench link. `/bench` SSR shows `<h1>Bench</h1>`, the subtitle "board on your desk and proves it works before you flash anything real", and the "Checking the bench..." loading state; the plug-in wizard copy ("Plug the flat...", power-only-cable tip) lives in the client bundle (`app/bench/page.tsx`) and renders after the first `/api/bench` poll |
| 2 | GET `/api/bench` | PASS | 200 BenchStatus JSON: `cliAvailable: true`, `coreInstalled: true`, `devices: []`, plus the plain-language WSL note ("cannot see USB ports by itself... ARDUINO_CLI_PATH at a Windows arduino-cli.exe, or bridge the port with usbipd-win. See README > Flashing setup") |
| 3 | POST `/api/flash` tiny blink sketch | PASS | 200, `ok: true`, `stage: "compile"`; compiler verdict: "Sketch uses 924 bytes (2%) of program storage space"; `firmwareHash` present; guidance says the code compiles cleanly and asks the user to plug a board in before flashing. No 500 |
| 4 | POST `/api/bench/test` with no board | PASS | 200, `ok: false`, `stage: "upload"`, guidance is the same beginner-language WSL/USB note. No 500 |
| 5 | POST `/api/identify` `{"useSample":true}` (regression) | PASS | 200; 12 parts (>= 5). With an added `query` field the request validates and returns 200 with the same inventory |
| 6 | POST `/api/perceive` keyless (regression) | PASS | Valid-shape request returns 200 `{"events":[],"note":"no ANTHROPIC_API_KEY: use mock or manual mode"}` (unchanged). Schema violations still 400 with field-level issues |
| 7 | POST `/api/codegen` canonical button-led netlist (regression) | PASS | 200, `via: "template"`, `BUTTON_PIN = 2` / `LED_PIN = 13`, `pinsUsed: ["UNO:D2","UNO:D13","UNO:GND"]` (unchanged) |
| 8 | `npm run test` | PASS | 69 tests, 69 pass, 0 fail across 6 files: the original codegen / perception / stepgraph / vcs suites plus the delta additions `tests/markers.test.mjs` and `tests/bench.test.mjs` |

Notes: `/api/identify` with an unknown extra field (`query`) passes validation and answers 200; every bench/flash path answered with a beginner-language guidance string instead of an error status. Server killed after the run (`.verify-server.log` holds the boot log).

## Practice data + SAM adapter verification (2026-07-24)

Production server left RUNNING on port 3123 throughout (not restarted). Note on keys: `forge/.env` now carries non-empty `ANTHROPIC_API_KEY` and `REPLICATE_API_TOKEN`, so the running server exercises the keyed branches; the keyless notes ("ANTHROPIC_API_KEY is not set ...", "no ANTHROPIC_API_KEY: use mock or manual mode") are covered by the unit suites, not reachable over HTTP in this run.

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | GET `/practice/manifest.json` | PASS | 200 valid JSON: `photos[]` (8 entries) and `videos[]` (2 entries), each with file/title/credit/license/sourceUrl. Assets exist under `forge/public/practice/` with `ATTRIBUTION.md` |
| 2 | GET one photo + one video | PASS | `/practice/uno-closeup.jpg` 200 `image/jpeg` 1,913,986 bytes; `/practice/wiring-hands-1.mp4` 200 `video/mp4` 1,145,253 bytes |
| 3 | GET `/inventory` | PASS | 200; page is a client-rendered shell, the practice strip strings ("Practice photos", "Practice photos unavailable", fetch of the practice media list) live in `/_next/static/chunks/app/inventory/page-*.js` |
| 4 | GET `/assemble` | PASS | 200; assemble chunk `/_next/static/chunks/app/assemble/page-*.js` carries the "Practice video" mode strings ("Practice video clip", "Practice videos unavailable", `practice-video`) |
| 5 | POST `/api/identify` `{"useSample":true}` | PASS | 200; `source: "mock"`, 12 parts (>= 5), mock note ("No image was supplied — returned the deterministic mock inventory." — the keyed-server variant of the mock path, since ANTHROPIC_API_KEY is set). Adding `query` still validates (200); `{"query":123}` -> 400 zod field error |
| 6 | POST `/api/perceive` regression | PASS | Schema violations 400 with field-level issues; valid-shape request 200 with `{events: [], note}` (no 500) even when the upstream vision call rejects the frame — graceful degradation holds on the keyed path |
| 7 | `npm run test` | PASS | 90 tests, 90 pass, 0 fail. Prior 69 plus `tests/practice.test.mjs` (11) and `tests/sam.test.mjs` (10, includes the degradation ladder: both keys -> sam+vlm, anthropic only -> vlm, else mock) |
| 8 | `TESTING.md` T11/T12 | PASS | Repo-root `TESTING.md` lists T11 (Practice photos on /inventory) and T12 (Practice video on /assemble) with the session-status line describing 8 photos + 2 clips |
| 9 | Re-warm | PASS | `/`, `/inventory`, `/assemble`, `/timeline`, `/bench` all fetched 200 at the end of the run; server left running for the user's live session |

## Photo library + all-objects prompts verification (2026-07-24)

Production server left RUNNING on port 3123 throughout (integrator-managed; not restarted by the verifier). Both ANTHROPIC_API_KEY and REPLICATE_API_TOKEN present, so keyed branches are live.

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | POST `/api/photos` tiny valid JPEG | PASS | 201 with `photo.id`; body shape is `{photoDataUrl, width, height, label?}` per `lib/photos/contract.ts`. Store assigned its own display label ("Bench 03:03") regardless of the submitted label |
| 2 | GET `/api/photos` | PASS | 200; the new id listed, meta only (no inventory field without `?full=1`) |
| 3 | GET `/api/photos/<id>/file` | PASS | 200 `content-type: image/jpeg`; bytes byte-identical to the posted JPEG (`cmp` clean). Served from `data/photos/<id>.jpg` through the route, not `public/` |
| 4 | PATCH `/api/photos/<id>` small fake inventory | PASS | 200; `GET /api/photos?full=1` carries the exact inventory back (1 resistor part, source `mock`) |
| 5 | DELETE `/api/photos/<id>` | PASS | 200 `{ok:true}`; `data/photos/<id>.jpg` removed, id absent from `data/photos/index.json`, subsequent file GET 404 |
| 6 | Oversize (9 MB) rejected | PASS (deviation) | Rejected with **413** and a plain-language cap message ("photo is 9437184 bytes; the cap is 8388608 (8 MB)"), not the 400 the brief expected. 413 is the correct HTTP semantics for payload-too-large; no 500 |
| 7 | Bad mime rejected | PASS | `data:text/plain` -> 400 "photoDataUrl must be a base64 data URL of type image/jpeg or image/png" |
| 8 | Unknown id | PASS | GET file and DELETE on a fake id -> 404 with an eviction-explainer note, not 500 |
| 9 | GET `/inventory` | PASS | 200; "Your photos" present in the served payload |
| 10 | Identify prompt builders | PASS | `node --test tests/identify-prompts.test.mjs`: 9/9. All-objects language confirmed live: "covers non-electronic objects with buckets and examples" and `"ignore" reserved for true background, never for non-electronics` both pass |
| 11 | POST `/api/identify` `{"useSample":true}` | PASS | 200, `source: "mock"`, 12 parts (>= 5). `{"query":123}` -> 400 zod error |
| 12 | POST `/api/perceive` valid shape | PASS | 200 `{"events":[],"note":"vlm confidence 0.20 is below 0.50 - this look was ignored"}` — keyed path degraded gracefully on a 1x1 test frame, no 500 |
| 13 | `npm run test` | PASS | 108 tests, 108 pass, 0 fail: prior 90 plus `tests/identify-prompts.test.mjs` (9) and `tests/photos.test.mjs` (9) |
| 14 | `TESTING.md` T13/T14 | PASS | Repo-root `TESTING.md` (at `hardware_project/TESTING.md`) lines 45 and 49: T13 General desk ID, T14 Photo library, each with +VE/-VE/JUDGE |
| 15 | Re-warm | PASS | `/`, `/inventory`, `/assemble`, `/bench`, `/timeline` all 200 at end of run; server left RUNNING |

## Masks + live UX + storage migration verification (2026-07-24)

Tested through the proxy at http://localhost:3123 (proxy, tunnel, and backend ports untouched). ANTHROPIC_API_KEY and REPLICATE_API_TOKEN live; one check spent real API money on purpose.

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | Pages `/`, `/inventory`, `/assemble`, `/timeline`, `/bench` | PASS | All 200 through the proxy |
| 2 | GET `/api/images/practice/manifest.json` | PASS | 200; entries carry `file` names (no absolute URLs); `lib/practice/manifest.ts` joins them onto `PRACTICE_BASE_PATH = "/api/images/practice"`, so every served URL starts with `/api/images/practice/`. `sourceUrl` fields are external attribution links by design |
| 3 | Media through `/api/images/` | PASS | `uno-closeup.jpg` 200 `image/jpeg`; `wiring-hands-1.mp4` 200 `video/mp4` |
| 4 | Traversal `/api/images/../../.env` (`--path-as-is`) | PASS | 404 Next.js not-found page, zero secret content. Encoded form `..%2F..%2F.env` -> 404 JSON `"no image at practice/../../.env"` with the folder-explainer note |
| 5 | POST `/api/photos` tiny JPEG | PASS | 201 with photo id; file landed at `data/images/user/<id>.jpg` and `data/images/user/index.json`. Migration confirmed: `data/photos/` does not exist |
| 6 | POST `/api/live-captures` no clip | PASS | 201; frame + results + meta files under `data/images/live-view/` sharing one id, URLs all `/api/images/live-view/...` |
| 7 | POST `/api/live-captures` with webm clip | PASS | 201; clip + frame + results + meta share one id; `clipMime: "video/webm"`, `clipBytes: 25` recorded |
| 8 | GET `/api/live-captures` | PASS | 200; newest-first (the later clip capture listed before the earlier no-clip one) |
| 9 | POST `/api/identify` `{"useSample":true}` fast path | PASS | 200 in 0.017 s (keys live, so speed proves the fast path); known sample inventory (12 parts) with note "sample sheet uses its known inventory - photograph something real for live vision" |
| 10 | POST `/api/identify` real practice photo (uno-closeup.jpg, 1.9 MB base64) | PASS | 200 in 53.8 s (limit 120 s); note `"sam+vlm: 8 regions, 8 labeled, masks on 8 parts"`; all 8 parts carry `maskPng` whose base64 decodes to a real PNG (`89 50 4E 47` header, first mask 4,404 bytes). Live SAM + Claude spend, first attempt, no retry needed |
| 11 | `npm run test` | PASS | 163 tests, 163 pass, 0 fail |
| 12 | `TESTING.md` T15/T16/T17 | PASS | Repo-root `TESTING.md` lines 66/70/74: T15 pixel-exact masks, T16 snap-on-submit states, T17 live-view artifacts |
| 13 | `FEEDBACK.md` items 2/3/4/9/10 | PASS | All five read "Status: LIVE" |
| 14 | Re-warm | PASS | All five pages fetched 200 through the proxy at end of run; proxy and backend left untouched and RUNNING |

## Coach + build journal + commit diagram verification (2026-07-24)

Tested through the proxy at http://localhost:3123 (proxy, tunnel, and backend ports untouched; 3125 live). ANTHROPIC_API_KEY live; the coach check spent real API money on purpose.

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | GET `/coach` | PASS | 200; page carries the goal input (`maxLength=200`, placeholder "plug the USB cable into the Arduino's..."); nav `href="/coach">Coach` present on `/coach` and `/` |
| 2 | POST `/api/coach` real photo | PASS | `data/images/practice/uno-closeup.jpg` (2.5 MB base64) + goal "point out the Arduino board" -> 200 in 5.4 s (Claude-only path, within the 10-15 s expectation); strict JSON: `verdict: "done"`, one-sentence `instruction`, `objects[]` with 4 labeled bboxes (board, USB-B port, pin headers, MCU chip), `target`, `confidence: 0.95` |
| 3 | POST `/api/coach` zod-invalid | PASS | `{"goal":"x"}` -> 400 with degrade-shaped body (`verdict: "cannot-see"`, note "invalid request: imageBase64: Required; attempt: Required"); no 500 |
| 4 | POST `/api/journal` coach fixture | PASS | Tiny 1x1 JPEG frame -> 201; entry got `framePath: journal/<id>.jpg`; GET `/api/journal` pending grew 0 -> 1 |
| 5 | POST `/api/flash` tiny sketch | PASS | Blink sketch -> `{ok:true, stage:"compile", firmwareHash:"e1c7cde6c4e8"}` with plug-in guidance (no board attached); pending journal grew to 2 with the `flash` entry "compiled e1c7cde6c4e8" |
| 6 | POST `/api/commits` drains journal | PASS | Sample commit (1-edge netlist) -> 201; commit `0a5bdb66` carries `journal` with both entries (coach + flash) in order; GET `/api/journal` back to `{"entries":[]}`; GET `/api/commits` shows the entry summaries on the commit |
| 7 | Timeline chunk journal + diagram | PASS | `app/timeline/page-*.js` chunk contains "build journal" and "Frame for journal entry" plus 12 `firmware` hits; shared chunk `481-*.js` (BoardView) contains 6 `breadboard` hits and "diagram with exact hole wiring" |
| 8 | `/assemble` regression | PASS | 200; its page chunk still carries the step-mode BoardView props (`steps` x21, `currentIndex` x12, `seatedIds` x11, `phase:` x17) matching `app/assemble/page.tsx:601` |
| 9 | `npm run test` | PASS | 187 tests, 187 pass, 0 fail |
| 10 | `TESTING.md` T19/T20/T21 | PASS | Repo-root `TESTING.md` lines 81/85/89: T19 coach USB drill, T20 build journal, T21 commit-state diagram, each with full +VE/-VE/JUDGE |
| 11 | `FEEDBACK.md` 12/13/14 | PASS | All three read "Status: LIVE, awaiting your T19/T20/T21 verdict" |
| 12 | Re-warm | PASS | `/`, `/inventory`, `/assemble`, `/timeline`, `/bench`, `/coach` all 200 (13-17 ms warm) at end of run; proxy and backend left RUNNING |

Residue left on purpose: commit `0a5bdb66-5273-4505-8bc6-89bed3968ba4` ("verifier T20 journal drain commit") in `data/commits.json` with its two journal entries, and the journal frame at `data/images/journal/604cdfc1-....jpg` - live proof the drain works; visible on `/timeline` for the T20 walkthrough.
