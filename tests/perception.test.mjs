// Perception builder verification suite. Runs the project's .ts modules
// directly via Node 24 type stripping (all cross-file project imports in the
// modules under test are `import type`, so only node_modules imports resolve
// at runtime).
import test from "node:test";
import assert from "node:assert/strict";


const {
  MockScriptBackend,
  ManualBackend,
  LiveBackend,
  StreakGate,
  createBackend,
} = await import("../lib/perception/index.ts");

const {
  POST,
  mapVerdictToEvents,
  extractJson,
  normalizeFrame,
  buildVisionPrompt,
  visionVerdictSchema,
  MIN_CONFIDENCE,
} = await import("../lib/perception/perceive.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const script = [
  { atMs: 200, event: { type: "tip-at", atMs: 200, ref: "UNO:GND" } },
  { atMs: 400, event: { type: "seated", atMs: 400, edgeId: "e1" } },
];

test("MockScriptBackend: speedMultiplier compresses the schedule, order preserved", async () => {
  const backend = new MockScriptBackend(script, { speedMultiplier: 20 }); // 10ms, 20ms
  const seen = [];
  backend.subscribe((e) => seen.push(e.type));
  backend.start();
  await sleep(120);
  backend.stop();
  assert.deepEqual(seen, ["tip-at", "seated"]);
});

test("MockScriptBackend: start() is a clean restart (no duplicate timers)", async () => {
  const backend = new MockScriptBackend(script, { speedMultiplier: 20 });
  const seen = [];
  backend.subscribe((e) => seen.push(e.type));
  backend.start();
  await sleep(5); // before first event fires
  backend.start(); // restart: pending timers must be cancelled
  await sleep(120);
  backend.stop();
  assert.deepEqual(seen, ["tip-at", "seated"]); // exactly one replay
});

test("MockScriptBackend: stop() cancels pending events", async () => {
  const backend = new MockScriptBackend(script, { speedMultiplier: 20 });
  const seen = [];
  backend.subscribe((e) => seen.push(e));
  backend.start();
  backend.stop();
  await sleep(60);
  assert.equal(seen.length, 0);
});

test("ManualBackend: inject relays to subscribers; unsubscribe detaches", () => {
  const backend = new ManualBackend();
  const seen = [];
  const unsub = backend.subscribe((e) => seen.push(e));
  backend.inject({ type: "tip-at", atMs: 1, ref: "UNO:D2" });
  unsub();
  backend.inject({ type: "seated", atMs: 2, edgeId: "e1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ref, "UNO:D2");
});

test("createBackend keeps legacy signatures and adds live", () => {
  assert.ok(createBackend("mock", script) instanceof MockScriptBackend);
  assert.ok(
    createBackend("mock", { script, speedMultiplier: 2 }) instanceof MockScriptBackend,
  );
  assert.ok(createBackend("manual") instanceof ManualBackend);
  assert.throws(() => createBackend("live", {}), /getFrame/);
  const live = createBackend("live", {
    source: "screen",
    intervalMs: 50,
    getFrame: async () => null,
    getStepContext: () => null,
  });
  assert.ok(live instanceof LiveBackend);
});

test("LiveBackend: polls, POSTs step context, relays returned events", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        events: [
          { type: "tip-at", atMs: 1, ref: "UNO:D2" },
          { type: "bogus", atMs: 2 }, // must be filtered out
        ],
        note: "ok",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const backend = new LiveBackend(
    { source: "screen", intervalMs: 30 },
    {
      getFrame: async () => "ZmFrZWJhc2U2NA==",
      getStepContext: () => ({
        instruction: "wire UNO:D2 -> BB:15:a",
        expectedTargets: ["UNO:D2"],
        phase: "awaiting-tip",
        edgeId: "e6",
      }),
    },
    { fetchFn: fakeFetch },
  );
  const seen = [];
  backend.subscribe((e) => seen.push(e));
  backend.start();
  await sleep(100);
  backend.stop();

  assert.ok(calls.length >= 1);
  assert.equal(calls[0].url, "/api/perceive");
  assert.deepEqual(calls[0].body, {
    frameBase64: "ZmFrZWJhc2U2NA==",
    instruction: "wire UNO:D2 -> BB:15:a",
    expectedTargets: ["UNO:D2"],
    phase: "awaiting-tip",
    edgeId: "e6",
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((e) => e.type === "tip-at" && e.ref === "UNO:D2"));
});

test("LiveBackend: no step context -> no fetch; fetch errors don't kill the loop", async () => {
  let calls = 0;
  let ctx = null;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  };
  const backend = new LiveBackend(
    { source: "camera", intervalMs: 20 },
    { getFrame: async () => "eA==", getStepContext: () => ctx },
    { fetchFn: fakeFetch },
  );
  backend.subscribe(() => {});
  backend.start();
  await sleep(60);
  assert.equal(calls, 0); // paused while context is null
  ctx = {
    instruction: "i",
    expectedTargets: ["BB:5:f"],
    phase: "awaiting-seat",
    edgeId: "e2",
  };
  await sleep(90);
  backend.stop();
  assert.ok(calls >= 2); // first call threw, loop kept polling
});

test("mapVerdictToEvents: misplaced wins and suppresses tip/seat", () => {
  const req = {
    frameBase64: "eA==",
    instruction: "i",
    expectedTargets: ["UNO:D2", "BB:15:a"],
    phase: "awaiting-seat",
    edgeId: "e6",
  };
  const events = mapVerdictToEvents(
    { tipOnTarget: true, seated: true, wrongPlacement: "UNO:D3", confidence: 0.9 },
    req,
    123,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "misplaced",
    atMs: 123,
    edgeId: "e6",
    expected: ["UNO:D2", "BB:15:a"],
    observed: "UNO:D3",
  });
});

test("mapVerdictToEvents: tip + seated in awaiting-seat; tip only in awaiting-tip", () => {
  const base = {
    frameBase64: "eA==",
    instruction: "i",
    expectedTargets: ["BB:5:f"],
    edgeId: "e2",
  };
  const verdict = { tipOnTarget: true, seated: true, wrongPlacement: null, confidence: 0.8 };
  const seatEvents = mapVerdictToEvents(verdict, { ...base, phase: "awaiting-seat" }, 5);
  assert.deepEqual(
    seatEvents.map((e) => e.type),
    ["tip-at", "seated"],
  );
  const tipEvents = mapVerdictToEvents(verdict, { ...base, phase: "awaiting-tip" }, 5);
  assert.deepEqual(
    tipEvents.map((e) => e.type),
    ["tip-at"],
  );
  assert.equal(tipEvents[0].ref, "BB:5:f");
});

test("extractJson: tolerates markdown fences and prose", () => {
  const parsed = extractJson(
    'Sure! ```json\n{"tipOnTarget": true, "seated": false, "wrongPlacement": null, "confidence": 0.7}\n```',
  );
  assert.equal(parsed.tipOnTarget, true);
  assert.equal(extractJson("no json here"), null);
});

test("normalizeFrame: strips data URLs, defaults to jpeg", () => {
  assert.deepEqual(normalizeFrame("data:image/png;base64,AAAA"), {
    data: "AAAA",
    mediaType: "image/png",
  });
  assert.deepEqual(normalizeFrame("AAAA"), { data: "AAAA", mediaType: "image/jpeg" });
});

test("buildVisionPrompt: states simulated workspace + strict JSON contract", () => {
  const prompt = buildVisionPrompt({
    frameBase64: "eA==",
    instruction: "wire UNO:GND -> BB:RAIL:GND",
    expectedTargets: ["UNO:GND", "BB:RAIL:GND"],
    phase: "awaiting-tip",
    edgeId: "e1",
  });
  assert.match(prompt, /SIMULATED workspace/);
  assert.match(prompt, /cutouts/i);
  assert.match(prompt, /UNO:GND, BB:RAIL:GND/);
  assert.match(prompt, /"tipOnTarget": boolean/);
  assert.match(prompt, /"observedRef": string \| null/);
  assert.match(prompt, /silkscreen/);
  assert.match(prompt, /count/i); // hole counting instruction
});

test("visionVerdictSchema: observedRef accepted, defaults to null for old-format replies", () => {
  const withRef = visionVerdictSchema.parse({
    tipOnTarget: true,
    seated: false,
    wrongPlacement: null,
    observedRef: "UNO:D2",
    confidence: 0.9,
  });
  assert.equal(withRef.observedRef, "UNO:D2");

  const withoutRef = visionVerdictSchema.parse({
    tipOnTarget: false,
    seated: false,
    wrongPlacement: null,
    confidence: 0.6,
  });
  assert.equal(withoutRef.observedRef, null);
});

test("mapVerdictToEvents: observedRef mismatch emits misplaced with the read pin", () => {
  const req = {
    frameBase64: "eA==",
    instruction: "i",
    expectedTargets: ["UNO:D2"],
    phase: "awaiting-tip",
    edgeId: "e6",
  };
  const events = mapVerdictToEvents(
    {
      tipOnTarget: true, // hedged yes, but the read pin disagrees
      seated: false,
      wrongPlacement: null,
      observedRef: "UNO:D4",
      confidence: 0.85,
    },
    req,
    7,
  );
  assert.deepEqual(events, [
    {
      type: "misplaced",
      atMs: 7,
      edgeId: "e6",
      expected: ["UNO:D2"],
      observed: "UNO:D4",
    },
  ]);
});

test("mapVerdictToEvents: observedRef match confirms tip even when tipOnTarget hedged", () => {
  const req = {
    frameBase64: "eA==",
    instruction: "i",
    expectedTargets: ["UNO:D2", "BB:15:a"],
    phase: "awaiting-tip",
    edgeId: "e6",
  };
  // Case-insensitive match against the second expected target.
  const events = mapVerdictToEvents(
    {
      tipOnTarget: false,
      seated: false,
      wrongPlacement: null,
      observedRef: "bb:15:A",
      confidence: 0.8,
    },
    req,
    9,
  );
  assert.deepEqual(events, [{ type: "tip-at", atMs: 9, ref: "BB:15:a" }]);
});

test("mapVerdictToEvents: confidence below MIN_CONFIDENCE discards the whole verdict", () => {
  assert.equal(MIN_CONFIDENCE, 0.5);
  const req = {
    frameBase64: "eA==",
    instruction: "i",
    expectedTargets: ["UNO:D2"],
    phase: "awaiting-seat",
    edgeId: "e6",
  };
  const events = mapVerdictToEvents(
    {
      tipOnTarget: true,
      seated: true,
      wrongPlacement: "UNO:D3",
      observedRef: "UNO:D3",
      confidence: 0.4,
    },
    req,
    11,
  );
  assert.deepEqual(events, []); // no events, even misplaced
});

// --- StreakGate: temporal consistency ---------------------------------------

const tip = (ref) => ({ type: "tip-at", atMs: 1, ref });
const seatedEv = { type: "seated", atMs: 1, edgeId: "e1" };
const misplacedEv = {
  type: "misplaced",
  atMs: 1,
  edgeId: "e1",
  expected: ["UNO:D2"],
  observed: "UNO:D4",
};

test("StreakGate: tip-at fires only on the 2nd consecutive agreeing frame", () => {
  const gate = new StreakGate();
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-tip"), []);
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-tip"), [tip("UNO:D2")]);
  // Emit resets the streak: the next agreeing frame starts a fresh count.
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-tip"), []);
});

test("StreakGate: alternating refs never fire", () => {
  const gate = new StreakGate();
  for (let i = 0; i < 4; i += 1) {
    const ref = i % 2 === 0 ? "UNO:D2" : "UNO:D3";
    assert.deepEqual(gate.push([tip(ref)], "e1:awaiting-tip"), []);
  }
});

test("StreakGate: an empty frame (low-confidence discard) resets the streak", () => {
  const gate = new StreakGate();
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-tip"), []);
  assert.deepEqual(gate.push([], "e1:awaiting-tip"), []); // miss
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-tip"), []); // count restarts at 1
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-tip"), [tip("UNO:D2")]);
});

test("StreakGate: misplaced passes through immediately and resets streaks", () => {
  const gate = new StreakGate();
  gate.push([tip("UNO:D2")], "e1:awaiting-tip"); // streak at 1
  assert.deepEqual(gate.push([misplacedEv], "e1:awaiting-tip"), [misplacedEv]);
  // Streak was reset by the misplaced frame.
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-tip"), []);
});

test("StreakGate: seated needs 2 consecutive seated verdicts", () => {
  const gate = new StreakGate();
  assert.deepEqual(gate.push([seatedEv], "e1:awaiting-seat"), []);
  assert.deepEqual(gate.push([], "e1:awaiting-seat"), []); // miss resets
  assert.deepEqual(gate.push([seatedEv], "e1:awaiting-seat"), []);
  assert.deepEqual(gate.push([seatedEv], "e1:awaiting-seat"), [seatedEv]);
});

test("StreakGate: step-context change resets streaks; consecutiveN is configurable", () => {
  const gate = new StreakGate();
  gate.push([tip("UNO:D2")], "e1:awaiting-tip");
  // Same ref, but the phase advanced - the streak must not carry over.
  assert.deepEqual(gate.push([tip("UNO:D2")], "e1:awaiting-seat"), []);

  const eager = new StreakGate({ consecutiveN: 1 });
  assert.deepEqual(eager.push([tip("UNO:D2")], "e1:awaiting-tip"), [tip("UNO:D2")]);

  const strict = new StreakGate({ consecutiveN: 3 });
  assert.deepEqual(strict.push([tip("UNO:D2")], "e1:awaiting-tip"), []);
  assert.deepEqual(strict.push([tip("UNO:D2")], "e1:awaiting-tip"), []);
  assert.deepEqual(strict.push([tip("UNO:D2")], "e1:awaiting-tip"), [tip("UNO:D2")]);
});

test("StreakGate: detections pass through untouched", () => {
  const gate = new StreakGate();
  const det = { type: "detections", atMs: 1, parts: [] };
  assert.deepEqual(gate.push([det], "e1:awaiting-tip"), [det]);
});

test("LiveBackend: relays the server note through onNote", async () => {
  const fakeFetch = async () =>
    new Response(
      JSON.stringify({ events: [], note: "vlm confidence 0.80" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const notes = [];
  const backend = new LiveBackend(
    { source: "screen", intervalMs: 25 },
    {
      getFrame: async () => "eA==",
      getStepContext: () => ({
        instruction: "i",
        expectedTargets: ["UNO:D2"],
        phase: "awaiting-tip",
        edgeId: "e6",
      }),
      onNote: (n) => notes.push(n),
    },
    { fetchFn: fakeFetch },
  );
  backend.subscribe(() => {});
  backend.start();
  await sleep(80);
  backend.stop();
  assert.ok(notes.length >= 1);
  assert.equal(notes[0], "vlm confidence 0.80");
});

test("POST /api/perceive: degrades to mock note without ANTHROPIC_API_KEY", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await POST(
    new Request("http://localhost/api/perceive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frameBase64: "eA==",
        instruction: "i",
        expectedTargets: ["UNO:D2"],
        phase: "awaiting-tip",
        edgeId: "e6",
      }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.events, []);
  assert.equal(body.note, "no ANTHROPIC_API_KEY: use mock or manual mode");
});

test("POST /api/perceive: 400 on schema violation and non-JSON body", async () => {
  const bad = await POST(
    new Request("http://localhost/api/perceive", {
      method: "POST",
      body: JSON.stringify({ frameBase64: "", instruction: "", expectedTargets: [], phase: "nope", edgeId: "" }),
    }),
  );
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.match(badBody.note, /invalid request/);

  const notJson = await POST(
    new Request("http://localhost/api/perceive", { method: "POST", body: "not json" }),
  );
  assert.equal(notJson.status, 400);
});
