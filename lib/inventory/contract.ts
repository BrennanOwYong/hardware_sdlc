import { z } from "zod";

/** Media types the Anthropic vision API accepts (see docs/references-p1.md). */
export const MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** POST /api/identify request body. */
export const identifyRequestSchema = z.object({
  /** Either a data URL (data:image/...;base64,...) or bare base64. */
  imageBase64: z.string().min(1).optional(),
  /** Media type when imageBase64 is bare base64 (data URLs carry their own). */
  mediaType: z.enum(MEDIA_TYPES).optional(),
  /** True when the client sent the rasterized sample-parts sheet. */
  useSample: z.boolean().optional(),
  /** Pixel dimensions of the sent image; used to normalize pixel bboxes. */
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  /** Live Ctrl-F: what the user is hunting for; steers the vision prompt. */
  query: z.string().max(100).optional(),
});
export type IdentifyRequest = z.infer<typeof identifyRequestSchema>;

/** Mirrors PartDetection from lib/types.ts, for runtime validation. */
export const partDetectionSchema = z.object({
  id: z.string(),
  partType: z.string(),
  label: z.string(),
  confidence: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /**
   * Base64 PNG (no data: prefix), white where the object is (masks builder,
   * lib/perception/sam.ts). Declared here because zod v3 strips unknown keys:
   * without this line the client parse (and the photo-library cache PATCH,
   * which reuses inventorySchema) would silently drop every mask.
   */
  maskPng: z.string().optional(),
});

/** Mirrors Inventory from lib/types.ts, for runtime validation. */
export const inventorySchema = z.object({
  parts: z.array(partDetectionSchema),
  photoDataUrl: z.string().optional(),
  capturedAt: z.string(),
  source: z.union([z.literal("mock"), z.literal("vlm")]),
});

/** POST /api/identify success response envelope. */
export const identifyResponseSchema = z.object({
  inventory: inventorySchema,
  /** Present whenever the server degraded from the VLM path. */
  note: z.string().optional(),
});
export type IdentifyResponse = z.infer<typeof identifyResponseSchema>;

/** POST /api/identify error response envelope. */
export const identifyErrorSchema = z.object({ error: z.string() });
export type IdentifyError = z.infer<typeof identifyErrorSchema>;
