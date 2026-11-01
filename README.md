# PEW

A desktop tool for previewing websites in a mobile viewport.

[Download the latest Windows installer](https://github.com/M0-kii/pew/releases/latest). Release assets include a SHA-256 checksum. Installers are currently unsigned.

## Features

- Fixed 393 × 852 and 852 × 393 viewports, scaled to fit the window.
- Rotation preserves the window position, navigation history, and page state.
- Persistent address bar, grouped navigation controls, and viewport size and display scale.
- Mobile viewport, touch input, and 3× pixel density on Windows.
- Local development URLs, including loopback and private network addresses.
- Loading progress and recoverable errors in a fixed status area that keeps the preview still.
- Stop controls for slow loads and navigation events scoped to the current page.
- Five recent URLs in an address-bar dropdown, stored locally, with a Clear control.
- PNG screenshot export to `Pictures/PEW`, with an Open folder action in the desktop app.
- Matte device frame with rounded display corners in portrait and landscape.

## Development

Requirements: Node.js 22.18 or later, pnpm, and a Rust toolchain. Desktop builds also require the [platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

Enter a URL and press Enter to open it. Edit the address bar to navigate to another page. Escape restores the current address. Home returns to the start screen with the last URL selected.

Use Ctrl+L to select the address, Ctrl+R or F5 to reload, and Alt+Left / Alt+Right to move through page history. These shortcuts work inside the website in the Windows app. Press Down in the address field to open recent URLs, use the arrow keys to select an entry, and press Escape to close the list. Opening the list keeps the current page and its contents intact.

Stop cancels the current load. A load that exceeds 20 seconds is stopped automatically. Home closes the preview, including any pending navigation.

Recent URLs exclude addresses with embedded credentials. Query strings and fragments are omitted from saved history. Use Clear in the address-bar dropdown to remove recent URLs.

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

`pnpm test` includes URL, history, navigation-state, and browser integration tests, including keyboard navigation, recent URLs, and stable error layouts. To include native desktop tests on Windows, build the debug executable and set `PEW_NATIVE_TEST=1` before running the tests. The native suite checks exact viewport sizes, history, cancellation, rotation, and PNG export; exported test files are removed afterward. `cargo test --locked --manifest-path src-tauri/Cargo.toml` also checks native shortcut mappings.

Release-mode integration tests use the `test-driver` feature to configure a loopback-only debugger. The published installer is rebuilt without that feature.

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
