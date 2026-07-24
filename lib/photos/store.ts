// Photo library: JSON-index + JPEG-file store. Server-only (node builtins).
// Every write funnels through an in-process promise queue so concurrent API
// calls cannot interleave read-modify-write cycles on the index.json (same
// pattern as lib/vcs/store.ts). Image bytes live in the unified storage root
// at data/images/user/<id>.jpg and are streamed by app/api/photos/[id]/file —
// never from public/, which is snapshotted at build time in production. The
// pre-unification location data/photos/ is migrated across once, on first
// store use. Docs: docs/references-photolib.md, docs/references-storage.md.

import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Inventory, PartDetection } from "../types";

/** Newest photos kept; the oldest is evicted (index entry + jpg) past this. */
export const MAX_PHOTOS = 50;
/** Decoded image byte cap for one photo. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Data-URL media types the store accepts (the client rasterizes to JPEG). */
export const PHOTO_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type PhotoMediaType = (typeof PHOTO_MEDIA_TYPES)[number];

/** Which page captured this photo. Defaults to "inventory" for older records
 *  written before the tag existed, so history stays valid across the upgrade. */
export type CaptureSurface = "inventory" | "coach";

/** The processing output of a coaching photo, kept so a past attempt can be
 *  reopened with its arrow and highlight intact instead of re-shot. */
export interface CoachCapture {
  goal: string;
  verdict: string;
  instruction: string;
  /** Mask-anchored guidance geometry, target mask included. Shape mirrors
   *  lib/coach/geometry.ts PreciseGuide; kept structural to avoid importing
   *  SDK-adjacent modules into this node-tested store. */
  guide?: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    source: "mask" | "model";
    targetMaskPng?: string;
    targetBbox?: number[];
    note: string;
  };
}

export interface PhotoEntry {
  id: string;
  /** ISO timestamp of capture (server clock at save time). */
  capturedAt: string;
  /** Decoded image size on disk. */
  bytes: number;
  width: number;
  height: number;
  /** Auto label, e.g. "Bench 14:05". */
  label: string;
  /** Media type of the stored bytes; the file route serves it verbatim. */
  mediaType: PhotoMediaType;
  /** Which surface captured it; absent on legacy records means "inventory". */
  surface?: CaptureSurface;
  /** Cached identification, if the client PATCHed one on. */
  inventory?: Inventory;
  /** Coach processing output, when this photo came from the coach page. */
  coach?: CoachCapture;
}

export interface AddPhotoInput {
  photoDataUrl: string;
  width: number;
  height: number;
  /** Which page captured it; defaults to inventory when omitted. */
  surface?: CaptureSurface;
  /** Override the auto "Bench HH:MM" label (coach uses the goal). */
  label?: string;
  /** Test hook; defaults to now. */
  capturedAt?: Date;
}

export class PhotoError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PhotoError";
    this.status = status;
  }
}

/** "Bench HH:MM" from a capture time (local clock). */
export function benchLabel(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `Bench ${hh}:${mm}`;
}

const DATA_URL_RE = /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Decodes a JPEG/PNG data URL to bytes. Throws PhotoError 400 on anything
 * that is not a base64 JPEG/PNG data URL, 413 past MAX_PHOTO_BYTES.
 */
export function decodePhotoDataUrl(dataUrl: string): {
  mediaType: PhotoMediaType;
  buffer: Buffer;
} {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m || !m[1] || !m[2] || m[2].length % 4 !== 0) {
    throw new PhotoError(
      "photoDataUrl must be a base64 data URL of type image/jpeg or image/png",
      400,
    );
  }
  const mediaType = m[1] as PhotoMediaType;
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.byteLength === 0) {
    throw new PhotoError("photoDataUrl carries no image bytes", 400);
  }
  if (buffer.byteLength > MAX_PHOTO_BYTES) {
    throw new PhotoError(
      `photo is ${buffer.byteLength} bytes; the cap is ${MAX_PHOTO_BYTES} (8 MB)`,
      413,
    );
  }
  return { mediaType, buffer };
}

// --- runtime shape guards (the index file on disk is untrusted input) --------

interface IndexFile {
  photos: PhotoEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPart(v: unknown): v is PartDetection {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.partType === "string" &&
    typeof v.label === "string" &&
    typeof v.confidence === "number" &&
    Array.isArray(v.bbox) &&
    v.bbox.length === 4 &&
    v.bbox.every((n) => typeof n === "number")
  );
}

function isInventory(v: unknown): v is Inventory {
  if (!isRecord(v)) return false;
  return (
    Array.isArray(v.parts) &&
    v.parts.every(isPart) &&
    typeof v.capturedAt === "string" &&
    (v.source === "mock" || v.source === "vlm") &&
    (v.photoDataUrl === undefined || typeof v.photoDataUrl === "string")
  );
}

function isMediaType(v: unknown): v is PhotoMediaType {
  return v === "image/jpeg" || v === "image/png";
}

function isEntry(v: unknown): v is PhotoEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.capturedAt === "string" &&
    typeof v.bytes === "number" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.label === "string" &&
    isMediaType(v.mediaType) &&
    (v.surface === undefined || v.surface === "inventory" || v.surface === "coach") &&
    (v.coach === undefined || isRecord(v.coach)) &&
    (v.inventory === undefined || isInventory(v.inventory))
  );
}

function isIndexFile(v: unknown): v is IndexFile {
  return isRecord(v) && Array.isArray(v.photos) && v.photos.every(isEntry);
}

// --- store -------------------------------------------------------------------

export class PhotoStore {
  private readonly dirPath: string;

  private readonly indexPath: string;

  /** Pre-unification directory (data/photos); migrated across on first use. */
  private readonly legacyDirPath: string | undefined;

  /** One migration attempt per instance; the work itself is idempotent. */
  private migrationAttempted = false;

  /** Serializes every operation; each link swallows the previous rejection. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dirPath: string, legacyDirPath?: string) {
    this.dirPath = dirPath;
    this.indexPath = join(dirPath, "index.json");
    this.legacyDirPath = legacyDirPath;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private filePathFor(id: string): string {
    return join(this.dirPath, `${id}.jpg`);
  }

  /**
   * One-time move of a pre-unification library (data/photos/*) into the
   * unified root (data/images/user/). Runs inside the queue before the
   * first index read. Idempotent: files already present at the destination
   * win (a later run must never clobber newer data), moved sources are
   * removed, and once the legacy directory is gone every later call is a
   * cheap ENOENT. Failures are swallowed — the store keeps working on the
   * new directory and the untouched legacy files survive for a retry after
   * a restart.
   */
  private async migrateLegacyDir(): Promise<void> {
    if (this.migrationAttempted || !this.legacyDirPath) return;
    this.migrationAttempted = true;
    let names: string[];
    try {
      names = await readdir(this.legacyDirPath);
    } catch {
      return; // No legacy directory: nothing to migrate.
    }
    try {
      await mkdir(this.dirPath, { recursive: true });
      for (const name of names) {
        const src = join(this.legacyDirPath, name);
        const dest = join(this.dirPath, name);
        const destExists = await access(dest).then(
          () => true,
          () => false,
        );
        if (destExists) {
          await rm(src, { force: true });
          continue;
        }
        try {
          await rename(src, dest);
        } catch {
          // Cross-device fallback.
          await copyFile(src, dest);
          await rm(src, { force: true });
        }
      }
      await rm(this.legacyDirPath, { recursive: true, force: true });
    } catch {
      // Leave whatever remains in place; a later restart retries.
    }
  }

  /** Reads the index; a missing or unparseable file means an empty library. */
  private async load(): Promise<IndexFile> {
    await this.migrateLegacyDir();
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isIndexFile(parsed)) return parsed;
    } catch {
      // Missing or corrupt index: start empty.
    }
    return { photos: [] };
  }

  private async save(file: IndexFile): Promise<void> {
    await mkdir(this.dirPath, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(file, null, 2), "utf8");
  }

  /** All photos, newest first. */
  list(): Promise<PhotoEntry[]> {
    return this.enqueue(async () => [...(await this.load()).photos].reverse());
  }

  get(id: string): Promise<PhotoEntry | undefined> {
    return this.enqueue(async () =>
      (await this.load()).photos.find((p) => p.id === id),
    );
  }

  /**
   * Decodes the data URL, writes <id>.jpg, appends the index entry, and
   * evicts the oldest photos (entry + jpg) past MAX_PHOTOS.
   */
  add(input: AddPhotoInput): Promise<PhotoEntry> {
    const { mediaType, buffer } = decodePhotoDataUrl(input.photoDataUrl);
    return this.enqueue(async () => {
      const file = await this.load();
      const at = input.capturedAt ?? new Date();
      const entry: PhotoEntry = {
        id: randomUUID(),
        capturedAt: at.toISOString(),
        bytes: buffer.byteLength,
        width: input.width,
        height: input.height,
        label: input.label ?? benchLabel(at),
        mediaType,
        ...(input.surface ? { surface: input.surface } : {}),
      };
      await mkdir(this.dirPath, { recursive: true });
      await writeFile(this.filePathFor(entry.id), buffer);
      file.photos.push(entry);
      while (file.photos.length > MAX_PHOTOS) {
        const oldest = file.photos.shift();
        if (oldest) {
          await rm(this.filePathFor(oldest.id), { force: true });
        }
      }
      await this.save(file);
      return entry;
    });
  }

  /**
   * Caches an identification on a photo. Only the inventory's own
   * photoDataUrl is dropped: the jpg on disk is the image, and duplicating
   * megabytes of base64 into index.json would bloat every index read. Every
   * other field — including additions like per-part maskPng — passes
   * through untouched.
   */
  setInventory(id: string, inventory: Inventory): Promise<PhotoEntry> {
    return this.enqueue(async () => {
      const file = await this.load();
      const entry = file.photos.find((p) => p.id === id);
      if (!entry) {
        throw new PhotoError(`photo ${id} not found`, 404);
      }
      const { photoDataUrl: _photoDataUrl, ...rest } = inventory;
      entry.inventory = rest;
      await this.save(file);
      return entry;
    });
  }

  /** Attaches a coaching result to a photo, so a past attempt reopens with its
   *  arrow and highlight intact instead of being re-shot. */
  setCoach(id: string, coach: CoachCapture): Promise<PhotoEntry> {
    return this.enqueue(async () => {
      const file = await this.load();
      const entry = file.photos.find((p) => p.id === id);
      if (!entry) {
        throw new PhotoError(`photo ${id} not found`, 404);
      }
      entry.surface = "coach";
      entry.coach = coach;
      await this.save(file);
      return entry;
    });
  }

  /** Deletes the index entry and its jpg. Missing id -> PhotoError 404. */
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const file = await this.load();
      const idx = file.photos.findIndex((p) => p.id === id);
      if (idx < 0) {
        throw new PhotoError(`photo ${id} not found`, 404);
      }
      file.photos.splice(idx, 1);
      await rm(this.filePathFor(id), { force: true });
      await this.save(file);
    });
  }

  /**
   * Bytes + media type for streaming. Undefined when the id is unknown or
   * the jpg vanished from disk (index and file drifted).
   */
  readImage(
    id: string,
  ): Promise<{ buffer: Buffer; mediaType: PhotoMediaType } | undefined> {
    return this.enqueue(async () => {
      const entry = (await this.load()).photos.find((p) => p.id === id);
      if (!entry) return undefined;
      try {
        const buffer = await readFile(this.filePathFor(id));
        return { buffer, mediaType: entry.mediaType };
      } catch {
        return undefined;
      }
    });
  }
}

// Default store used by the API routes. Next.js dev hot-reload can create a
// fresh module instance (and thus a fresh queue); acceptable because every
// operation re-reads the index before writing.
let defaultStore: PhotoStore | undefined;

export function getPhotoStore(): PhotoStore {
  if (!defaultStore) {
    defaultStore = new PhotoStore(
      join(process.cwd(), "data", "images", "user"),
      join(process.cwd(), "data", "photos"),
    );
  }
  return defaultStore;
}
