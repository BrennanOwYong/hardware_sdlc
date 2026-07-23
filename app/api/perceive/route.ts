// Thin route wrapper: all logic (zod validation, Anthropic vision call, event
// mapping, no-key mock path) lives in lib/perception/perceive.ts so it can be
// unit-tested outside the Next.js runtime.
export { POST } from "@/lib/perception/perceive";
