# PEW

A desktop tool for previewing websites in a mobile viewport.

## Features

- Portrait and landscape views with page state preserved during rotation.
- Address bar, page history, reload, and navigation controls.
- Mobile viewport, touch input, and 3× pixel density on Windows.
- Local development URLs, including loopback and private network addresses.
- Loading indicators and recoverable error messages.

## Development

Requirements: Node.js 22.18 or later, pnpm, and a Rust toolchain. Desktop builds also require the [platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev
```

Enter a URL and press Enter to open it. Edit the address bar to navigate to another page. Escape restores the current address. Home returns to the start screen with the last URL selected.

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

## Project structure

| Path                        | Purpose                               |
| --------------------------- | ------------------------------------- |
| `src/main.ts`               | Interface state and interactions      |
| `src/native.ts`             | Typed desktop browser commands        |
| `src/config.ts`             | Window dimensions and timing settings |
| `src/rotation.ts`           | Window animation                      |
| `src/url.ts`                | URL validation and normalization      |
| `src-tauri/src/commands.rs` | Desktop command handlers              |
| `src-tauri/src/platform.rs` | Native browser integration            |
| `tests/`                    | URL regression tests                  |
