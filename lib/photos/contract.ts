// Photo-library API contract: zod schemas shared by app/api/photos/* and the
// /inventory client. Import-safe on the client (zod only); the node-only
// store lives in lib/photos/store.ts. Docs: docs/references-photolib.md.

import { z } from "zod";
import { inventorySchema } from "../inventory/contract";

/** POST /api/photos request body. */
/** Coach processing output persisted with a photo so a past attempt reopens
 *  with its arrow and highlight instead of being re-shot. */
export const coachCaptureSchema = z.object({
  goal: z.string(),
  verdict: z.string(),
  instruction: z.string(),
  guide: z
    .object({
      from: z.object({ x: z.number(), y: z.number() }),
      to: z.object({ x: z.number(), y: z.number() }),
      source: z.enum(["mask", "model"]),
      targetMaskPng: z.string().optional(),
      targetBbox: z.array(z.number()).length(4).optional(),
      note: z.string(),
    })
    .optional(),
});

export const photoCreateRequestSchema = z.object({
  surface: z.enum(["inventory", "coach"]).optional(),
  label: z.string().max(120).optional(),
  /** Base64 data URL, image/jpeg or image/png (client rasterizes to JPEG). */
  photoDataUrl: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type PhotoCreateRequest = z.infer<typeof photoCreateRequestSchema>;

/** PATCH /api/photos/<id> request body: cache an identification OR a coaching
 *  result. Exactly one is expected; both optional keeps older callers valid. */
export const photoPatchRequestSchema = z
  .object({
    inventory: inventorySchema.optional(),
    coach: coachCaptureSchema.optional(),
  })
  .refine((v) => v.inventory !== undefined || v.coach !== undefined, {
    message: "provide inventory or coach",
  });
export type PhotoPatchRequest = z.infer<typeof photoPatchRequestSchema>;

/** One photo as the API returns it (inventory/coach present only with ?full=1). */
export const photoMetaSchema = z.object({
  id: z.string(),
  capturedAt: z.string(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  label: z.string(),
  mediaType: z.enum(["image/jpeg", "image/png"]),
  surface: z.enum(["inventory", "coach"]).optional(),
  inventory: inventorySchema.optional(),
  coach: coachCaptureSchema.optional(),
});
export type PhotoMeta = z.infer<typeof photoMetaSchema>;

/** GET /api/photos -> { photos } newest first. */
export const photoListResponseSchema = z.object({
  photos: z.array(photoMetaSchema),
});

/** POST /api/photos and PATCH /api/photos/<id> -> { photo }. */
export const photoResponseSchema = z.object({ photo: photoMetaSchema });

/** Streaming URL for a stored photo's bytes. */
export function photoFileUrl(id: string): string {
  return `/api/photos/${id}/file`;
}
