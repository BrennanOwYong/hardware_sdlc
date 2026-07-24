// Thin route wrapper: all logic (zod validation, Anthropic vision call,
// verdict clamping, keyless degrade) lives in lib/coach/coach.ts so it can be
// unit-tested outside the Next.js runtime (the perceive.ts pattern).
export { POST } from "@/lib/coach/coach";
