#[cfg(windows)]
use crate::platform::{
    call_devtools, call_devtools_response, is_website_entry, navigation_history,
    observe_navigation, observe_shortcuts, set_mobile_metrics,
};
use crate::platform::{disable_browser_shortcuts, emulate_mobile};
use crate::{MAIN_WEBVIEW, SITE_WEBVIEW};
use tauri::{AppHandle, Manager, Webview};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SiteState {
    url: String,
    can_go_back: Option<bool>,
    can_go_forward: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SiteConfiguration {
    width: u32,
    height: u32,
    pixel_ratio: u8,
    user_agent: String,
    landscape: bool,
    scale: f64,
    session: u64,
}

pub(crate) fn site(app: &AppHandle, caller: &Webview) -> Result<Webview, String> {
    if caller.label() != MAIN_WEBVIEW {
        return Err("This command is only available to the PEW interface".into());
    }
    app.get_webview(SITE_WEBVIEW)
        .ok_or_else(|| "No website is open yet".into())
}

#[tauri::command]
pub(crate) async fn configure_interface(caller: Webview) -> Result<Option<String>, String> {
    if caller.label() != MAIN_WEBVIEW {
        return Err("This command is only available to the PEW interface".into());
    }
    disable_browser_shortcuts(&caller).await?;
    Ok(crate::test_browser_args())
}

#[tauri::command]
pub(crate) fn navigate_site(app: AppHandle, caller: Webview, url: String) -> Result<(), String> {
    let parsed = url.parse::<tauri::Url>().map_err(|_| "Invalid URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS websites can be opened".into());
    }
    site(&app, &caller)?
        .navigate(parsed)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn site_action(
    app: AppHandle,
    caller: Webview,
    action: String,
) -> Result<(), String> {
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    if action == "stop" {
        return crate::platform::stop(&webview).await;
    }
    #[cfg(windows)]
    if action == "back" || action == "forward" {
        let history = navigation_history(&webview).await?;
        let entries = &history.entries;
        let index = history.current_index;
        let target = if action == "back" {
            entries
                .iter()
                .take(index)
                .rev()
                .find(|entry| is_website_entry(entry))
        } else {
            entries
                .iter()
                .skip(index + 1)
                .find(|entry| is_website_entry(entry))
        };
        if let Some(entry) = target {
            call_devtools(
                &webview,
                "Page.navigateToHistoryEntry",
                serde_json::json!({ "entryId": entry.id }).to_string(),
            )
            .await?;
        }
        return Ok(());
    }
    match action.as_str() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        "stop" => webview.eval("window.stop()"),
        _ => return Err("Unknown browser action".into()),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn site_state(app: AppHandle, caller: Webview) -> Result<SiteState, String> {
    let webview = site(&app, &caller)?;
    let url = webview
        .url()
        .map_err(|error| error.to_string())?
        .to_string();
    #[cfg(windows)]
    {
        let history = navigation_history(&webview).await?;
        let entries = &history.entries;
        let index = history.current_index;
        let back = entries.iter().take(index).any(is_website_entry);
        let forward = entries.iter().skip(index + 1).any(is_website_entry);
        Ok(SiteState {
            url,
            can_go_back: Some(back),
            can_go_forward: Some(forward),
        })
    }
    #[cfg(not(windows))]
    Ok(SiteState {
        url,
        can_go_back: None,
        can_go_forward: None,
    })
}

#[tauri::command]
pub(crate) async fn configure_site(
    app: AppHandle,
    caller: Webview,
    options: SiteConfiguration,
) -> Result<(), String> {
    let SiteConfiguration {
        width,
        height,
        pixel_ratio,
        user_agent,
        landscape,
        scale,
        session,
    } = options;
    validate_viewport(width, height, pixel_ratio, scale)?;
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    observe_navigation(&webview, session).await?;
    #[cfg(windows)]
    observe_shortcuts(&webview).await?;
    #[cfg(not(windows))]
    let _ = session;
    disable_browser_shortcuts(&webview).await?;
    emulate_mobile(
        &webview,
        width,
        height,
        &user_agent,
        landscape,
        scale,
        pixel_ratio,
    )
    .await
}

#[tauri::command]
pub(crate) fn open_screenshot_folder(app: AppHandle, caller: Webview) -> Result<(), String> {
    if caller.label() != MAIN_WEBVIEW {
        return Err("This command is only available to the PEW interface".into());
    }
    #[cfg(windows)]
    {
        let directory = app
            .path()
            .picture_dir()
            .map_err(|error| error.to_string())?
            .join("PEW");
        if !directory.is_dir() {
            return Err("The screenshot folder does not exist yet".into());
        }
        std::process::Command::new("explorer.exe")
            .arg(directory)
            .spawn()
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Screenshot export is unavailable on this platform".into())
    }
}

#[tauri::command]
pub(crate) async fn resize_site(
    app: AppHandle,
    caller: Webview,
    width: u32,
    height: u32,
    landscape: bool,
    scale: f64,
    pixel_ratio: u8,
) -> Result<(), String> {
    validate_viewport(width, height, pixel_ratio, scale)?;
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    set_mobile_metrics(&webview, width, height, landscape, scale, pixel_ratio).await?;
    #[cfg(not(windows))]
    let _ = (webview, width, height, landscape, scale, pixel_ratio);
    Ok(())
}

fn validate_viewport(width: u32, height: u32, pixel_ratio: u8, scale: f64) -> Result<(), String> {
    if !(240..=1920).contains(&width) || !(240..=1920).contains(&height) {
        return Err("Viewport dimensions must be between 240 and 1920".into());
    }
    if !(1..=3).contains(&pixel_ratio) || !scale.is_finite() || !(0.01..=1.0).contains(&scale) {
        return Err("Invalid viewport density or display scale".into());
    }
    Ok(())
}

#[cfg(test)]
mod viewport_tests {
    use super::validate_viewport;
    #[test]
    fn rejects_unsupported_metrics_at_the_command_boundary() {
        assert!(validate_viewport(393, 852, 3, 0.8).is_ok());
        assert!(validate_viewport(240, 1920, 1, 0.01).is_ok());
        for (width, height, density, scale) in [
            (0, 852, 3, 0.8),
            (393, 1921, 3, 0.8),
            (393, 852, 0, 0.8),
            (393, 852, 4, 0.8),
            (393, 852, 3, f64::NAN),
            (393, 852, 3, 0.0),
        ] {
            assert!(validate_viewport(width, height, density, scale).is_err());
        }
    }
}
#[tauri::command]
pub(crate) async fn site_snapshot(app: AppHandle, caller: Webview) -> Result<String, String> {
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    {
        let response = call_devtools_response(
            &webview,
            "Page.captureScreenshot",
            r#"{"format":"png","captureBeyondViewport":false}"#.into(),
        )
        .await?;
        let payload: serde_json::Value =
            serde_json::from_str(&response).map_err(|error| error.to_string())?;
        let data = payload["data"]
            .as_str()
            .ok_or_else(|| "Screenshot data is missing".to_string())?;
        Ok(format!("data:image/png;base64,{data}"))
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err("Website snapshots are only available on Windows".into())
    }
}

#[tauri::command]
pub(crate) async fn export_snapshot(app: AppHandle, caller: Webview) -> Result<String, String> {
    let snapshot = site_snapshot(app.clone(), caller).await?;
    #[cfg(windows)]
    {
        use base64::Engine;
        use std::io::Write;
        let encoded = snapshot
            .strip_prefix("data:image/png;base64,")
            .ok_or("Invalid screenshot format")?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| error.to_string())?;
        let directory = app
            .path()
            .picture_dir()
            .map_err(|error| error.to_string())?
            .join("PEW");
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        let path = directory.join(format!("pew-{timestamp}.png"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        if let Err(error) = file.write_all(&data) {
            let _ = std::fs::remove_file(&path);
            return Err(error.to_string());
        }
        Ok(path.to_string_lossy().into_owned())
    }
    #[cfg(not(windows))]
    {
        let _ = snapshot;
        Err("Screenshot export is unavailable on this platform".into())
    }
}
