# PEW

A desktop tool for previewing websites in a mobile viewport.

[Download the latest Windows installer](https://github.com/M0-kii/pew/releases/latest). Release assets include a SHA-256 checksum. Installers are currently unsigned.

## Features

- Fixed 393 × 852 and 852 × 393 viewports, scaled to fit the window.
- Rotation preserves the window position, navigation history, and page state.
- Address bar, page history, reload, and navigation controls.
- Mobile viewport, touch input, and 3× pixel density on Windows.
- Local development URLs, including loopback and private network addresses.
- Loading indicators and recoverable error messages.
- Stop controls for slow loads and navigation events scoped to the current page.
- Five recent URLs, stored locally, with a Clear control.
- PNG screenshot export to `Pictures/PEW` in the desktop app.

## Development

Requirements: Node.js 22.18 or later, pnpm, and a Rust toolchain. Desktop builds also require the [platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

Enter a URL and press Enter to open it. Edit the address bar to navigate to another page. Escape restores the current address. Home returns to the start screen with the last URL selected.

Stop cancels the current load. A load that exceeds 20 seconds is stopped automatically. Home closes the preview, including any pending navigation.

Recent URLs exclude addresses with embedded credentials. Query strings and fragments are omitted from saved history. Use Clear on the start screen to remove recent URLs.

Addresses default to HTTPS. Localhost, loopback, and private network addresses default to HTTP unless a scheme is provided.

`pnpm dev` runs the interface in a browser. This preview uses an iframe, so websites must allow embedding. Page history and native mobile emulation require the desktop app.

## Build

```sh
pnpm tauri build
```

## Checks

```sh
pnpm test
pnpm build
pnpm format:check
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Install the test browser once before running integration tests:

```sh
pnpm exec playwright install chromium
```

`pnpm test` includes URL, history, navigation-state, and browser integration tests. To include native desktop tests on Windows, build the debug executable and set `PEW_NATIVE_TEST=1` before running the tests. The native suite checks exact viewport sizes, history, cancellation, rotation, and PNG export; exported test files are removed afterward.

## Releases

Checks run for pushes and pull requests. To publish a release, update the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, update the lockfiles, then push a matching `vX.Y.Z` tag. The release workflow runs the full Windows test suite before building and publishing the installer and checksum.

## Project structure

| Path                        | Purpose                               |
| --------------------------- | ------------------------------------- |
| `src/main.ts`               | Interface state and interactions      |
| `src/native.ts`             | Typed desktop browser commands        |
| `src/config.ts`             | Window dimensions and timing settings |
| `src/rotation.ts`           | Position-preserving window resizing   |
| `src/navigation.ts`         | Navigation identity and cancellation  |
| `src/history.ts`            | Local recent-URL storage              |
| `src/url.ts`                | URL validation and normalization      |
| `src-tauri/src/commands.rs` | Desktop command handlers              |
| `src-tauri/src/platform.rs` | Native browser integration            |
| `tests/`                    | Unit and integration tests            |
