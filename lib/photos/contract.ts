// Photo-library API contract: zod schemas shared by app/api/photos/* and the
// /inventory client. Import-safe on the client (zod only); the node-only
// store lives in lib/photos/store.ts. Docs: docs/references-photolib.md.

import { z } from "zod";
import { inventorySchema } from "../inventory/contract";

/** POST /api/photos request body. */
export const photoCreateRequestSchema = z.object({
  /** Base64 data URL, image/jpeg or image/png (client rasterizes to JPEG). */
  photoDataUrl: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type PhotoCreateRequest = z.infer<typeof photoCreateRequestSchema>;

/** PATCH /api/photos/<id> request body: cache an identification. */
export const photoPatchRequestSchema = z.object({
  inventory: inventorySchema,
});
export type PhotoPatchRequest = z.infer<typeof photoPatchRequestSchema>;

/** One photo as the API returns it (inventory present only with ?full=1). */
export const photoMetaSchema = z.object({
  id: z.string(),
  capturedAt: z.string(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  label: z.string(),
  mediaType: z.enum(["image/jpeg", "image/png"]),
  inventory: inventorySchema.optional(),
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
