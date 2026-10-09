# PEW

PEW is a compact Tauri desktop tool for testing web apps in an iPhone-style view. The app window has a transparent surround, leaving just the phone and a floating black and white control bar.

## Run locally

Install Node.js 22.18 or later, pnpm, and Rust, then run:

    pnpm install
    pnpm tauri dev

Enter a URL in the middle of the phone and press Enter, or click the arrow. The website then fills the phone screen. An address bar appears in the control bar; edit it to open another website, or press Escape to restore the current URL. Home returns to the URL input with the last address selected. The control bar provides Back, Forward, Reload, Rotate, Minimize, and Close. Rotate smoothly resizes the PEW window and phone between portrait and landscape while keeping the current page open.

The address bar displays loading progress until the page finishes. Slow loads restore the controls after 20 seconds so you can reload, change the URL, or return Home. Failed loads on Windows display a dismissible message. Back and Forward on Windows follow the actual page history and skip the initial blank page.

PEW adds `https://` when a scheme is omitted, or `http://` for localhost, loopback IPv6, and private LAN addresses. On Windows, PEW loads sites in a separate native WebView2 and applies mobile viewport, 3× pixel ratio, touch, and Android user agent emulation before the first site navigation. WebView2's default browser shortcuts are disabled. This simulates a mobile browser for web app testing; it does not run Android itself.

`pnpm dev` opens a browser preview of the interface. Its iframe preview depends on the website allowing embedding; Back and Forward are disabled there. Use `pnpm tauri dev` for the native website viewer and mobile emulation.

## Build

    pnpm tauri build

## Checks

    pnpm test
    pnpm build
    cargo check --locked --manifest-path src-tauri/Cargo.toml
