// arduino-cli wrapper. Server-only (node builtins + child_process).
//
// Binary resolution order: ARDUINO_CLI_PATH env var, then `arduino-cli` on
// PATH, then <app>/bin/arduino-cli (the target of the official install
// script), then <app>/bin/arduino-cli.exe. A Windows .exe reached through WSL
// interop is fully supported: it sees COM ports, and every path handed to it
// is translated with `wslpath -w` first.
//
// Command flags and JSON shapes verified against the official docs and a
// local probe of arduino-cli 1.5.1; deep links in
// docs/references-delta-bench.md.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  boardListSchema,
  coreListSchema,
  versionSchema,
  type BoardListJson,
} from "./parse";

const execFileP = promisify(execFile);

const FQBN_UNO = "arduino:avr:uno";

// Slow Windows mount + first-time AVR builds: keep these generous.
const VERSION_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 30_000;
const CORE_LIST_TIMEOUT_MS = 60_000;
const COMPILE_TIMEOUT_MS = 300_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export interface CliInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  coreInstalled: boolean;
}

interface ResolvedCli {
  path: string;
  version: string;
  /** True when the binary is a Windows .exe reached through WSL interop. */
  windows: boolean;
}

// --- environment -------------------------------------------------------------

let wslCached: boolean | null = null;

/** True when this server runs inside WSL (matters for USB visibility). */
export function isWsl(): boolean {
  if (wslCached !== null) return wslCached;
  if (process.env.WSL_DISTRO_NAME) {
    wslCached = true;
    return true;
  }
  try {
    wslCached = readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    wslCached = false;
  }
  return wslCached;
}

// --- binary resolution -------------------------------------------------------

let resolved: ResolvedCli | null = null;
let lastResolveFailure = 0;
const RESOLVE_RETRY_MS = 10_000;

function candidates(): string[] {
  const list: string[] = [];
  if (process.env.ARDUINO_CLI_PATH) list.push(process.env.ARDUINO_CLI_PATH);
  list.push("arduino-cli");
  list.push(join(process.cwd(), "bin", "arduino-cli"));
  list.push(join(process.cwd(), "bin", "arduino-cli.exe"));
  return list;
}

async function probeCandidate(path: string): Promise<ResolvedCli | null> {
  try {
    const { stdout } = await execFileP(path, ["version", "--json"], {
      timeout: VERSION_TIMEOUT_MS,
    });
    const parsed = versionSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;
    return {
      path,
      version: parsed.data.VersionString,
      windows: path.toLowerCase().endsWith(".exe"),
    };
  } catch {
    return null;
  }
}

async function resolveCli(): Promise<ResolvedCli | null> {
  if (resolved) {
    // Re-verify the cached binary still answers; drop the cache when it dies.
    const alive = await probeCandidate(resolved.path);
    if (alive) return resolved;
    resolved = null;
  }
  const now = Date.now();
  if (now - lastResolveFailure < RESOLVE_RETRY_MS) return null;
  for (const c of candidates()) {
    const hit = await probeCandidate(c);
    if (hit) {
      resolved = hit;
      return hit;
    }
  }
  lastResolveFailure = now;
  return null;
}

/** True when the resolved binary is a Windows .exe (COM ports, Windows paths). */
export function isWindowsBinary(): boolean {
  return resolved?.windows ?? false;
}

/** Translates a WSL path for the CLI when it is a Windows .exe. */
async function toCliPath(p: string, cli: ResolvedCli): Promise<string> {
  if (!cli.windows) return p;
  const { stdout } = await execFileP("wslpath", ["-w", p], { timeout: 10_000 });
  return stdout.trim();
}

// --- public surface ----------------------------------------------------------

let coreCache: { value: boolean; at: number } | null = null;
const CORE_CACHE_MS = 60_000;

async function checkCoreInstalled(cli: ResolvedCli): Promise<boolean> {
  const now = Date.now();
  if (coreCache && now - coreCache.at < CORE_CACHE_MS) return coreCache.value;
  try {
    const { stdout } = await execFileP(cli.path, ["core", "list", "--json"], {
      timeout: CORE_LIST_TIMEOUT_MS,
    });
    const parsed = coreListSchema.safeParse(JSON.parse(stdout));
    const value =
      parsed.success &&
      parsed.data.platforms.some(
        (p) => p.id === "arduino:avr" && p.installed_version !== undefined,
      );
    coreCache = { value, at: now };
    return value;
  } catch {
    return false;
  }
}

export async function cliInfo(): Promise<CliInfo> {
  const cli = await resolveCli();
  if (!cli) return { available: false, path: null, version: null, coreInstalled: false };
  return {
    available: true,
    path: cli.path,
    version: cli.version,
    coreInstalled: await checkCoreInstalled(cli),
  };
}

/** Fresh `board list --json`, zod-parsed. Throws when the CLI is missing. */
export async function boardList(): Promise<BoardListJson> {
  const cli = await resolveCli();
  if (!cli) throw new Error("arduino-cli is not available");
  const { stdout } = await execFileP(cli.path, ["board", "list", "--json"], {
    timeout: LIST_TIMEOUT_MS,
  });
  return boardListSchema.parse(JSON.parse(stdout));
}

// --- compile / upload / serial ----------------------------------------------

export interface StageOutcome {
  ok: boolean;
  output: string;
}

export interface CompileOutcome extends StageOutcome {
  /** Kept for a follow-up upload (`--input-dir`). Caller cleans up. */
  sketchDir: string;
  buildPath: string;
}

function describeExecError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const parts = [e.stdout, e.stderr, e.message].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (parts.length > 0) return parts.join("\n");
  }
  return String(err);
}

/**
 * Writes `code` as a sketch and compiles it for the UNO. Sketch + build land
 * under data/bench-scratch (on the Windows-visible mount, so a Windows .exe
 * CLI can read them too). Call `cleanupSketch` when done.
 */
export async function compileSketch(code: string, fqbn: string = FQBN_UNO): Promise<CompileOutcome> {
  const cli = await resolveCli();
  if (!cli) throw new Error("arduino-cli is not available");

  const scratchRoot = join(process.cwd(), "data", "bench-scratch");
  await mkdir(scratchRoot, { recursive: true });
  const sketchDir = join(await mkdtemp(join(scratchRoot, "sketch-")), "forge_sketch");
  await mkdir(sketchDir, { recursive: true });
  await writeFile(join(sketchDir, "forge_sketch.ino"), code, "utf8");
  const buildPath = join(sketchDir, "build");

  try {
    const { stdout, stderr } = await execFileP(
      cli.path,
      [
        "compile",
        "--fqbn",
        fqbn,
        "--build-path",
        await toCliPath(buildPath, cli),
        await toCliPath(sketchDir, cli),
      ],
      { timeout: COMPILE_TIMEOUT_MS },
    );
    return { ok: true, output: `${stdout}${stderr}`.trim(), sketchDir, buildPath };
  } catch (err) {
    return { ok: false, output: describeExecError(err), sketchDir, buildPath };
  }
}

/** Uploads a previously compiled build to a port. */
export async function uploadSketch(
  compiled: CompileOutcome,
  port: string,
  fqbn: string = FQBN_UNO,
): Promise<StageOutcome> {
  const cli = await resolveCli();
  if (!cli) throw new Error("arduino-cli is not available");
  try {
    const { stdout, stderr } = await execFileP(
      cli.path,
      [
        "upload",
        "--fqbn",
        fqbn,
        "--port",
        port,
        "--input-dir",
        await toCliPath(compiled.buildPath, cli),
        await toCliPath(compiled.sketchDir, cli),
      ],
      { timeout: UPLOAD_TIMEOUT_MS },
    );
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err) {
    return { ok: false, output: describeExecError(err) };
  }
}

/** Removes the temp sketch dir a compile created. Never throws. */
export async function cleanupSketch(compiled: CompileOutcome): Promise<void> {
  try {
    await rm(join(compiled.sketchDir, ".."), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Reads one line from the board's serial port via `arduino-cli monitor`.
 * The monitor has no exit-after-timeout flag (see the docs reference), so the
 * process is spawned, stdout is read until the first newline, and it is
 * killed after `timeoutMs` either way.
 */
export function readSerialLine(
  port: string,
  baudrate = 9600,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; line: string }> {
  return new Promise((resolvePromise) => {
    const cli = resolved;
    if (!cli) {
      resolvePromise({ ok: false, line: "" });
      return;
    }
    const child = spawn(cli.path, [
      "monitor",
      "--port",
      port,
      "--config",
      `baudrate=${baudrate}`,
      "--quiet",
    ]);
    let buffer = "";
    let settled = false;
    const finish = (ok: boolean, line: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolvePromise({ ok, line });
    };
    const timer = setTimeout(() => finish(false, buffer.trim()), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) finish(true, buffer.slice(0, nl).trim());
    });
    child.on("error", () => finish(false, ""));
    child.on("exit", () => finish(buffer.trim().length > 0, buffer.trim()));
  });
}
