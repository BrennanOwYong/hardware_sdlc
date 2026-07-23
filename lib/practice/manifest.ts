/**
 * Practice-media manifest loader. data/images/practice/manifest.json lists
 * the curated real-camera workbench photos and videos (see
 * data/images/practice/ATTRIBUTION.md for licenses); the images API streams
 * both at /api/images/practice/<file>. This module fetches the manifest
 * client-side, zod-validates the shape, and exposes typed accessors so
 * /inventory (practice photos) and /assemble (practice video) never trust
 * the JSON blindly.
 *
 * Runtime imports stay limited to zod so tests/practice.test.mjs can run
 * this file directly under node --test via Node 24 type stripping.
 *
 * References: docs/references-practice-modes.md, docs/references-storage.md
 */
import { z } from "zod";

/** One curated photo or video entry in data/images/practice/manifest.json. */
export const practiceMediaItemSchema = z.object({
  /** Basename inside data/images/practice/, e.g. "uno-closeup.jpg". */
  file: z.string().min(1),
  /** Human-readable description of the scene. */
  title: z.string().min(1),
  /** Photographer / videographer credit shown under each thumbnail. */
  credit: z.string().min(1),
  /** License short name, e.g. "CC BY-SA 4.0" or "Pexels License". */
  license: z.string().min(1),
  /** Deep link to the original upload for attribution. */
  sourceUrl: z.string().url(),
});
export type PracticeMediaItem = z.infer<typeof practiceMediaItemSchema>;

export const practiceManifestSchema = z.object({
  photos: z.array(practiceMediaItemSchema),
  videos: z.array(practiceMediaItemSchema),
});
export type PracticeManifest = z.infer<typeof practiceManifestSchema>;

/** Base URL the images route serves data/images/practice/ under. */
export const PRACTICE_BASE_PATH = "/api/images/practice";
export const PRACTICE_MANIFEST_URL = `${PRACTICE_BASE_PATH}/manifest.json`;

/** URL for one manifest entry, e.g. "/api/images/practice/uno-closeup.jpg". */
export function practiceMediaUrl(item: Pick<PracticeMediaItem, "file">): string {
  return `${PRACTICE_BASE_PATH}/${item.file}`;
}

/**
 * Fetches and validates the practice manifest. Throws an Error with a
 * plain-language message on any failure (network, HTTP status, JSON parse,
 * schema mismatch); callers surface that message as a degrade note and keep
 * the rest of their page working.
 */
export async function loadPracticeManifest(
  fetchFn?: typeof fetch,
): Promise<PracticeManifest> {
  // Bare `fetch` references throw "Illegal invocation" in some browsers when
  // called unbound, so the default wraps the global (same pattern as
  // lib/perception LiveBackend).
  const doFetch: typeof fetch = fetchFn
    ? fetchFn
    : (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
  let res: Response;
  try {
    res = await doFetch(PRACTICE_MANIFEST_URL);
  } catch (err) {
    throw new Error(
      `could not reach ${PRACTICE_MANIFEST_URL} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `the practice media list at ${PRACTICE_MANIFEST_URL} answered HTTP ${res.status}`,
    );
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error(
      `the practice media list at ${PRACTICE_MANIFEST_URL} is not valid JSON`,
    );
  }
  const parsed = practiceManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `the practice media list at ${PRACTICE_MANIFEST_URL} has an unexpected shape`,
    );
  }
  return parsed.data;
}
