// POST /api/bench/test -> the equipment handshake. Compiles and uploads a
// tiny blink+hello sketch to the first awake board, then listens for one
// serial line. Every outcome is a FlashResult with stage-tagged output and a
// beginner guidance string on failure. Doc links:
// docs/references-delta-bench.md.

import { NextResponse } from "next/server";
import type { FlashResult } from "@/lib/types";
import { firmwareHash } from "@/lib/vcs/store";
import { GUIDANCE, pickGuidance } from "@/lib/bench/guidance";
import { cleanupSketch, compileSketch, readSerialLine, uploadSketch, isWsl, isWindowsBinary } from "@/lib/bench/cli";
import { pickTarget, refreshBench } from "@/lib/bench/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HELLO_SKETCH = `// Forge bench handshake: blink the built-in light and say hello once.
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
  Serial.println("hello from forge");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(300);
  digitalWrite(LED_BUILTIN, LOW);
  delay(300);
}
`;

function fail(stage: FlashResult["stage"], output: string, guidance: string): FlashResult {
  return { ok: false, stage, output, guidance };
}

export async function POST(): Promise<NextResponse<FlashResult>> {
  const status = await refreshBench();

  if (!status.cliAvailable) {
    return NextResponse.json(fail("compile", "", GUIDANCE["no-cli"]));
  }
  if (!status.coreInstalled) {
    return NextResponse.json(fail("compile", "", GUIDANCE["core-missing"]));
  }

  const target = pickTarget(status);
  if (!target || target.port === null) {
    const guidance =
      isWsl() && !isWindowsBinary()
        ? GUIDANCE["wsl-linux-binary"]
        : status.devices.length > 0
          ? GUIDANCE["board-gone"]
          : GUIDANCE["no-board"];
    return NextResponse.json(fail("upload", "", guidance));
  }

  const fqbn = target.fqbn ?? "arduino:avr:uno";
  const compiled = await compileSketch(HELLO_SKETCH, fqbn);
  try {
    if (!compiled.ok) {
      return NextResponse.json(
        fail("compile", `[compile]\n${compiled.output}`, GUIDANCE["compile-failed"]),
      );
    }

    const uploaded = await uploadSketch(compiled, target.port, fqbn);
    const log = `[compile]\n${compiled.output}\n\n[upload]\n${uploaded.output}`;
    if (!uploaded.ok) {
      return NextResponse.json(
        fail("upload", log, pickGuidance({ stage: "upload", output: uploaded.output })),
      );
    }

    // Opening the serial monitor resets the UNO, so setup() runs again and the
    // hello line arrives right after the port opens.
    const hello = await readSerialLine(target.port, 9600, 8_000);
    const fullLog = `${log}\n\n[handshake]\n${hello.line || "(no serial reply)"}`;
    if (!hello.ok || !hello.line.includes("hello from forge")) {
      return NextResponse.json(fail("handshake", fullLog, GUIDANCE["no-hello"]));
    }

    return NextResponse.json({
      ok: true,
      stage: "done",
      output: fullLog,
      firmwareHash: firmwareHash(HELLO_SKETCH),
    });
  } finally {
    await cleanupSketch(compiled);
  }
}
