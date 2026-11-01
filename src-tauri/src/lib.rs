mod commands;
mod platform;

pub(crate) const MAIN_WEBVIEW: &str = "main";
pub(crate) const SITE_WEBVIEW: &str = "site";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::configure_interface,
            commands::navigate_site,
            commands::site_action,
            commands::site_state,
            commands::configure_site,
            commands::resize_site,
            commands::site_snapshot,
            commands::export_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running PEW");
}
