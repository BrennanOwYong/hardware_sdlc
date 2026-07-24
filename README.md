# Forge

Forge is a phone-friendly web app for "vibe coding" hardware: photograph your workspace to get a searchable part inventory (Ctrl-F for real life), follow guided assembly where live video confirms each wire placement before you push it in, and version every working build as a commit with photo, netlist, and firmware hash (git for hardware).

## Quickstart

```bash
npm install
npm run dev
```

Open http://localhost:3123

- `/inventory` - P1: photo (or bundled sample) -> named part inventory, Ctrl-F search, tap-to-highlight, rename. Delta 2 adds AR pins on the photo and a live Ctrl-F mode (see below).
- `/assemble` - P2: guided assembly with two-stage confirmation (tip on target -> "Correct - push it in now" -> seated), wrong placements block the build, firmware generated from the observed pins, commit to the timeline. `/assemble?demo=auto` autoplays the scripted demo.
- `/timeline` - P3: build commits with branch badges, two-commit diff, rollback plan, fork.
- `/bench` - Delta 2: the pairing wizard that walks a beginner from "no board yet" to "equipment confirmed working" (see below).

## Configuration (.env.example)

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | No | Enables the real vision calls (`/api/perceive`, `/api/identify`) and LLM firmware tweaks (`/api/codegen`). Every route degrades to a deterministic mock with a visible `note` when the key is absent. |
| `REPLICATE_API_TOKEN` | No | With `ANTHROPIC_API_KEY` also set, `/api/identify` runs Meta SAM 2 (Segment Anything Model) on Replicate for region proposals, then one vision call labels the numbered regions (`note: "sam+vlm: ..."`). Absent, or on any SAM failure, identification falls back to vision-only with an explanatory note. |

Model: `claude-sonnet-5` on every Anthropic call; `meta/sam-2` (pinned version, see `docs/references-practice-sam.md`) on Replicate.

## Modes

The assemble page has five perception modes; the table shows what each needs.

| Mode | What drives perception | Needs `ANTHROPIC_API_KEY` | Needs camera/screen | Notes |
| --- | --- | --- | --- | --- |
| Demo autoplay | Scripted event timeline (`lib/assembly/mockscript.ts`), including a deliberate wrong-hole beat on step 4 | No | No | Fully keyless and offline. `/assemble?demo=auto` starts it on load. |
| Manual sim | You click "Tip on correct target" / "Seat it" / "Misplace it" buttons; each click injects a perception event | No | No | Wizard-of-oz mode. Works on any device. |
| Live camera | `getUserMedia` frames -> `POST /api/perceive` -> Claude vision verdict | Yes (keyless returns empty events + a note) | Phone/laptop camera; HTTPS or localhost | Phones require HTTPS: on plain HTTP `navigator.mediaDevices` is undefined. Use a TLS tunnel (ngrok/cloudflared) for on-phone demos. |
| Live screen | `getDisplayMedia` screen capture -> `POST /api/perceive` | Yes (keyless returns empty events + a note) | Desktop browser | Screen capture is desktop-only (no mainstream mobile support) and must start from a button click. |
| Practice video | Bundled real wiring footage (`data/images/practice/*.mp4`, served via `/api/images/practice/`) looped through a `<video>` element -> the same 1 s frame loop -> `POST /api/perceive` | Yes (keyless returns empty events + a note) | No | Works with zero hardware and no camera. See the Practice data section. |

The inventory page (`/inventory`) works keyless too: without `ANTHROPIC_API_KEY` the identify route returns the deterministic mock inventory that matches `public/sample-parts.svg`, with a `note` explaining the degradation. The bundled sample takes a fast path in every configuration: keyed or keyless, "Use sample parts image" returns its known inventory instantly without any vision call, with the note "sample sheet uses its known inventory - photograph something real for live vision". Codegen is deterministic (template) for the canned intents and only uses the key for free-form tweak intents.

## Live Ctrl-F (inventory)

`/inventory` has a Photo | Live toggle:

- **Photo mode** identifies a bench photo (or the bundled sample) and drops game-style AR pins (pulsing halo + map pin + label) on every part that matches your search or a row tap. Identification names every distinct object on the desk, not electronics only: non-electronic items get specific labels ("USB power bank", "curved tweezers", "phone stand") in tool / battery / stationery / accessory / container / other buckets, while electronic parts keep full detail (chip markings, board names, resistor values).
- **Live mode** watches your camera ("Point camera") or a shared screen ("Watch my screen"), and while a search query is typed it sends a ~1024 px frame to `/api/identify` every 2.5 s with a SEARCH FOCUS hint. Matching parts get AR pins drawn over the live video, with "scanning" / "watching" badges and a "found N" chip. Stop, tab close, or the browser's own stop-sharing button all release the camera/screen.

Keyless behavior: live mode detects the mock response, shows the degradation note, and stops polling until you start capture again. Screen watching is desktop-only; the camera needs HTTPS or localhost, same as `/assemble`.

## Unified images folder (`data/images/`)

All runtime and bundled media share one root, `data/images/`, streamed through `GET /api/images/<subdir>/<file>` (extension allowlist, path-traversal checks, immutable caching for media, single-Range 206 responses so Safari and iOS play video). Production builds snapshot `public/` at build time, so runtime files must stream from `data/`; unifying practice media there too gives one folder and one serving mechanism.

- `data/images/user/` - the photo library behind the "Your photos" strip on `/inventory`: one JPEG per photo plus `index.json`. The library keeps the newest 50 photos; adding the 51st evicts the oldest, including its file. Each photo stores its latest identification, so tapping a thumbnail restores the photo and its parts list from cache with no new vision call; re-identifying refreshes the cache. The delete button removes both the index entry and the file. Practice and sample photos never enter the library. Photos saved under the legacy `data/photos/` location migrate here automatically on the first `/api/photos` call after upgrade.
- `data/images/practice/` - the bundled practice photos and wiring clips, with `manifest.json` and `ATTRIBUTION.md` (see the Practice data section).
- `data/images/live-view/` - artifacts auto-saved from live Ctrl-F runs (next paragraph).

### Live-view artifacts

Submitting a live Ctrl-F search freezes the frame (snap on submit) and auto-saves the run through `POST /api/live-captures` into `data/images/live-view/`: a recorded clip that ends at the submit moment (webm or mp4; skipped when the browser lacks `MediaRecorder` or the clip exceeds 30 MB), the frozen frame JPEG, a results PNG styled like the photo-mode parts table, and a metadata json, all sharing one id. `GET /api/live-captures` lists saved captures newest-first. Keyless runs save nothing: mock parts would not describe the real frozen frame.

## Coach mode (`/coach`)

Coach mode answers "which socket, which way?" with annotated photos of your own bench. Type a single-action goal ("plug the USB cable into the Uno's socket"), photograph the bench, and `POST /api/coach` returns a verdict (`adjust`, `done`, or `cannot-see`), one plain instruction, labeled boxes on the objects it recognized, a pulsing target marker on the exact spot to act on, and an arrow when direction helps - all drawn on your photo with the same marker machinery as inventory's AR pins. A wrong guess raises the attempt counter, and the next instruction corrects the specific mistake; retry photos carry the last few instructions as history so guidance stays consistent. Frames upload at <=1568 px; geometry returns normalized and server-clamped into 0..1. Keyless runs, malformed model output, and upstream API errors all degrade to a `cannot-see` verdict with a plain note (HTTP 200), never an error screen. Each exchange also fire-and-forgets a build-journal entry (next section); a journal failure never disturbs the coaching flow.

## Git for hardware (`/timeline`)

Commits (`lib/vcs`, `data/commits.json`) capture end states: message, photo, hole-precise netlist, firmware code and hash. Two additions record the work between end states and draw each state on the board:

**Build journal.** Version control tracks the steps done between commits: every coach exchange (annotated frame + instruction + verdict + attempt) and every flash event ("compiled `<hash>`", plus "flashed `<hash>` to `<board>`" when a board is attached) appends a pending entry via `POST /api/journal`; frames land in `data/images/journal/` and stream through `/api/images/journal/<file>`. `POST /api/commits` drains the pending list into the new commit's `journal` field, so entries attach to the first commit after they happened; a rejected commit restores its drained entries, so no entry is lost. The timeline renders the journal as a collapsible list under each commit card. Commits from before the feature (no `journal` field) stay valid with no migration.

**Commit-state diagram.** Each commit renders its netlist on the breadboard+Uno drawing (`components/BoardView.tsx` netlist mode) with every wire endpoint on the exact drawn hole, through the same `refToXY` mapping the assembly view uses ("BB:15:a", "UNO:D2"), plus a firmware badge showing the hash and the pins the netlist uses; an edge with an unmappable ref is dropped instead of drawn in a wrong place. Selecting two commits renders one diff diagram - added wiring in green, removed wiring in red at its old coordinates (`lib/diagram/selectors.ts`, keyed on physical identity like `lib/vcs/diff.ts`) - next to the existing sentence diff.

## Bench and the pairing wizard (`/bench`)

`/bench` walks a total beginner from "no board yet" to "equipment confirmed working":

- Polls `GET /api/bench` every 3 s; each detected board becomes a device card with a plain-language status: **awake** (introduced itself over serial), **quiet** (plugged in, but not introducing itself - often a power-only USB cable), or **unplugged** (seen this session, now gone; session memory lives in `data/bench.json`).
- **Test my board** compiles and uploads a tiny "hello" sketch and waits for the board to say hello back, reporting each stage (compiling -> uploading -> waiting for hello) with beginner guidance when a stage fails.
- **Show me on a photo** runs the photo through `/api/identify` and drops AR pins on the board and its wired peripherals.
- The nav shows a bench chip (`components/BenchChip.tsx`) summarizing board state on every page.
- The **Flash** button on `/assemble`'s firmware panel checks the bench first: with a working CLI and an awake board it flashes through `POST /api/flash`; otherwise it opens the manual path (Wokwi / Arduino IDE) with the bench's guidance string.

Everything degrades: no arduino-cli, no core, or no board each return an HTTP 200 result with a plain-language note, never a crash.

## Flashing setup

Flashing shells out to [arduino-cli](https://arduino.github.io/arduino-cli/1.5/getting-started/); no serial-port npm modules are involved. Install it once, then `/bench` and the Flash button find it via this resolution order: `ARDUINO_CLI_PATH` env var -> `arduino-cli` on PATH -> `bin/arduino-cli` -> `bin/arduino-cli.exe`.

Install the CLI and the AVR core (Uno toolchain):

```bash
curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=$PWD/bin sh
bin/arduino-cli core update-index && bin/arduino-cli core install arduino:avr
```

Three paths to a board, depending on where the app runs:

1. **WSL + Windows arduino-cli.exe (recommended on this machine).** WSL2 cannot see USB serial ports, so a Linux binary lists zero boards even with an Uno plugged in. Install arduino-cli for Windows, then point the app at it: `ARDUINO_CLI_PATH=/mnt/c/path/to/arduino-cli.exe`. WSL interop runs the .exe and it sees `COM*` ports; the app translates sketch paths with `wslpath -w` automatically and keeps its scratch dirs under `data/bench-scratch/` on the Windows-visible mount.
2. **WSL + usbipd-win.** Bridge the USB device into WSL with [usbipd-win](https://learn.microsoft.com/en-us/windows/wsl/connect-usb); after `usbipd attach` the Linux `bin/arduino-cli` sees `/dev/ttyACM0`.
3. **Native Linux/macOS (non-WSL).** The Linux install above is enough; boards appear as `/dev/ttyACM*` / `/dev/ttyUSB*` with no extra steps.

With no CLI installed, `/bench` and Flash still work: they explain what is missing in plain words and point back to this section.

## Accuracy ladder (live perception)

Live assembly checking ships at rung 1 of a three-rung ladder (details and doc links in `docs/references-delta-accuracy.md`):

1. **Verdict-level with `observedRef` (shipped).** 1024-px frames; the model names the specific pin it sees the tip nearest (silkscreen labels, breadboard hole counting), a mismatch against the expected target raises "wrong hole: expected D2, saw D4", confidence under 0.5 discards the frame, and tip/seat events need 2 consecutive agreeing frames (`StreakGate`). Honest limits: dense breadboard regions and oblique angles still fool it.
2. **Zoomed crops (next).** Crop the frame client-side around the expected targets and send the zoom as a second image; multiplies pixels-per-hole ~4-10x with no contract change.
3. **Printed fiducial homography (mvp.md section 6, Tier 1).** A printed ArUco marker mat turns WHERE into geometry (+/- 1 hole, testable with a pen on paper); the vision model only judges seating.

## Practice data

Forge ships genuine (non-AI-generated) Arduino media so every feature has real practice input without any hardware:

- **What:** 8 photos (parts spreads, mid-build breadboards, an Uno close-up, an LCD build) and 2 wiring-footage clips, all real-camera stock from Wikimedia Commons and Pexels.
- **Where:** `data/images/practice/`, indexed by `manifest.json` there (validated by the zod schema in `lib/practice/manifest.ts`) and served through `/api/images/practice/`. `/inventory` photo mode shows a "Practice photos" card of clickable thumbnails that feed the normal identify path (banner, AR pins, search); `/assemble` has a **Practice video** mode that loops a clip through the same live perception pipeline.
- **Licensing:** every file's author, license (CC BY / CC BY-SA / Pexels License), and source link live in `data/images/practice/ATTRIBUTION.md`; the app shows the credit line under each photo and clip.
- **SAM:** set `REPLICATE_API_TOKEN` (with `ANTHROPIC_API_KEY`) to have `/api/identify` segment practice photos with Meta SAM 2 before labeling; see Configuration above.

Keyless, both surfaces degrade to the same mock-plus-note behavior as user-supplied media; a missing or malformed manifest collapses to a muted note, never a crash.

## Testing without hardware

You need zero electronics to demo Forge:

1. Make JPEG/PNG cutouts of parts (breadboard, Arduino Uno, LED, resistor, wires, pushbutton) - or screenshot `public/sample-parts.svg`.
2. Open MS Paint or Google Slides on a desktop and paste the cutouts to build a fake workspace.
3. In Forge, open `/assemble`, pick **Live screen**, and click **Share screen**; share the Paint/Slides window.
4. Drag the cutouts to simulate assembly: move a wire tip onto the current target, hold, then "push it in" by leaving it there. Every vision prompt tells the model the frame may be a simulated workspace with image cutouts and to treat cutouts as real parts.

Constraints to know:

- Phone cameras need HTTPS (or localhost): `getUserMedia` is unavailable in insecure contexts.
- Screen capture (`getDisplayMedia`) is desktop-only and requires a user gesture; Forge starts it from the "Share screen" button.
- No key, no camera, no desktop? **Demo autoplay** and **Manual sim** cover the full flow keyless, including codegen and committing to the timeline.

## Tests

```bash
npm run test        # node --test tests/*.test.mjs - no build step
npx tsc --noEmit    # strict typecheck
```

Tests import the `.ts` modules directly through Node 24 native type stripping; the modules under test keep all cross-file project imports type-only (see the per-feature notes below).

## References

Deep links each builder verified via WebFetch on 2026-07-23 before implementing. Full per-feature notes live in `docs/references-*.md`; the load-bearing links are collected here.

### Perception (`lib/perception`, `hooks/usePerception.ts`, `/api/perceive`)

- Anthropic vision (base64 image blocks, image-before-text ordering, 10 MB limit, supported media types): https://docs.anthropic.com/en/docs/build-with-claude/vision (301 -> https://platform.claude.com/docs/en/build-with-claude/vision.md)
- `getUserMedia` (camera; secure-context requirement, `facingMode: "environment"`): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- `getDisplayMedia` (screen capture; desktop-only, transient user activation): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- Replicate Segment Anything 2 (implemented as the `/api/identify` region-proposal adapter, `lib/perception/sam.ts`; links in the SAM section below): https://replicate.com/meta/sam-2

### P1 inventory (`lib/inventory`, `/api/identify`, `/inventory`)

- Anthropic vision (limits: 8000x8000 px, 1568 px long-edge downscale guidance, pixel-coordinate caveat behind `normalizeBbox()`): https://platform.claude.com/docs/en/build-with-claude/vision.md
- Models overview (request shape cross-check for `claude-sonnet-5`): https://platform.claude.com/docs/en/about-claude/models/overview.md
- SDK: `@anthropic-ai/sdk` 0.113.0 typed via `Anthropic.ImageBlockParam` / `MessageParam` / `TextBlock`, no casts.

### P2 guided assembly (`lib/assembly`, `components/*`, `/assemble`)

- `useSearchParams` must sit under `<Suspense>` on statically prerendered routes or `next build` fails: https://nextjs.org/docs/app/api-reference/functions/use-search-params
- High-DPI canvas scaling (`devicePixelRatio` backing store) for `components/Overlay.tsx`: https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio
- SVG SMIL `<animate>` for the pulsing target rings in `components/BoardView.tsx`: https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/animate
- Node native TypeScript type stripping (why `stepgraph.ts` / `circuits.ts` keep type-only imports): https://nodejs.org/api/typescript.html

### P3 git for hardware (`lib/vcs`, `/api/commits/**`, `/timeline`)

- Next.js route handlers (`context.params` is a Promise since v15; `runtime = "nodejs"`, `dynamic = "force-dynamic"`): https://nextjs.org/docs/app/api-reference/file-conventions/route
- Node native TypeScript execution constraints for `tests/vcs.test.mjs`: https://nodejs.org/api/typescript.html

### Coach mode (`lib/coach`, `/api/coach`, `/coach`)

Full notes: `docs/references-coach.md` (re-verified via WebFetch 2026-07-24).

- Anthropic vision (base64 block shape, high-resolution tier for `claude-sonnet-5`, why 1568 px frames upload unresized): https://platform.claude.com/docs/en/build-with-claude/vision.md

### Codegen (`lib/codegen`, `/api/codegen`, `components/CodePanel.tsx`)

- Anthropic TypeScript SDK (client construction, `messages.create` parameters, content-block narrowing): https://github.com/anthropics/anthropic-sdk-typescript
- Web Serial API (why browser flashing an UNO is stubbed): https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- esptool-js (browser flasher targets ESP chips, not AVR): https://github.com/espressif/esptool-js
- Wokwi simulator (manual flash path in the Flash modal): https://wokwi.com/ and https://docs.wokwi.com/
- arduino-cli (UNO FQBN `arduino:avr:uno`, compile/upload commands): https://arduino.github.io/arduino-cli/1.5/getting-started/
- Adafruit DHT sensor library (DHT11 template details, ~1 s sampling floor): https://github.com/adafruit/DHT-sensor-library

### Delta 2: live Ctrl-F + AR pins (`lib/inventory/markers.ts`, `components/ArMarkerLayer.tsx`, `/inventory`)

Full notes: `docs/references-delta-arfind.md` (re-verified via WebFetch 2026-07-23).

- `getUserMedia` (soft `facingMode: "environment"` - the `exact` form hard-fails with `OverconstrainedError` on single-camera laptops; rejection-name -> friendly-message mapping): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- `getDisplayMedia` (`{ video: true }`, transient-activation requirement, desktop-only probe, track `ended` cleanup): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- Anthropic vision (base64 block shape, media types, 10 MB / 8000x8000 limits, high-resolution tier for `claude-sonnet-5`): https://platform.claude.com/docs/en/build-with-claude/vision.md

### Delta 2: perception accuracy (`lib/perception`, `hooks/usePerception.ts`)

Full notes and the accuracy ladder: `docs/references-delta-accuracy.md` (re-verified via WebFetch 2026-07-23).

- Anthropic vision (visual token formula `ceil(w/28) x ceil(h/28)`, high-res tier max long edge 2576 px / 4784 tokens, text-legibility and JPEG-compression guidance behind the 640 -> 1024 px capture change): https://platform.claude.com/docs/en/build-with-claude/vision.md

### Delta 2: bench + flashing (`lib/bench`, `/api/bench`, `/api/flash`, `/bench`)

Full notes and locally probed JSON shapes: `docs/references-delta-bench.md` (verified 2026-07-23 against arduino-cli 1.5.1).

- Installation script (`BINDIR` override): https://arduino.github.io/arduino-cli/1.5/installation/
- `board list --json`: https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_board_list/
- `compile` (`--fqbn`, `--build-path`): https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_compile/
- `upload` (`-p`, `--input-dir`; upload never compiles): https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_upload/
- `monitor` (`-p`, `--config` baudrate): https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_monitor/
- `core install` / `core update-index`: https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_core_install/ and https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_core_update-index/
- gRPC message field names for the `--json` output (`detected_ports`, `matching_boards`, `Port.address`): https://arduino.github.io/arduino-cli/1.5/rpc/commands/
- WSL USB serial (why a Linux binary sees zero ports; usbipd-win bridging): https://learn.microsoft.com/en-us/windows/wsl/connect-usb

### Practice modes (`lib/practice/manifest.ts`, `hooks/usePerception.ts` source `"file"`, `/inventory`, `/assemble`)

Full notes: `docs/references-practice-modes.md` (verified via WebFetch 2026-07-24). Media licensing: `data/images/practice/ATTRIBUTION.md`.

- `HTMLMediaElement.play()` (Promise-returning; `NotAllowedError` / `NotSupportedError` rejections surfaced as the hook's error string): https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play
- Autoplay guide (muted video + user-gesture start, why the clip plays without prompts): https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
- `HTMLMediaElement.src` / `load()` (clean detach on stop: `removeAttribute("src")` then `load()`): https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/src and https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/load
- `drawImage()` from a video element (`readyState >= 2` guard, `videoWidth`/`videoHeight` sizing, unchanged for file playback): https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage

### SAM adapter (`lib/perception/sam.ts`, `/api/identify`)

Full notes and the pinned model version: `docs/references-practice-sam.md` (verified via WebFetch 2026-07-24).

- Replicate HTTP API (`POST /v1/predictions` with a pinned `version`, `Authorization: Bearer`, `Prefer: wait=n` sync mode, poll `GET /v1/predictions/{id}`): https://replicate.com/docs/reference/http
- meta/sam-2 versioned schema (input `{image, points_per_side, pred_iou_thresh, stability_score_thresh, use_m2m}`, output `{combined_mask, individual_masks}` PNG URIs): https://replicate.com/meta/sam-2/versions/cbd95fb76192174268b6b303aeeb7a736e8dab0cbc38177f09db79b2299da30b/api
- Replicate file inputs (data-URI form recommended under 1MB; frames sent as JPEG data URIs): https://replicate.com/docs/topics/predictions/input-files
