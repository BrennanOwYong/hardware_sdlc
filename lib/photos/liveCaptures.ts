// Live-view capture store: when the user snapshots a live hunt, the client
// posts the recorded clip (optional), the raw frame, the results overlay
// PNG, and the query. Files land side by side in data/images/live-view/
// (<id>.webm|mp4, <id>-frame.jpg, <id>-results.png, <id>.json) and stream
// back through GET /api/images/live-view/<name>. Same serialization pattern
// as lib/photos/store.ts: one in-process promise queue per store.
//
// Runtime imports stay limited to zod + node builtins so
// tests/livecaptures.test.mjs can run this file directly under node --test
// via type stripping. Docs: docs/references-storage.md.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** Decoded clip byte cap (30 MB). */
export const MAX_CLIP_BYTES = 30 * 1024 * 1024;
/** Decoded frame / results-image byte cap (mirrors the photo library). */
export const MAX_STILL_BYTES = 8 * 1024 * 1024;

export const CLIP_MIMES = ["video/webm", "video/mp4"] as const;
export type ClipMime = (typeof CLIP_MIMES)[number];
const CLIP_EXT: Record<ClipMime, "webm" | "mp4"> = {
  "video/webm": "webm",
  "video/mp4": "mp4",
};

/** URL prefix the images route serves data/images/live-view/ under. */
export const LIVE_VIEW_URL_BASE = "/api/images/live-view";

/** POST /api/live-captures request body. */
export const liveCaptureRequestSchema = z
  .object({
    /** Bare base64 of the recorded clip (webm or mp4), <= 30 MB decoded. */
    clipBase64: z.string().min(1).optional(),
    /** Required alongside clipBase64; names the clip container. */
    clipMime: z.enum(CLIP_MIMES).optional(),
    /** data:image/jpeg;base64 still of the captured frame. */
    frameDataUrl: z.string().min(1),
    /** data:image/png;base64 render of the results overlay. */
    resultsPngDataUrl: z.string().min(1),
    /** The hunt query active at capture time. */
    query: z.string().max(500),
    /** ISO timestamp of the capture on the client clock. */
    capturedAt: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "capturedAt must be a parseable date string (ISO 8601)",
      }),
  })
  .refine((v) => (v.clipBase64 === undefined) === (v.clipMime === undefined), {
    message: "clipBase64 and clipMime must be sent together or not at all",
    path: ["clipMime"],
  });
export type LiveCaptureRequest = z.infer<typeof liveCaptureRequestSchema>;

/** Saved file URLs, all under /api/images/live-view/. */
export const liveCaptureFilesSchema = z.object({
  clip: z.string().optional(),
  frame: z.string(),
  results: z.string(),
  meta: z.string(),
});

/** One capture's metadata: API list shape == <id>.json shape on disk. */
export const liveCaptureMetaSchema = z.object({
  id: z.string().min(1),
  query: z.string(),
  capturedAt: z.string(),
  savedAt: z.string(),
  clipMime: z.enum(CLIP_MIMES).optional(),
  clipBytes: z.number().int().nonnegative().optional(),
  files: liveCaptureFilesSchema,
});
export type LiveCaptureMeta = z.infer<typeof liveCaptureMetaSchema>;

/** GET /api/live-captures -> { captures } newest first. */
export const liveCaptureListResponseSchema = z.object({
  captures: z.array(liveCaptureMetaSchema),
  note: z.string().optional(),
});

/** POST /api/live-captures -> { id, files }. */
export const liveCaptureCreateResponseSchema = z.object({
  id: z.string(),
  files: liveCaptureFilesSchema,
});

export class LiveCaptureError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LiveCaptureError";
    this.status = status;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(
  value: string,
  what: string,
  cap: number,
  capNote: string,
): Buffer {
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    throw new LiveCaptureError(`${what} must be bare base64`, 400);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.byteLength === 0) {
    throw new LiveCaptureError(`${what} carries no bytes`, 400);
  }
  if (buffer.byteLength > cap) {
    throw new LiveCaptureError(
      `${what} is ${buffer.byteLength} bytes; the cap is ${cap} (${capNote})`,
      413,
    );
  }
  return buffer;
}

function decodeStillDataUrl(
  value: string,
  what: string,
  mediaType: "image/jpeg" | "image/png",
): Buffer {
  const prefix = `data:${mediaType};base64,`;
  if (!value.startsWith(prefix)) {
    throw new LiveCaptureError(
      `${what} must be a base64 data URL of type ${mediaType}`,
      400,
    );
  }
  return decodeBase64(value.slice(prefix.length), what, MAX_STILL_BYTES, "8 MB");
}

// --- store -------------------------------------------------------------------

export class LiveCaptureStore {
  private readonly dirPath: string;

  /** Serializes every operation; each link swallows the previous rejection. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dirPath: string) {
    this.dirPath = dirPath;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Decodes and writes all artifacts for one capture, the <id>.json
   * metadata last so a half-written capture never appears in list().
   * Rejects with LiveCaptureError 400/413 before touching disk.
   */
  save(input: LiveCaptureRequest, savedAt?: Date): Promise<LiveCaptureMeta> {
    return this.enqueue(async () => {
      const frame = decodeStillDataUrl(
        input.frameDataUrl,
        "frameDataUrl",
        "image/jpeg",
      );
      const results = decodeStillDataUrl(
        input.resultsPngDataUrl,
        "resultsPngDataUrl",
        "image/png",
      );
      let clip: { buffer: Buffer; mime: ClipMime } | undefined;
      if (input.clipBase64 !== undefined) {
        if (input.clipMime === undefined) {
          // The zod refine rejects this earlier; direct callers get the same 400.
          throw new LiveCaptureError("clipMime is required with clipBase64", 400);
        }
        clip = {
          buffer: decodeBase64(
            input.clipBase64,
            "clipBase64",
            MAX_CLIP_BYTES,
            "30 MB",
          ),
          mime: input.clipMime,
        };
      }
      const id = randomUUID();
      const clipName = clip ? `${id}.${CLIP_EXT[clip.mime]}` : undefined;
      const frameName = `${id}-frame.jpg`;
      const resultsName = `${id}-results.png`;
      const metaName = `${id}.json`;
      const meta: LiveCaptureMeta = {
        id,
        query: input.query,
        capturedAt: input.capturedAt,
        savedAt: (savedAt ?? new Date()).toISOString(),
        ...(clip
          ? { clipMime: clip.mime, clipBytes: clip.buffer.byteLength }
          : {}),
        files: {
          ...(clipName ? { clip: `${LIVE_VIEW_URL_BASE}/${clipName}` } : {}),
          frame: `${LIVE_VIEW_URL_BASE}/${frameName}`,
          results: `${LIVE_VIEW_URL_BASE}/${resultsName}`,
          meta: `${LIVE_VIEW_URL_BASE}/${metaName}`,
        },
      };
      await mkdir(this.dirPath, { recursive: true });
      if (clip && clipName) {
        await writeFile(join(this.dirPath, clipName), clip.buffer);
      }
      await writeFile(join(this.dirPath, frameName), frame);
      await writeFile(join(this.dirPath, resultsName), results);
      await writeFile(
        join(this.dirPath, metaName),
        JSON.stringify(meta, null, 2),
        "utf8",
      );
      return meta;
    });
  }

  /**
   * All captures, newest first (capturedAt desc, savedAt desc as the
   * tiebreak). Unreadable or off-shape .json files are skipped, never
   * fatal; a missing directory means an empty list.
   */
  list(): Promise<LiveCaptureMeta[]> {
    return this.enqueue(async () => {
      let names: string[];
      try {
        names = await readdir(this.dirPath);
      } catch {
        return [];
      }
      const metas: LiveCaptureMeta[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(this.dirPath, name), "utf8");
          const parsed = liveCaptureMetaSchema.safeParse(JSON.parse(raw));
          if (parsed.success) metas.push(parsed.data);
        } catch {
          // Skip unreadable metadata; the media files stay served as-is.
        }
      }
      metas.sort((a, b) => {
        const byCaptured = Date.parse(b.capturedAt) - Date.parse(a.capturedAt);
        if (byCaptured !== 0 && !Number.isNaN(byCaptured)) return byCaptured;
        return b.savedAt.localeCompare(a.savedAt);
      });
      return metas;
    });
  }
}

// Default store used by the API routes; dev hot-reload may re-instantiate,
// which is safe because every operation re-reads the directory.
let defaultStore: LiveCaptureStore | undefined;

export function getLiveCaptureStore(): LiveCaptureStore {
  if (!defaultStore) {
    defaultStore = new LiveCaptureStore(
      join(process.cwd(), "data", "images", "live-view"),
    );
  }
  return defaultStore;
}
