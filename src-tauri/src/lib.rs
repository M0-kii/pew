mod commands;
mod platform;

pub(crate) const MAIN_WEBVIEW: &str = "main";
pub(crate) const SITE_WEBVIEW: &str = "site";

pub(crate) fn test_browser_args() -> Option<String> {
    #[cfg(any(debug_assertions, feature = "test-driver"))]
    {
        if std::env::var("PEW_NATIVE_TEST").as_deref() != Ok("1") {
            return None;
        }
        let port = std::env::var("PEW_TEST_DEBUG_PORT")
            .ok()?
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)?;
        Some(format!(
            "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1 --disable-gpu"
        ))
    }
    #[cfg(not(any(debug_assertions, feature = "test-driver")))]
    {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(any(debug_assertions, feature = "test-driver"))]
    if let Some(arguments) = test_browser_args() {
        for window in &mut context.config_mut().app.windows {
            window.additional_browser_args = Some(arguments.clone());
            window.devtools = Some(true);
        }
    }
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
        .run(context)
        .expect("error while running PEW");
}
