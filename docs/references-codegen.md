# References: pin-aware codegen builder

Doc links verified via WebFetch on 2026-07-23 while implementing
`lib/codegen/**`, `app/api/codegen/route.ts`, and `components/CodePanel.tsx`.

## Anthropic Messages API (LLM tweak path, `lib/codegen/llm.ts`)

- TypeScript SDK repo (client construction, `messages.create` parameter names
  `model` / `max_tokens` / `system` / `messages`, content-block union
  narrowing on `block.type === "text"`):
  https://github.com/anthropics/anthropic-sdk-typescript
- Model id used: `claude-sonnet-5` (per project rule; key from
  `process.env.ANTHROPIC_API_KEY`). Sonnet 5 rejects non-default
  `temperature`/`top_p`/`top_k` and runs adaptive thinking when `thinking` is
  omitted, so the call passes neither.
- Installed SDK version: `@anthropic-ai/sdk` 0.113.0.

## Web Serial / flashing (why the Flash button is a stub)

- MDN Web Serial API (secure context + Chromium-only,
  `navigator.serial.requestPort()` -> `port.open({ baudRate })` ->
  `port.writable.getWriter()`):
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
- esptool-js (browser flasher over Web Serial; targets Espressif ESP32/ESP8266
  chips, not the UNO's AVR, so it cannot flash the demo board):
  https://github.com/espressif/esptool-js
- Conclusion recorded in the Flash modal: browser flashing for an Arduino UNO
  has no maintained browser toolchain in this stack, so the MVP ships the
  manual path below.

## Manual flash path (shown in the Flash modal)

- Wokwi browser simulator (paste an Arduino UNO sketch and run it without
  hardware): https://wokwi.com/ and https://docs.wokwi.com/
- arduino-cli getting started (compile/upload command shapes; UNO FQBN is
  `arduino:avr:uno`):
  https://arduino.github.io/arduino-cli/1.5/getting-started/
  - `arduino-cli compile --fqbn arduino:avr:uno <sketch>`
  - `arduino-cli upload -p <port> --fqbn arduino:avr:uno <sketch>`

## Firmware template details

- Adafruit DHT sensor library (source of the `DHT.h` header,
  `DHT dht(pin, DHT11)`, `readTemperature(true)` for Fahrenheit; DHT11
  sampling floor is about 1 s, which caps the "fast" poll tweak at 1000 ms):
  https://github.com/adafruit/DHT-sensor-library

## Test runner note

- `tests/codegen.test.mjs` imports `lib/codegen/template.ts` directly.
  Node >= 23.6 strips types by default (Node 24.14.0 here); `template.ts`
  therefore keeps runtime imports to node builtins and uses `import type`
  for the shared contract, which is erased at runtime.
  https://nodejs.org/api/typescript.html
