# References — delta build 2, bench builder

Official sources verified on 2026-07-23 before writing lib/bench/**, app/api/bench/**,
app/api/flash/route.ts. arduino-cli version installed and probed locally: **1.5.1**
(Linux 64bit, installed to `<app>/bin/arduino-cli` by the official script).
`https://arduino.github.io/arduino-cli/latest/...` redirects to the versioned
`/1.5/` pages; deep links below point at `/1.5/`.

## arduino-cli command reference (docs consulted)

- Installation script:
  https://arduino.github.io/arduino-cli/1.5/installation/
  - Exact command: `curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh`
  - Install dir override: `BINDIR=<dir>` env var on the `sh` invocation
    (default is `$PWD/bin`).
- `board list`:
  https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_board_list/
  - Synopsis `arduino-cli board list [flags]`; JSON via the global `--json`
    flag; `--discovery-timeout duration` (default 1s); `-w/--watch` exists but
    is not used here (we poll instead).
- `compile`:
  https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_compile/
  - `arduino-cli compile [flags] <sketch-dir>`, `-b/--fqbn string`, `--json`,
    `--build-path string` (explicit build output dir; we pass one so upload can
    reuse it via `--input-dir`).
- `upload`:
  https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_upload/
  - `arduino-cli upload [flags] <sketch-dir>`, `-p/--port string`
    (e.g. `COM3` or `/dev/ttyACM0`), `-b/--fqbn string`,
    `--input-dir string` (dir containing the compiled binaries), `--json`.
  - Upload never compiles; compile must run first (documented on the page).
- `monitor`:
  https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_monitor/
  - `arduino-cli monitor -p <port> --config <ID>=<value>` (baudrate via
    `-c/--config`, docs example `--config 115200`), `-q/--quiet`.
  - No built-in exit timeout is documented; the handshake spawns the process,
    reads until the first newline, and kills it after a deadline.
- `core install` / `core update-index`:
  https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_core_install/
  https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_core_update-index/
  - `arduino-cli core install arduino:avr`, `--json` supported.
- `version`: probed locally (see below);
  https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_version/

## JSON output shapes (gRPC message reference + local probes)

- Message field names (snake_case in JSON):
  https://arduino.github.io/arduino-cli/1.5/rpc/commands/
  - `DetectedPort`: `port` (Port), `matching_boards` (BoardListItem[]).
  - `Port`: `address`, `label`, `protocol`, `protocol_label`, `properties`,
    `hardware_id`.
  - `BoardListItem`: `name`, `fqbn`, `is_hidden`, `platform`.

Probed against the installed 1.5.1 binary on 2026-07-23:

- `arduino-cli version --json` →
  `{"Application":"arduino-cli","VersionString":"1.5.1","Commit":"01f3d4f2b","Status":"","Date":"..."}`
  (note: these keys are PascalCase, unlike the gRPC messages).
- `arduino-cli board list --json` → `{"detected_ports": [...]}`
  (empty array in WSL without usbipd — WSL2 cannot see USB serial ports).
- `arduino-cli core list --json` →
  `{"platforms":[{"id":"arduino:avr","installed_version":"1.8.8","latest_version":"1.8.8",...}]}`.
- `core install arduino:avr` landed platform `arduino:avr@1.8.8`.

## WSL specifics

- WSL2 has no native USB serial passthrough; a Linux arduino-cli binary lists
  zero ports even with a board plugged into the laptop. Options: point
  `ARDUINO_CLI_PATH` at a Windows `arduino-cli.exe` (WSL interop runs it and it
  sees `COM*` ports), or bridge the device with usbipd-win:
  https://learn.microsoft.com/en-us/windows/wsl/connect-usb
