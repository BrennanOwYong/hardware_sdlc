// Build journal (FEEDBACK 13): JSON-file store of pending journal entries.
// Server-only (node builtins). Every write funnels through an in-process
// promise queue so concurrent API calls cannot interleave read-modify-write
// cycles on data/journal/pending.json (same pattern as lib/vcs/store.ts).
//
// Lifecycle: coach steps and flash events append here; POST /api/commits
// drains the pending list into the new commit's `journal` field, so every
// entry ends up attached to the next commit after it happened.
//
// Frames (annotated coach photos) are written to data/images/journal/<id>.jpg
// (or .png), inside the unified storage root that GET /api/images/[...path]
// streams from. `framePath` on the entry is relative to that root, so the
// client renders it via /api/images/<framePath>.
//
// Runtime imports stay limited to node builtins so tests/journal.test.mjs can
// load this file directly under node --test via type stripping (type-only
// cross-file imports are erased at runtime).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JournalEntry } from "../types";

/** Decoded frame byte cap, mirroring the photo library's 8 MB limit. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface AppendJournalInput {
  kind: JournalEntry["kind"];
  summary: string;
  detail?: string;
  goal?: string;
  attempt?: string;
  verdict?: string;
  firmwareHash?: string;
  /** base64 data URL (image/jpeg or image/png); saved as the entry's frame. */
  frameDataUrl?: string;
}

export class JournalError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "JournalError";
    this.status = status;
  }
}

// Same accepted shapes as lib/photos/store.ts. Duplicated here because a
// runtime import of ../photos/store would need a .ts extension Node accepts
// and tsc rejects; this module must stay loadable under plain node --test.
const DATA_URL_RE = /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Decodes a JPEG/PNG data URL. Throws JournalError 400/413 on bad input. */
export function decodeFrameDataUrl(dataUrl: string): {
  extension: "jpg" | "png";
  buffer: Buffer;
} {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m || !m[1] || !m[2] || m[2].length % 4 !== 0) {
    throw new JournalError(
      "frameDataUrl must be a base64 data URL of type image/jpeg or image/png",
      400,
    );
  }
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.byteLength === 0) {
    throw new JournalError("frameDataUrl carries no image bytes", 400);
  }
  if (buffer.byteLength > MAX_FRAME_BYTES) {
    throw new JournalError(
      `frame is ${buffer.byteLength} bytes; the cap is ${MAX_FRAME_BYTES} (8 MB)`,
      413,
    );
  }
  return { extension: m[1] === "image/png" ? "png" : "jpg", buffer };
}

// --- runtime shape guards (the file on disk is untrusted input) --------------

interface PendingFile {
  entries: JournalEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function optionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

export function isJournalEntry(v: unknown): v is JournalEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.at === "string" &&
    (v.kind === "coach" || v.kind === "flash") &&
    typeof v.summary === "string" &&
    optionalString(v.detail) &&
    optionalString(v.framePath) &&
    optionalString(v.goal) &&
    optionalString(v.attempt) &&
    optionalString(v.verdict) &&
    optionalString(v.firmwareHash)
  );
}

function isPendingFile(v: unknown): v is PendingFile {
  return isRecord(v) && Array.isArray(v.entries) && v.entries.every(isJournalEntry);
}

// --- store -------------------------------------------------------------------

export class JournalStore {
  private readonly filePath: string;

  private readonly framesDir: string;

  /** framePath prefix (relative to the images root) for saved frames. */
  private readonly frameSubdir: string;

  /** Serializes every operation; each link swallows the previous rejection. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, framesDir: string, frameSubdir = "journal") {
    this.filePath = filePath;
    this.framesDir = framesDir;
    this.frameSubdir = frameSubdir;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reads the file; missing or unparseable means an empty pending list. */
  private async load(): Promise<PendingFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isPendingFile(parsed)) return parsed;
    } catch {
      // Missing or corrupt file: start empty.
    }
    return { entries: [] };
  }

  private async save(file: PendingFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), "utf8");
  }

  /**
   * Appends one pending entry (id + timestamp assigned here). A frameDataUrl
   * is decoded and written to <framesDir>/<id>.jpg|.png before the index
   * write, and the entry carries framePath relative to the images root.
   */
  appendPending(input: AppendJournalInput): Promise<JournalEntry> {
    return this.enqueue(async () => {
      // Decode inside the queue so a bad frame rejects the returned promise
      // instead of throwing synchronously out of appendPending.
      const frame =
        input.frameDataUrl !== undefined
          ? decodeFrameDataUrl(input.frameDataUrl)
          : undefined;
      const file = await this.load();
      const id = randomUUID();
      const entry: JournalEntry = {
        id,
        at: new Date().toISOString(),
        kind: input.kind,
        summary: input.summary,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
        ...(input.firmwareHash !== undefined ? { firmwareHash: input.firmwareHash } : {}),
      };
      if (frame) {
        const name = `${id}.${frame.extension}`;
        await mkdir(this.framesDir, { recursive: true });
        await writeFile(join(this.framesDir, name), frame.buffer);
        entry.framePath = `${this.frameSubdir}/${name}`;
      }
      file.entries.push(entry);
      await this.save(file);
      return entry;
    });
  }

  /** Pending entries in append order. */
  listPending(): Promise<JournalEntry[]> {
    return this.enqueue(async () => (await this.load()).entries);
  }

  /** Returns all pending entries and clears the file, atomically in-queue. */
  drainPending(): Promise<JournalEntry[]> {
    return this.enqueue(async () => {
      const file = await this.load();
      if (file.entries.length === 0) return [];
      const drained = file.entries;
      await this.save({ entries: [] });
      return drained;
    });
  }

  /**
   * Puts already-drained entries back at the front of the pending list,
   * preserving ids and timestamps. Used when a commit fails after draining
   * so journal entries are never lost to a rejected commit.
   */
  restorePending(entries: JournalEntry[]): Promise<void> {
    return this.enqueue(async () => {
      if (entries.length === 0) return;
      const file = await this.load();
      await this.save({ entries: [...entries, ...file.entries] });
    });
  }

  /** Deletes the frame files of the given entries (best effort, for tests). */
  async removeFrames(entries: JournalEntry[]): Promise<void> {
    for (const e of entries) {
      if (!e.framePath) continue;
      const name = e.framePath.split("/").pop();
      if (!name) continue;
      await rm(join(this.framesDir, name), { force: true });
    }
  }
}

// Default store used by the API routes. Next.js dev hot-reload can create a
// fresh module instance (and thus a fresh queue); acceptable because every
// operation re-reads the file before writing.
let defaultStore: JournalStore | undefined;

export function getJournalStore(): JournalStore {
  if (!defaultStore) {
    defaultStore = new JournalStore(
      join(process.cwd(), "data", "journal", "pending.json"),
      join(process.cwd(), "data", "images", "journal"),
    );
  }
  return defaultStore;
}
