mod commands;
mod platform;

use tauri::{Emitter, EventTarget, Manager};

pub(crate) const MAIN_WEBVIEW: &str = "main";
pub(crate) const SITE_WEBVIEW: &str = "site";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if webview.label() == SITE_WEBVIEW && matches!(payload.url().scheme(), "http" | "https")
            {
                let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
                let _ = webview.emit_to(
                    EventTarget::Webview {
                        label: MAIN_WEBVIEW.into(),
                    },
                    "pew:page-load",
                    (payload.url().as_str(), started),
                );
            }
        })
        .setup(|app| {
            let main = app
                .get_webview(MAIN_WEBVIEW)
                .expect("PEW main webview is missing");
            platform::disable_browser_shortcuts(&main)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::navigate_site,
            commands::site_action,
            commands::site_state,
            commands::configure_site,
            commands::resize_site,
            commands::site_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running PEW");
}
