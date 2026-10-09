use tauri::Webview;
#[cfg(windows)]
use tauri::{Emitter, EventTarget, Manager};

#[cfg(windows)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationHistory {
    pub current_index: usize,
    pub entries: Vec<HistoryEntry>,
}

#[cfg(windows)]
#[derive(serde::Deserialize)]
pub(crate) struct HistoryEntry {
    pub id: u64,
    pub url: String,
}

#[cfg(windows)]
pub(crate) fn is_website_entry(entry: &HistoryEntry) -> bool {
    entry.url.starts_with("http://") || entry.url.starts_with("https://")
}

#[cfg(windows)]
pub(crate) async fn navigation_history(webview: &Webview) -> Result<NavigationHistory, String> {
    let response =
        call_devtools_response(webview, "Page.getNavigationHistory", "{}".into()).await?;
    serde_json::from_str(&response).map_err(|error| error.to_string())
}

#[cfg(windows)]
pub(crate) fn observe_navigation(webview: &Webview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED;
    use webview2_com::NavigationCompletedEventHandler;
    let app = webview.app_handle().clone();
    webview.with_webview(move |platform| unsafe {
        let result = (|| -> windows_core::Result<()> {
            let core = platform.controller().CoreWebView2()?;
            let handler = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut success = windows_core::BOOL::default();
                    args.IsSuccess(&mut success)?;
                    if !success.as_bool() {
                        let mut status = Default::default();
                        args.WebErrorStatus(&mut status)?;
                        // Cancelled navigations are expected when a newer URL replaces one.
                        if status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                            let _ = app.emit_to(
                                EventTarget::Webview { label: crate::MAIN_WEBVIEW.into() },
                                "pew:load-error",
                                "The website could not be loaded. Check the address and your connection, then reload or try another URL.",
                            );
                        }
                    }
                }
                Ok(())
            }));
            let mut token = 0;
            core.add_NavigationCompleted(&handler, &mut token)?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("PEW could not observe navigation: {error}");
        }
    }).map_err(|error| error.to_string())
}

#[cfg(windows)]
pub(crate) fn disable_browser_shortcuts(webview: &Webview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    webview
        .with_webview(|platform| unsafe {
            let result = (|| -> windows_core::Result<()> {
                let core = platform.controller().CoreWebView2()?;
                let settings = core.Settings()?.cast::<ICoreWebView2Settings3>()?;
                settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
                Ok(())
            })();
            if let Err(error) = result {
                eprintln!("Could not disable browser shortcuts: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) fn disable_browser_shortcuts(_webview: &Webview) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub(crate) async fn call_devtools_response(
    webview: &Webview,
    method: &'static str,
    parameters: String,
) -> Result<String, String> {
    use std::time::Duration;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform| {
            let completion_sender = sender.clone();
            let result = unsafe {
                (|| -> windows_core::Result<()> {
                    let core = platform.controller().CoreWebView2()?;
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |code, response| {
                            let outcome = if code.is_ok() {
                                Ok(response.to_string())
                            } else {
                                Err(format!("{method} failed: {code:?}"))
                            };
                            let _ = completion_sender.try_send(outcome);
                            Ok(())
                        },
                    ));
                    core.CallDevToolsProtocolMethod(
                        &HSTRING::from(method),
                        &HSTRING::from(parameters),
                        &handler,
                    )
                })()
            };
            if let Err(error) = result {
                let _ = sender.try_send(Err(format!("{method} failed: {error}")));
            }
        })
        .map_err(|error| error.to_string())?;

    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .map_err(|_| format!("{method} timed out"))?
        .ok_or_else(|| format!("{method} was cancelled"))?
}

#[cfg(windows)]
pub(crate) async fn call_devtools(
    webview: &Webview,
    method: &'static str,
    parameters: String,
) -> Result<(), String> {
    call_devtools_response(webview, method, parameters)
        .await
        .map(|_| ())
}
#[cfg(windows)]
pub(crate) async fn set_mobile_metrics(
    webview: &Webview,
    width: u32,
    height: u32,
    landscape: bool,
) -> Result<(), String> {
    let metrics = serde_json::json!({
        "width": width.clamp(1, 10000),
        "height": height.clamp(1, 10000),
        "deviceScaleFactor": 3,
        "mobile": true,
        "screenWidth": width.clamp(1, 10000),
        "screenHeight": height.clamp(1, 10000),
        "screenOrientation": {
            "type": if landscape { "landscapePrimary" } else { "portraitPrimary" },
            "angle": if landscape { 90 } else { 0 }
        }
    });
    call_devtools(
        webview,
        "Emulation.setDeviceMetricsOverride",
        metrics.to_string(),
    )
    .await
}
#[cfg(windows)]
pub(crate) async fn emulate_mobile(
    webview: &Webview,
    width: u32,
    height: u32,
    user_agent: &str,
    landscape: bool,
) -> Result<(), String> {
    let major = user_agent
        .split("Chrome/")
        .nth(1)
        .and_then(|version| version.split('.').next())
        .unwrap_or("125");
    let agent = serde_json::json!({
        "userAgent": user_agent,
        "platform": "Linux armv8l",
        "userAgentMetadata": {
            "brands": [
                { "brand": "Chromium", "version": major }

            ],
            "platform": "Android",
            "platformVersion": "14",
            "architecture": "",
            "model": "",
            "mobile": true
        }
    });
    call_devtools(webview, "Emulation.setUserAgentOverride", agent.to_string()).await?;

    set_mobile_metrics(webview, width, height, landscape).await?;
    call_devtools(
        webview,
        "Emulation.setTouchEmulationEnabled",
        r#"{"enabled":true,"maxTouchPoints":5}"#.into(),
    )
    .await?;
    if let Err(error) = call_devtools(
        webview,
        "Emulation.setEmitTouchEventsForMouse",
        r#"{"enabled":true,"configuration":"mobile"}"#.into(),
    )
    .await
    {
        eprintln!("PEW could not map mouse input to touch: {error}");
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) async fn emulate_mobile(
    _webview: &Webview,
    _width: u32,
    _height: u32,
    _user_agent: &str,
    _landscape: bool,
) -> Result<(), String> {
    Ok(())
}
