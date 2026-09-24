# @code-yeongyu/senpi-desktop-engine

Finds the `senpi-desktop-engine` binary (`crates/senpi-desktop-engine`) for this host and checks it speaks the host's protocol. It does not implement any desktop behavior.

## Contract

- `locateDesktopEngine()` returns `{ path, diagnostic: null }` or `{ path: null, diagnostic }`. It checks these paths in order:
  1. compiled sidecar: `<dirname(process.execPath)>/native/prebuilds/<platform>-<arch>/senpi-desktop-engine[.exe]`
  2. vendored prebuild: `native/prebuilds/<platform>-<arch>/senpi-desktop-engine[.exe]` in this package
  3. dev build: `<repo>/target/release/senpi-desktop-engine[.exe]`

  A candidate that is missing, lacks the executable bit, or carries macOS `com.apple.quarantine` is skipped. The quarantine attribute is detected and never cleared. The diagnostic `code` is `quarantined` when a skipped candidate was quarantined, otherwise `native-unavailable`, and it lists every attempted path.
- `helloDesktopEngine(path)` spawns the binary with `--stdio`, sends `engine.hello`, and resolves only when `abi === ENGINE_ABI` and `protocolVersion === PROTOCOL_VERSION` from `@code-yeongyu/senpi-desktop-protocol`. On any other ABI or protocol version it throws `DesktopEngineAbiMismatchError` (`code: "abi-mismatch"`, naming both versions). When no well-formed reply arrives it throws `DesktopEngineHandshakeError` (`code: "handshake-failed"`). This handshake is the ABI sentinel.
- `./native` resolves only the vendored host prebuild, without spawning it.

## Prebuilds

Only the host prebuild is committed, as `packages/pty` does. `bun run check:prebuild` rebuilds it with `cargo build --release -p senpi-desktop-engine --locked` and `--remap-path-prefix`, then byte-compares the rebuilt binary against the committed one. Pass `-- --update` to re-vendor it. `node scripts/build-desktop-engine-local.mjs` builds the dev candidate into `target/release/`.
