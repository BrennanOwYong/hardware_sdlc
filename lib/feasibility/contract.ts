// "Can I build this with what I have?" — schemas shared by the API route and
// the page, so no SDK imports here (the lib/inventory/contract.ts split).
import { z } from "zod";

export const usablePartSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1), // what job it does in THIS build
});

export const unusablePartSchema = z.object({
  name: z.string().min(1),
  why: z.string().min(1), // why it does not help here, in plain words
});

export const missingPartSchema = z.object({
  name: z.string().min(1),
  partKey: z.string().nullable().optional(),
  qty: z.number().int().min(1).max(99).default(1),
  why: z.string().min(1),
  critical: z.boolean().default(true),
});

export const assessRequestSchema = z.object({
  goal: z.string().min(1).max(500),
  parts: z
    .array(z.object({ label: z.string().min(1), partType: z.string().min(1) }))
    .max(60),
});
export type AssessRequest = z.infer<typeof assessRequestSchema>;

/** The full bill of materials for the goal, quantities included. This is what
 *  the venn compares against; without it we can only say "missing", never
 *  "you have 3 of the 4 you need". */
export const requiredPartSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  qty: z.number().int().min(1).max(99).default(1),
  why: z.string().min(1),
  critical: z.boolean().default(true),
});
export type RequiredPartSpec = z.infer<typeof requiredPartSchema>;

export const assessResponseSchema = z.object({
  required: z.array(requiredPartSchema).default([]),
  verdict: z.enum(["ready", "partial", "not-possible"]),
  summary: z.string().min(1),
  usable: z.array(usablePartSchema),
  unusable: z.array(unusablePartSchema),
  missing: z.array(missingPartSchema),
  nextStep: z.string().min(1),
  note: z.string().optional(),
});
export type AssessResponse = z.infer<typeof assessResponseSchema>;
export type UsablePart = z.infer<typeof usablePartSchema>;
export type UnusablePart = z.infer<typeof unusablePartSchema>;
export type MissingPart = z.infer<typeof missingPartSchema>;

export const VERDICT_COPY: Record<
  AssessResponse["verdict"],
  { label: string; color: string; blurb: string }
> = {
  ready: {
    label: "You can build this",
    color: "var(--accent)",
    blurb: "Everything this needs is already on your bench.",
  },
  partial: {
    label: "Almost — a few parts short",
    color: "var(--warn)",
    blurb: "Some of what you have works; the list below is what is missing.",
  },
  "not-possible": {
    label: "Not with these parts",
    color: "var(--error)",
    blurb: "Nothing on the bench does this job yet. Here is the shopping list.",
  },
};
