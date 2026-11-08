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
fn shortcut_name(key: u32, control: bool, alt: bool, shift: bool) -> Option<&'static str> {
    match (key, control, alt, shift) {
        (0x4c, true, false, false) => Some("address"),
        (0x52, true, false, false) | (0x74, false, false, false) => Some("reload"),
        (0x25, false, true, false) => Some("back"),
        (0x27, false, true, false) => Some("forward"),
        (0x1b, false, false, false) => Some("stop"),
        _ => None,
    }
}

#[cfg(windows)]
pub(crate) async fn observe_shortcuts(webview: &Webview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use webview2_com::{AcceleratorKeyPressedEventHandler, FocusChangedEventHandler};
    #[link(name = "user32")]
    extern "system" {
        fn GetKeyState(key: i32) -> i16;
    }
    let app = webview.app_handle().clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| unsafe {
                let shortcut_app = app.clone();
                let handler =
                    AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut kind = Default::default();
                        args.KeyEventKind(&mut kind)?;
                        if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                            && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                        {
                            return Ok(());
                        }
                        let mut key = 0;
                        args.VirtualKey(&mut key)?;
                        if let Some(name) = shortcut_name(
                            key,
                            GetKeyState(0x11) < 0,
                            GetKeyState(0x12) < 0,
                            GetKeyState(0x10) < 0,
                        ) {
                            // Escape must still reach the site's dialogs and form controls.
                            if name != "stop" {
                                args.SetHandled(true)?;
                            }
                            let mut status = Default::default();
                            args.PhysicalKeyStatus(&mut status)?;
                            if !status.WasKeyDown.as_bool() {
                                let _ = shortcut_app.emit_to(
                                    EventTarget::Webview {
                                        label: crate::MAIN_WEBVIEW.into(),
                                    },
                                    "pew:shortcut",
                                    name,
                                );
                            }
                        }
                        Ok(())
                    }));
                let focus = FocusChangedEventHandler::create(Box::new(move |_, _| {
                    let _ = app.emit_to(
                        EventTarget::Webview {
                            label: crate::MAIN_WEBVIEW.into(),
                        },
                        "pew:shortcut",
                        "preview-focus",
                    );
                    Ok(())
                }));
                let controller = platform.controller();
                let mut token = 0;
                controller.add_AcceleratorKeyPressed(&handler, &mut token)?;
                controller.add_GotFocus(&focus, &mut token)
            })();
            let _ = sender.try_send(result.map_err(|error| error.to_string()));
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .map_err(|_| "Keyboard setup timed out".to_string())?
        .ok_or_else(|| "Keyboard setup was cancelled".to_string())?
}

#[cfg(all(test, windows))]
mod shortcut_tests {
    use super::shortcut_name;
    #[test]
    fn recognizes_only_unmodified_browser_shortcuts() {
        assert_eq!(shortcut_name(0x4c, true, false, false), Some("address"));
        assert_eq!(shortcut_name(0x52, true, false, false), Some("reload"));
        assert_eq!(shortcut_name(0x25, false, true, false), Some("back"));
        assert_eq!(shortcut_name(0x27, false, true, false), Some("forward"));
        assert_eq!(shortcut_name(0x1b, false, false, false), Some("stop"));
        assert_eq!(shortcut_name(0x74, false, false, false), Some("reload"));
        for key in [0x4c, 0x52, 0x25, 0x27] {
            assert_eq!(shortcut_name(key, false, false, false), None);
            assert_eq!(shortcut_name(key, true, true, false), None);
            assert_eq!(shortcut_name(key, true, false, true), None);
        }
    }
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
    pixel_ratio: u8,
) -> Result<(), String> {
    let metrics = serde_json::json!({
        "width": width.clamp(1, 10000),
        "height": height.clamp(1, 10000),
        "deviceScaleFactor": pixel_ratio,
        "scale": scale.clamp(0.01, 1.0),
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
    .await?;
    round_site_corners(webview, scale).await
}

#[cfg(windows)]
async fn round_site_corners(webview: &Webview, scale: f64) -> Result<(), String> {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetClientRect(window: *mut c_void, rect: *mut Rect) -> i32;
        fn GetDpiForWindow(window: *mut c_void) -> u32;
        fn SetWindowRgn(window: *mut c_void, region: *mut c_void, redraw: i32) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRoundRectRgn(
            left: i32,
            top: i32,
            right: i32,
            bottom: i32,
            width: i32,
            height: i32,
        ) -> *mut c_void;
        fn DeleteObject(object: *mut c_void) -> i32;
    }
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| unsafe {
                let mut parent = Default::default();
                platform
                    .controller()
                    .ParentWindow(&mut parent)
                    .map_err(|error| error.to_string())?;
                let mut rect = Rect::default();
                if GetClientRect(parent.0, &mut rect) == 0 {
                    return Err("Could not measure the preview window".into());
                }
                let diameter =
                    (56.0 * scale * f64::from(GetDpiForWindow(parent.0)) / 96.0).round() as i32;
                // Clip the native child itself; DOM corners cannot mask a separate webview.
                let region =
                    CreateRoundRectRgn(0, 0, rect.right + 1, rect.bottom + 1, diameter, diameter);
                if region.is_null() {
                    return Err("Could not shape the preview window".into());
                }
                if SetWindowRgn(parent.0, region, 1) == 0 {
                    DeleteObject(region);
                    return Err("Could not apply the preview corners".into());
                }
                Ok(())
            })();
            let _ = sender.try_send(result);
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .map_err(|_| "Preview styling timed out".to_string())?
        .ok_or_else(|| "Preview styling was cancelled".to_string())?
}
#[cfg(windows)]
pub(crate) async fn emulate_mobile(
    webview: &Webview,
    width: u32,
    height: u32,
    user_agent: &str,
    landscape: bool,
    scale: f64,
    pixel_ratio: u8,
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

    set_mobile_metrics(webview, width, height, landscape, scale, pixel_ratio).await?;
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
    _pixel_ratio: u8,
) -> Result<(), String> {
    Ok(())
}
