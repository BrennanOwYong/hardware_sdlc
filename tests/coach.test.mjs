// Coach builder verification suite (FEEDBACK item 12, test T19). Loads
// lib/coach/contract.ts directly via Node 24 type stripping: its only runtime
// import is zod (node_modules), project imports are type-only. lib/coach/
// coach.ts runtime-imports contract.ts and the Anthropic SDK, so node --test
// cannot load it (extensionless relative .ts specifiers do not resolve under
// type stripping); its degrade paths are built from the pure helpers covered
// here, and the vision call mirrors lib/perception/perceive.ts.
import test from "node:test";
import assert from "node:assert/strict";

const {
  HISTORY_MAX,
  KEYLESS_NOTE,
  MALFORMED_NOTE,
  coachRequestSchema,
  coachVerdictSchema,
  coachResponseSchema,
  truncateHistory,
  clampCoachGeometry,
  degradedCoachResponse,
  formatRequestIssues,
  extractCoachJson,
  buildCoachPrompt,
  normalizeCoachImage,
} = await import("../lib/coach/contract.ts");

const validRequest = {
  goal: "plug the USB cable into the Arduino's USB socket",
  imageBase64: "data:image/jpeg;base64,AAAA",
  attempt: 1,
};

test("coachRequestSchema: accepts a minimal valid request and one with history", () => {
  assert.ok(coachRequestSchema.safeParse(validRequest).success);
  assert.ok(
    coachRequestSchema.safeParse({
      ...validRequest,
      attempt: 3,
      history: ["rotate the plug flat side up", "move it two centimeters left"],
    }).success,
  );
});

test("coachRequestSchema: rejects long goal, bad attempt, oversized history", () => {
  assert.ok(!coachRequestSchema.safeParse({ ...validRequest, goal: "" }).success);
  assert.ok(
    !coachRequestSchema.safeParse({ ...validRequest, goal: "x".repeat(201) }).success,
  );
  assert.ok(!coachRequestSchema.safeParse({ ...validRequest, attempt: 0 }).success);
  assert.ok(!coachRequestSchema.safeParse({ ...validRequest, attempt: 1.5 }).success);
  assert.ok(!coachRequestSchema.safeParse({ ...validRequest, imageBase64: "" }).success);
  assert.ok(
    !coachRequestSchema.safeParse({
      ...validRequest,
      history: ["a", "b", "c", "d", "e", "f"], // 6 > HISTORY_MAX
    }).success,
  );
});

test("truncateHistory: keeps the most recent HISTORY_MAX entries, oldest dropped", () => {
  assert.equal(HISTORY_MAX, 5);
  assert.deepEqual(truncateHistory(undefined), []);
  assert.deepEqual(truncateHistory([]), []);
  assert.deepEqual(truncateHistory(["a", "b"]), ["a", "b"]);
  assert.deepEqual(
    truncateHistory(["one", "two", "three", "four", "five", "six", "seven"]),
    ["three", "four", "five", "six", "seven"],
  );
});

test("coachVerdictSchema: full shape parses; omitted objects/target/arrow default", () => {
  const full = coachVerdictSchema.parse({
    verdict: "adjust",
    instruction: "Rotate the plug so its flat side faces up.",
    objects: [{ label: "USB plug", bbox: [0.1, 0.2, 0.15, 0.1] }],
    target: { x: 0.7, y: 0.4, label: "USB socket" },
    arrow: { from: { x: 0.2, y: 0.25 }, to: { x: 0.7, y: 0.4 } },
    confidence: 0.85,
  });
  assert.equal(full.verdict, "adjust");
  assert.equal(full.objects.length, 1);

  const sparse = coachVerdictSchema.parse({
    verdict: "cannot-see",
    instruction: "Step closer so the socket is in the frame.",
    confidence: 0.4,
  });
  assert.deepEqual(sparse.objects, []);
  assert.equal(sparse.target, null);
  assert.equal(sparse.arrow, null);
});

test("coachVerdictSchema: rejects unknown verdicts, blank instruction, bad confidence", () => {
  assert.ok(
    !coachVerdictSchema.safeParse({ verdict: "maybe", instruction: "x", confidence: 0.5 })
      .success,
  );
  assert.ok(
    !coachVerdictSchema.safeParse({ verdict: "done", instruction: "x", confidence: 1.2 })
      .success,
  );
  assert.ok(
    !coachVerdictSchema.safeParse({ verdict: "done", instruction: "", confidence: 0.9 })
      .success,
  );
});

test("clampCoachGeometry: clips bbox, target, and arrow into 0..1", () => {
  const clamped = clampCoachGeometry({
    verdict: "adjust",
    instruction: "Move it left.",
    objects: [{ label: "plug", bbox: [-0.1, 0.9, 0.5, 0.5] }],
    target: { x: 1.4, y: -0.2, label: "socket" },
    arrow: { from: { x: -1, y: 0.5 }, to: { x: 2, y: 0.5 } },
    confidence: 0.7,
  });
  const [bx, by, bw, bh] = clamped.objects[0].bbox;
  assert.equal(bx, 0);
  assert.equal(by, 0.9);
  assert.equal(bw, 0.5); // x + w stays inside
  assert.ok(Math.abs(bh - 0.1) < 1e-9); // y + h clipped to the bottom edge
  assert.deepEqual(clamped.target, { x: 1, y: 0, label: "socket" });
  assert.deepEqual(clamped.arrow, { from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } });
  // Nulls pass through untouched.
  const nulls = clampCoachGeometry({
    verdict: "done",
    instruction: "Seated.",
    objects: [],
    target: null,
    arrow: null,
    confidence: 1,
  });
  assert.equal(nulls.target, null);
  assert.equal(nulls.arrow, null);
});

test("degradedCoachResponse: keyless/malformed degrade validates as a response", () => {
  const keyless = degradedCoachResponse("Ask the operator for a key.", KEYLESS_NOTE);
  const parsed = coachResponseSchema.parse(keyless);
  assert.equal(parsed.verdict, "cannot-see");
  assert.equal(parsed.confidence, 0);
  assert.deepEqual(parsed.objects, []);
  assert.equal(parsed.target, null);
  assert.equal(parsed.arrow, null);
  assert.match(parsed.note ?? "", /no ANTHROPIC_API_KEY/);

  const malformed = degradedCoachResponse("Take the photo again.", MALFORMED_NOTE);
  assert.match(coachResponseSchema.parse(malformed).note ?? "", /malformed after one retry/);
});

test("formatRequestIssues: names each bad field in the invalid-request note", () => {
  const failed = coachRequestSchema.safeParse({ goal: "", imageBase64: "", attempt: 0 });
  assert.ok(!failed.success);
  const note = formatRequestIssues(failed.error.issues);
  assert.match(note, /^invalid request: /);
  assert.match(note, /goal/);
  assert.match(note, /imageBase64/);
  assert.match(note, /attempt/);
});

test("extractCoachJson: tolerates fences and prose; null on garbage", () => {
  const parsed = extractCoachJson(
    'Here you go: ```json\n{"verdict": "done", "instruction": "Plugged in.", "confidence": 0.9}\n```',
  );
  assert.equal(parsed.verdict, "done");
  assert.equal(extractCoachJson("no json here"), null);
  assert.equal(extractCoachJson("{broken"), null);
});

test("buildCoachPrompt: goal, attempt, history, simulated workspace, JSON contract", () => {
  const prompt = buildCoachPrompt({
    goal: "plug the USB cable into the Arduino's USB socket",
    attempt: 3,
    history: ["Rotate the plug flat side up.", "Move it two centimeters left."],
  });
  assert.match(prompt, /plug the USB cable into the Arduino's USB socket/);
  assert.match(prompt, /attempt number 3/);
  assert.match(prompt, /1\. Rotate the plug flat side up\./);
  assert.match(prompt, /2\. Move it two centimeters left\./);
  assert.match(prompt, /SIMULATED workspace/);
  assert.match(prompt, /cutouts/i);
  assert.match(prompt, /"verdict": "adjust" \| "done" \| "cannot-see"/);
  assert.match(prompt, /"bbox": \[x, y, w, h\]/);
  assert.match(prompt, /socket, port, or hole/);
  assert.match(prompt, /centimeters/); // physical-terms movement example
  assert.match(prompt, /Rotate the plug/); // rotation example
});

test("buildCoachPrompt: no history states a first attempt; history is capped at 5", () => {
  const first = buildCoachPrompt({ goal: "g", attempt: 1, history: [] });
  assert.match(first, /no prior instructions/);
  const seven = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"];
  const capped = buildCoachPrompt({ goal: "g", attempt: 8, history: seven });
  assert.doesNotMatch(capped, /\bh1\b/);
  assert.doesNotMatch(capped, /\bh2\b/);
  assert.match(capped, /\bh3\b/);
  assert.match(capped, /\bh7\b/);
});

test("normalizeCoachImage: strips data URLs, defaults to jpeg", () => {
  assert.deepEqual(normalizeCoachImage("data:image/png;base64,AAAA"), {
    data: "AAAA",
    mediaType: "image/png",
  });
  assert.deepEqual(normalizeCoachImage("AAAA"), {
    data: "AAAA",
    mediaType: "image/jpeg",
  });
});
