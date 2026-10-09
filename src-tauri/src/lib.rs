use tauri::{AppHandle, Emitter, EventTarget, Manager, Webview};

fn site(app: &AppHandle, caller: &Webview) -> Result<Webview, String> {
    if caller.label() != "main" {
        return Err("This command is only available to the PEW interface".into());
    }
    app.get_webview("site")
        .ok_or_else(|| "No website is open yet".into())
}

#[tauri::command]
fn navigate_site(app: AppHandle, caller: Webview, url: String) -> Result<(), String> {
    let parsed = url.parse::<tauri::Url>().map_err(|_| "Invalid URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS websites can be opened".into());
    }
    site(&app, &caller)?
        .navigate(parsed)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn site_action(app: AppHandle, caller: Webview, action: String) -> Result<(), String> {
    let webview = site(&app, &caller)?;
    #[cfg(windows)]
    if action == "back" || action == "forward" {
        let history = navigation_history(&webview).await?;
        let entries = history["entries"]
            .as_array()
            .ok_or("Missing navigation history")?;
        let index = history["currentIndex"]
            .as_u64()
            .ok_or("Missing history index")? as usize;
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
                serde_json::json!({ "entryId": entry["id"] }).to_string(),
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
async fn site_state(
    app: AppHandle,
    caller: Webview,
) -> Result<(String, Option<bool>, Option<bool>), String> {
    let webview = site(&app, &caller)?;
    let url = webview
        .url()
        .map_err(|error| error.to_string())?
        .to_string();
    #[cfg(windows)]
    {
        let history = navigation_history(&webview).await?;
        let entries = history["entries"]
            .as_array()
            .ok_or("Missing navigation history")?;
        let index = history["currentIndex"]
            .as_u64()
            .ok_or("Missing history index")? as usize;
        let back = entries.iter().take(index).any(is_website_entry);
        let forward = entries.iter().skip(index + 1).any(is_website_entry);
        Ok((url, Some(back), Some(forward)))
    }
    #[cfg(not(windows))]
    Ok((url, None, None))
}

#[cfg(windows)]
fn is_website_entry(entry: &serde_json::Value) -> bool {
    entry["url"]
        .as_str()
        .is_some_and(|url| url.starts_with("http://") || url.starts_with("https://"))
}

#[cfg(windows)]
async fn navigation_history(webview: &Webview) -> Result<serde_json::Value, String> {
    let response =
        call_devtools_response(webview, "Page.getNavigationHistory", "{}".into()).await?;
    serde_json::from_str(&response).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn observe_navigation(webview: &Webview) -> Result<(), String> {
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
                        if status != webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                            let _ = app.emit_to(EventTarget::Webview { label: "main".into() }, "pew:load-error", "The website could not be loaded. Check the address and your connection, then reload or try another URL.");
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
fn disable_browser_shortcuts(webview: &Webview) -> Result<(), String> {
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
                eprintln!("PEW could not disable WebView2 browser shortcuts: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn disable_browser_shortcuts(_webview: &Webview) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
async fn call_devtools_response(
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
async fn call_devtools(
    webview: &Webview,
    method: &'static str,
    parameters: String,
) -> Result<(), String> {
    call_devtools_response(webview, method, parameters)
        .await
        .map(|_| ())
}
#[cfg(windows)]
async fn set_mobile_metrics(
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
async fn emulate_mobile(
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
                { "brand": "Chromium", "version": major },
                { "brand": "Google Chrome", "version": major }
            ],
            "platform": "Android",
            "platformVersion": "14",
            "architecture": "",
            "model": "Pixel 8",
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
async fn emulate_mobile(
    _webview: &Webview,
    _width: u32,
    _height: u32,
    _user_agent: &str,
    _landscape: bool,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn configure_site(
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
async fn resize_site(
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
async fn site_snapshot(app: AppHandle, caller: Webview) -> Result<String, String> {
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
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if webview.label() == "site" && matches!(payload.url().scheme(), "http" | "https") {
                let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
                let _ = webview.emit_to(
                    EventTarget::Webview {
                        label: "main".into(),
                    },
                    "pew:page-load",
                    (payload.url().as_str(), started),
                );
            }
        })
        .setup(|app| {
            let main = app
                .get_webview("main")
                .expect("PEW main webview is missing");
            disable_browser_shortcuts(&main).expect("Could not configure PEW shortcuts");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            navigate_site,
            site_action,
            site_state,
            configure_site,
            resize_site,
            site_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running PEW");
}
