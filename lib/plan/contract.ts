// Client-safe schemas for the idea-to-build wizard. No SDK imports here: the
// builder page pulls these into the browser bundle (the lib/inventory/contract
// split, same reason).
import { z } from "zod";

/** Part keys that have real scraped listings in data/images/shop/. */
export const PART_KEYS = [
  "uno",
  "breadboard",
  "jumpers",
  "led",
  "resistor",
  "button",
  "dht11",
  "usb-cable",
] as const;
export type PartKey = (typeof PART_KEYS)[number];

export const plannedPartSchema = z.object({
  name: z.string().min(1).max(80),
  partKey: z.enum(PART_KEYS).nullable().optional(),
  qty: z.number().int().min(1).max(99),
  why: z.string().min(1).max(200),
});
export type PlannedPart = z.infer<typeof plannedPartSchema>;

export const planTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(2000),
});
export type PlanTurn = z.infer<typeof planTurnSchema>;

export const planRequestSchema = z.object({
  idea: z.string().min(1).max(500),
  history: z.array(planTurnSchema).max(10).optional(),
});
export type PlanRequest = z.infer<typeof planRequestSchema>;

export const planResponseSchema = z.object({
  reply: z.string(),
  parts: z.array(plannedPartSchema).optional(),
  note: z.string().optional(),
});
export type PlanResponse = z.infer<typeof planResponseSchema>;

export const listingSchema = z.object({
  partKey: z.string(),
  title: z.string(),
  price: z.number(),
  currency: z.string(),
  store: z.string(),
  url: z.string(),
  imageFile: z.string(),
  fetchedAt: z.string().optional(),
});
export type Listing = z.infer<typeof listingSchema>;

export const shopManifestSchema = z.object({ listings: z.array(listingSchema) });

export const wireStepSchema = z.object({
  index: z.number().int().min(1),
  fromPart: z.string().min(1),
  toPart: z.string().min(1),
  instruction: z.string().min(1),
  checkDetail: z.string().min(1),
});
export type WireStep = z.infer<typeof wireStepSchema>;

export const wirePlanResponseSchema = z.object({
  steps: z.array(wireStepSchema),
  endStateSummary: z.string(),
  checks: z.array(z.string()),
  note: z.string().optional(),
});
export type WirePlanResponse = z.infer<typeof wirePlanResponseSchema>;

export const wirePlanRequestSchema = z.object({
  goal: z.string().min(1).max(500),
  parts: z
    .array(z.object({ name: z.string().min(1), partKey: z.string().optional() }))
    .min(2)
    .max(12),
});
export type WirePlanRequest = z.infer<typeof wirePlanRequestSchema>;

export const LISTING_IMAGE_BASE = "/api/images/shop/";
export const SHOP_MANIFEST_URL = "/api/images/shop/manifest.json";
