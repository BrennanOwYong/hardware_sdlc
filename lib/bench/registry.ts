// Bench registry: merges live board discovery with what Forge already knows
// (the newest commit's firmware + netlist) into DeviceCards, and persists the
// session's device memory in data/bench.json so a board that vanishes flips
// to "unplugged" instead of silently disappearing.
//
// Server-only (fs + child_process via ./cli). Reads commits through the vcs
// store (read-only).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BenchStatus, DeviceCard } from "@/lib/types";
import { getStore } from "@/lib/vcs/store";
import { GUIDANCE } from "./guidance";
import { boardList, cliInfo, isWindowsBinary, isWsl } from "./cli";
import { derivePeripherals, detectedToDeviceCards, mergeDevices } from "./parse";

const SESSION_FILE = join(process.cwd(), "data", "bench.json");

interface SessionFile {
  devices: DeviceCard[];
}

function isDeviceCard(v: unknown): v is DeviceCard {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.boardName === "string" &&
    (d.fqbn === null || typeof d.fqbn === "string") &&
    (d.port === null || typeof d.port === "string") &&
    (d.transport === "usb" || d.transport === "wifi-ota") &&
    (d.status === "awake" || d.status === "quiet" || d.status === "unplugged") &&
    (d.lastSeen === null || typeof d.lastSeen === "string") &&
    (d.firmwareHash === null || typeof d.firmwareHash === "string") &&
    Array.isArray(d.peripherals)
  );
}

async function loadSession(): Promise<SessionFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).devices) &&
      ((parsed as { devices: unknown[] }).devices as unknown[]).every(isDeviceCard)
    ) {
      return parsed as SessionFile;
    }
  } catch {
    // missing or unreadable: start a fresh session
  }
  return { devices: [] };
}

async function saveSession(file: SessionFile): Promise<void> {
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(file, null, 2), "utf8");
}

// One write at a time; each refresh re-reads the file first (vcs store pattern).
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * One full bench snapshot: CLI health, fresh board scan, session merge, and
 * knowledge enrichment (newest commit's firmware hash + its netlist's
 * peripherals attached to every card).
 */
export function refreshBench(): Promise<BenchStatus> {
  return enqueue(async () => {
    const info = await cliInfo();
    if (!info.available) {
      return {
        cliAvailable: false,
        cliPath: null,
        coreInstalled: false,
        devices: [],
        note: GUIDANCE["no-cli"],
      };
    }

    const session = await loadSession();
    let scanned: DeviceCard[] = [];
    let scanFailed = false;
    try {
      scanned = detectedToDeviceCards(await boardList(), new Date().toISOString());
    } catch {
      scanFailed = true;
    }
    const merged = mergeDevices(session.devices, scanned);

    // Knowledge enrichment: the newest commit tells us what firmware the last
    // flash would carry and which peripherals its netlist wires to UNO pins.
    let firmwareHash: string | null = null;
    let peripherals: DeviceCard["peripherals"] = [];
    try {
      const commits = await getStore().list();
      const head = commits[commits.length - 1];
      if (head) {
        firmwareHash = head.firmware.hash;
        peripherals = derivePeripherals(head.netlist);
      }
    } catch {
      // commit store unreadable: cards simply carry no firmware knowledge
    }
    const devices = merged.map((d) => ({ ...d, firmwareHash, peripherals }));

    await saveSession({ devices });

    const anyAwake = devices.some((d) => d.status === "awake");
    let note: string | undefined;
    if (scanFailed) {
      note = "The flashing tool answered but the port scan failed. Unplug and replug the board, then try again.";
    } else if (!anyAwake) {
      if (isWsl() && !isWindowsBinary()) {
        note = GUIDANCE["wsl-linux-binary"];
      } else if (devices.length > 0) {
        note = GUIDANCE["board-gone"];
      } else {
        note = GUIDANCE["no-board"];
      }
    } else if (!info.coreInstalled) {
      note = GUIDANCE["core-missing"];
    }

    return {
      cliAvailable: true,
      cliPath: info.path,
      coreInstalled: info.coreInstalled,
      devices,
      ...(note !== undefined ? { note } : {}),
    };
  });
}

/** The device a flash should target: first awake card, optionally by id. */
export function pickTarget(
  status: BenchStatus,
  deviceId?: string,
): DeviceCard | undefined {
  const awake = status.devices.filter((d) => d.status === "awake" && d.port !== null);
  if (deviceId !== undefined) return awake.find((d) => d.id === deviceId);
  return awake[0];
}
