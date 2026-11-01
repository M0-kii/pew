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
async fn with_core(
    webview: &Webview,
    action: impl FnOnce(
            webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
        ) -> windows_core::Result<()>
        + Send
        + 'static,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform| {
            let result = unsafe { platform.controller().CoreWebView2() }.and_then(action);
            let _ = sender.try_send(result.map_err(|error| error.to_string()));
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .map_err(|_| "Browser setup timed out".to_string())?
        .ok_or_else(|| "Browser setup was cancelled".to_string())?
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NavigationEvent {
    pub session: u64,
    pub id: String,
    pub phase: &'static str,
    pub url: String,
}

#[cfg(windows)]
pub(crate) async fn observe_navigation(webview: &Webview, session: u64) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED;
    use webview2_com::{NavigationCompletedEventHandler, NavigationStartingEventHandler};
    let app = webview.app_handle().clone();
    with_core(webview, move |core| unsafe {
        let current = Arc::new(AtomicU64::new(0));
        let latest = current.clone();
        let started_app = app.clone();
        let start = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut id = 0;
                args.NavigationId(&mut id)?;
                latest.store(id, Ordering::SeqCst);
                let _ = started_app.emit_to(
                    EventTarget::Webview {
                        label: crate::MAIN_WEBVIEW.into(),
                    },
                    "pew:navigation",
                    NavigationEvent {
                        session,
                        id: id.to_string(),
                        phase: "started",
                        url: String::new(),
                    },
                );
            }
            Ok(())
        }));
        let done = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut id = 0;
                args.NavigationId(&mut id)?;
                if current.load(Ordering::SeqCst) != id {
                    return Ok(());
                }
                let mut success = windows_core::BOOL::default();
                args.IsSuccess(&mut success)?;
                let mut status = Default::default();
                args.WebErrorStatus(&mut status)?;
                let phase = if success.as_bool() {
                    "finished"
                } else if status == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                    "cancelled"
                } else {
                    "failed"
                };
                let _ = app.emit_to(
                    EventTarget::Webview {
                        label: crate::MAIN_WEBVIEW.into(),
                    },
                    "pew:navigation",
                    NavigationEvent {
                        session,
                        id: id.to_string(),
                        phase,
                        url: String::new(),
                    },
                );
            }
            Ok(())
        }));
        let mut token = 0;
        core.add_NavigationStarting(&start, &mut token)?;
        core.add_NavigationCompleted(&done, &mut token)?;
        Ok(())
    })
    .await
}

#[cfg(windows)]
pub(crate) async fn stop(webview: &Webview) -> Result<(), String> {
    with_core(webview, |core| unsafe { core.Stop() }).await
}

#[cfg(windows)]
pub(crate) async fn disable_browser_shortcuts(webview: &Webview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;
    with_core(webview, |core| unsafe {
        core.Settings()?
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)
    })
    .await
}

#[cfg(not(windows))]
pub(crate) async fn disable_browser_shortcuts(_webview: &Webview) -> Result<(), String> {
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
    scale: f64,
) -> Result<(), String> {
    let metrics = serde_json::json!({
        "width": width.clamp(1, 10000),
        "height": height.clamp(1, 10000),
        "deviceScaleFactor": 3,
        "scale": scale.clamp(0.1, 1.0),
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
    scale: f64,
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

    set_mobile_metrics(webview, width, height, landscape, scale).await?;
    call_devtools(
        webview,
        "Emulation.setTouchEmulationEnabled",
        r#"{"enabled":true,"maxTouchPoints":5}"#.into(),
    )
    .await?;
    call_devtools(
        webview,
        "Emulation.setEmitTouchEventsForMouse",
        r#"{"enabled":true,"configuration":"mobile"}"#.into(),
    )
    .await?;
    Ok(())
}

#[cfg(not(windows))]
pub(crate) async fn emulate_mobile(
    _webview: &Webview,
    _width: u32,
    _height: u32,
    _user_agent: &str,
    _landscape: bool,
    _scale: f64,
) -> Result<(), String> {
    Ok(())
}
