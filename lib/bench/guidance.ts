// Beginner-facing guidance strings for the bench. Pure module: no imports, so
// tests/bench.test.mjs can load it directly through Node's type stripping.
//
// Every string assumes the reader has never touched hardware. Plain words,
// no jargon, always a next action.

export type GuidanceKey =
  | "no-cli"
  | "no-board"
  | "board-gone"
  | "port-busy"
  | "power-only-cable"
  | "wsl-linux-binary"
  | "core-missing"
  | "compile-failed"
  | "upload-failed"
  | "no-hello";

export const GUIDANCE: Record<GuidanceKey, string> = {
  "no-cli":
    "The flashing tool is not installed on this laptop yet. See README > Flashing setup.",
  "no-board":
    "I cannot see a board. Plug the flat end of the USB cable into the laptop and the other end into your Arduino.",
  "board-gone": "The board went quiet. Check the cable is fully seated.",
  "port-busy":
    "Something else is talking to the board. Close other Arduino windows and try again.",
  "power-only-cable":
    "Some cables carry power only. Try a different cable - one from a printer or external drive usually works. Cheap boards may also need the CH340 driver.",
  "wsl-linux-binary":
    "This server runs in WSL, which cannot see USB ports by itself. Either point ARDUINO_CLI_PATH at a Windows arduino-cli.exe, or bridge the port with usbipd-win. See README > Flashing setup.",
  "core-missing":
    "The flashing tool is installed but the Arduino Uno support files are missing. See README > Flashing setup for the one-line install command.",
  "compile-failed":
    "The code did not compile, so nothing was sent to the board. The details above show the compiler's complaint - the board is untouched and safe.",
  "upload-failed":
    "Compiling worked but sending it to the board failed. Check the cable is fully seated, then try again.",
  "no-hello":
    "The code was sent, but the board did not say hello back over the cable. It may still be running fine - watch its lights.",
};

/** Context the guidance picker classifies. All fields optional on purpose. */
export interface GuidanceContext {
  /** Which stage failed. */
  stage: "compile" | "upload" | "handshake";
  /** Raw stdout+stderr from arduino-cli for the failed stage. */
  output?: string;
  /** True when a board was visible earlier in this session but is not now. */
  boardWasSeen?: boolean;
  /** True when no board is visible at all. */
  noBoard?: boolean;
}

/**
 * Picks the most helpful guidance string for a failure. Classification order:
 * specific port problems first (busy/permission, vanished device), then the
 * board-visibility states, then the generic per-stage fallback.
 */
export function pickGuidance(ctx: GuidanceContext): string {
  const out = (ctx.output ?? "").toLowerCase();
  if (ctx.stage === "upload" || ctx.stage === "handshake") {
    if (
      out.includes("resource busy") ||
      out.includes("permission denied") ||
      out.includes("access is denied") ||
      out.includes("in use")
    ) {
      return GUIDANCE["port-busy"];
    }
    if (
      out.includes("no such file or directory") ||
      out.includes("can't open device") ||
      out.includes("cannot open") ||
      out.includes("not found")
    ) {
      return GUIDANCE["board-gone"];
    }
  }
  if (ctx.noBoard === true) {
    return ctx.boardWasSeen === true ? GUIDANCE["board-gone"] : GUIDANCE["no-board"];
  }
  if (ctx.stage === "compile") return GUIDANCE["compile-failed"];
  if (ctx.stage === "upload") return GUIDANCE["upload-failed"];
  return GUIDANCE["no-hello"];
}
