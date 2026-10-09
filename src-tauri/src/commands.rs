#[cfg(windows)]
use crate::platform::{
    call_devtools, call_devtools_response, is_website_entry, navigation_history,
    observe_navigation, set_mobile_metrics,
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

pub(crate) fn site(app: &AppHandle, caller: &Webview) -> Result<Webview, String> {
    if caller.label() != MAIN_WEBVIEW {
        return Err("This command is only available to the PEW interface".into());
    }
    app.get_webview(SITE_WEBVIEW)
        .ok_or_else(|| "No website is open yet".into())
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
    width: u32,
    height: u32,
    user_agent: String,
    landscape: bool,
) -> Result<(), String> {
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    observe_navigation(&webview)?;
    disable_browser_shortcuts(&webview)?;
    emulate_mobile(&webview, width, height, &user_agent, landscape).await
}

#[tauri::command]
pub(crate) async fn resize_site(
    app: AppHandle,
    caller: Webview,
    width: u32,
    height: u32,
    landscape: bool,
) -> Result<(), String> {
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    set_mobile_metrics(&webview, width, height, landscape).await?;
    #[cfg(not(windows))]
    let _ = (webview, width, height, landscape);
    Ok(())
}
#[tauri::command]
pub(crate) async fn site_snapshot(app: AppHandle, caller: Webview) -> Result<String, String> {
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    {
        let response = call_devtools_response(
            &webview,
            "Page.captureScreenshot",
            r#"{"format":"jpeg","quality":78,"captureBeyondViewport":false}"#.into(),
        )
        .await?;
        let payload: serde_json::Value =
            serde_json::from_str(&response).map_err(|error| error.to_string())?;
        let data = payload["data"]
            .as_str()
            .ok_or_else(|| "Screenshot data is missing".to_string())?;
        Ok(format!("data:image/jpeg;base64,{data}"))
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Err("Website snapshots are only available on Windows".into())
    }
}
