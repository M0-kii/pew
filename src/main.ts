import { isTauri } from '@tauri-apps/api/core';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Webview, getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  createIcons,
  ArrowLeft,
  ArrowRight,
  House,
  RefreshCw,
  RotateCwSquare,
  Globe,
  ChevronDown,
  Smartphone,
  Minus,
  X,
  Square,
  Camera,
} from 'lucide';
import './style.css';
import ui from './ui.html?raw';
import { formatUrl } from './url';
import { TIMING, VIEWPORT_SIZE, type Orientation, type ViewState } from './config';
import { requireElement } from './dom';
import { nativeBrowser, mobileUserAgent, type NavigationAction } from './native';
import { resizeWindow } from './rotation';
import { NavigationTracker, type NavigationEvent } from './navigation';
import { recentUrls, rememberUrl, HISTORY_KEY } from './history';

requireElement<HTMLDivElement>('#app').innerHTML = ui;
createIcons({
  icons: {
    ArrowLeft,
    ArrowRight,
    House,
    RefreshCw,
    RotateCwSquare,
    Globe,
    ChevronDown,
    Smartphone,
    Minus,
    X,
    Square,
    Camera,
  },
});
const viewport = requireElement<HTMLDivElement>('#site-viewport');
const phone = requireElement<HTMLElement>('.phone');
const stage = requireElement<HTMLDivElement>('.device-stage');
const deviceScale = requireElement<HTMLDivElement>('.device-scale');
const toolbar = requireElement<HTMLElement>('.toolbar');
const emptyState = requireElement<HTMLDivElement>('#empty-state');
const loadingState = requireElement<HTMLDivElement>('#loading-state');
const addressForm = requireElement<HTMLFormElement>('#address-form');
const addressInput = requireElement<HTMLInputElement>('#address-input');
const addressStatus = requireElement<HTMLSpanElement>('#address-status');
const addressGo = requireElement<HTMLButtonElement>('#address-go');
const notice = requireElement<HTMLDivElement>('#notice');
const noticeText = requireElement<HTMLSpanElement>('#notice-text');
const noticeAction = requireElement<HTMLButtonElement>('#notice-action');
const previewStatus = requireElement<HTMLDivElement>('#preview-status');
const recentButton = requireElement<HTMLButtonElement>('#recent-button');
const recentSection = requireElement<HTMLElement>('#recent-section');
const buttons = Object.fromEntries(
  ['back', 'forward', 'home', 'reload', 'stop', 'rotate', 'screenshot'].map((name) => [
    name,
    requireElement<HTMLButtonElement>(`#${name}-button`),
  ]),
);
const appWindow = isTauri() ? getCurrentWindow() : null;
const navigation = new NavigationTracker();
let siteWebview: Webview | null = null;
let browserFrame: HTMLIFrameElement | null = null;
let phase: ViewState = 'empty';
let orientation: Orientation = 'portrait';
let activeUrl = '';
let epoch = 0;
let session = 0;
let stopping = false;
let canGoBack = false;
let canGoForward = false;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let syncTask = Promise.resolve();
let lastBounds = '';
let refreshing = false;
let browserArguments: string | undefined;
let rotationResume: ViewState = 'empty';
let noticeCallback: (() => void) | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let retryUrl = '';

function setPhase(value: ViewState): void {
  phase = value;
  const loading = value === 'loading' || value === 'opening';
  const busy = value === 'rotating' || value === 'closing';
  const hasSite = Boolean(siteWebview || browserFrame);
  emptyState.hidden = value !== 'empty';
  loadingState.hidden = !loading || hasSite;
  viewport.dataset.state = value;
  viewport.setAttribute('aria-busy', String(loading));
  toolbar.dataset.loading = String(loading);
  const status = loading ? 'Loading…' : busy ? 'Updating…' : hasSite ? 'Ready' : 'Mobile preview';
  if (addressStatus.textContent !== status) addressStatus.textContent = status;
  addressStatus.dataset.loading = String(loading);
  buttons.home.disabled = busy || !hasSite;
  buttons.reload.hidden = loading;
  buttons.stop.hidden = !loading;
  buttons.stop.disabled = busy || !hasSite;
  buttons.reload.disabled = busy || !hasSite;
  buttons.back.disabled = busy || loading || !canGoBack;
  buttons.forward.disabled = busy || loading || !canGoForward;
  buttons.rotate.disabled = busy || loading;
  buttons.screenshot.disabled = busy || loading || !siteWebview;
  buttons.screenshot.title = isTauri()
    ? 'Save screenshot to Pictures/PEW'
    : 'Screenshot export requires the desktop app';
  addressGo.disabled = busy || value === 'opening';
  addressInput.readOnly = busy;
  recentButton.disabled = busy || value === 'opening';
  void syncLayout().catch((error: unknown) => showNotice(String(error)));
}

function dismissNotice(): void {
  clearTimeout(noticeTimer);
  noticeAction.removeAttribute('title');
  notice.hidden = true;
  previewStatus.hidden = false;
  noticeCallback = undefined;
}

function showNotice(
  message: string,
  kind: 'error' | 'success' = 'error',
  action?: { label: string; run: () => void },
): void {
  clearTimeout(noticeTimer);
  noticeAction.removeAttribute('title');
  notice.dataset.kind = kind;
  noticeText.textContent = message;
  noticeText.title = message;
  noticeText.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  noticeAction.hidden = !action;
  noticeAction.textContent = action?.label ?? '';
  noticeCallback = action?.run;
  previewStatus.hidden = true;
  notice.hidden = false;
  if (kind === 'success') noticeTimer = setTimeout(dismissNotice, 8_000);
}

function beginLoading(): void {
  clearTimeout(loadTimer);
  setRecentOpen(false);
  dismissNotice();
  if (phase === 'rotating') rotationResume = 'loading';
  else setPhase('loading');
  const version = epoch;
  loadTimer = setTimeout(() => {
    void stopLoading().then(() => {
      if (version + 1 === epoch)
        showNotice('The website took too long to load.', 'error', retryAction());
    });
  }, TIMING.pageLoad);
}

function finishLoading(): void {
  clearTimeout(loadTimer);
  const next = siteWebview || browserFrame ? 'ready' : 'empty';
  if (phase === 'rotating') rotationResume = next;
  else setPhase(next);
}

function reportError(error: unknown): void {
  finishLoading();
  const message = error instanceof Error ? error.message : String(error);
  showNotice(message, 'error', retryAction());
}

function retryAction() {
  return retryUrl ? { label: 'Retry', run: () => void openUrl(retryUrl) } : undefined;
}

function bounds() {
  const rect = viewport.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function syncLayout(force = false): Promise<void> {
  const size = VIEWPORT_SIZE[orientation];
  const frame =
    orientation === 'portrait' ? { width: 411, height: 912 } : { width: 912, height: 411 };
  const scale = Math.max(
    0.1,
    Math.min(
      1,
      (innerWidth - 30) / frame.width,
      (innerHeight - toolbar.offsetHeight - 34) / frame.height,
    ),
  );
  phone.style.width = `${frame.width}px`;
  phone.style.height = `${frame.height}px`;
  deviceScale.style.width = `${frame.width}px`;
  deviceScale.style.height = `${frame.height}px`;
  deviceScale.style.transform = `scale(${scale})`;
  stage.style.width = `${frame.width * scale}px`;
  stage.style.height = `${frame.height * scale}px`;
  requireElement<HTMLSpanElement>('#viewport-size').textContent =
    `${size.width} × ${size.height} · ${Math.round(scale * 100)}%`;
  if (!siteWebview || (phase === 'rotating' && !force)) return syncTask;
  const view = siteWebview;
  const box = bounds();
  const key = JSON.stringify([box, orientation]);
  if (!force && key === lastBounds) return syncTask;
  const landscape = orientation === 'landscape';
  syncTask = syncTask
    .catch(() => {})
    .then(async () => {
      if (view !== siteWebview) return;
      try {
        await view.setPosition(new LogicalPosition(box.x, box.y));
        await view.setSize(new LogicalSize(box.width, box.height));
        if (
          phase !== 'loading' &&
          phase !== 'opening' &&
          !(phase === 'rotating' && rotationResume === 'loading')
        ) {
          await nativeBrowser.resize(size, landscape, box.width / size.width);
          lastBounds = key;
        }
      } catch (error) {
        if (view === siteWebview && phase !== 'closing') throw error;
      }
    });
  return syncTask;
}

function waitForWebview(webview: Webview): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners: Array<() => void> = [];
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listeners.forEach((unlisten) => unlisten());
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('The website viewer took too long to start. Please try again.')),
      TIMING.webviewCreation,
    );
    const register = (listener: Promise<() => void>): void => {
      void listener
        .then((unlisten) => {
          if (settled) unlisten();
          else listeners.push(unlisten);
        })
        .catch((error: unknown) => finish(new Error(String(error))));
    };
    register(webview.listen('tauri://created', () => finish()));
    register(webview.listen('tauri://error', (event) => finish(new Error(String(event.payload)))));
  });
}

function renderRecent(): void {
  let urls: string[] = [];
  try {
    urls = recentUrls(localStorage);
  } catch {
    /* Storage may be disabled. */
  }
  const list = requireElement<HTMLUListElement>('#recent-list');
  list.replaceChildren();
  for (const url of urls) {
    const button = document.createElement('button');
    button.type = 'button';
    const parsed = new URL(url);
    const host = document.createElement('strong');
    host.textContent = parsed.host;
    const path = document.createElement('span');
    path.textContent = parsed.pathname === '/' ? `${parsed.protocol}//` : parsed.pathname;
    button.append(host, path);
    button.title = url;
    button.setAttribute('aria-label', url);
    button.addEventListener('click', () => {
      setRecentOpen(false);
      void openUrl(url);
    });
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  }
  requireElement<HTMLElement>('#recent-empty').hidden = urls.length !== 0;
  requireElement<HTMLButtonElement>('#clear-recent').disabled = urls.length === 0;
}

function setRecentOpen(open: boolean): void {
  recentSection.hidden = !open;
  recentButton.setAttribute('aria-expanded', String(open));
  if (open) renderRecent();
  void syncLayout().catch((error: unknown) => showNotice(String(error)));
}

async function focusAddress(): Promise<void> {
  if (addressInput.readOnly) return;
  if (isTauri()) await getCurrentWebview().setFocus();
  addressInput.focus();
  addressInput.select();
}

function clearAddressError(): void {
  addressForm.removeAttribute('aria-invalid');
  addressInput.removeAttribute('aria-invalid');
  addressInput.setAttribute('aria-describedby', 'address-status');
}

function rememberCurrent(): void {
  try {
    rememberUrl(localStorage, activeUrl);
  } catch {
    /* Storage may be disabled. */
  }
  renderRecent();
}

async function openUrl(raw: string): Promise<void> {
  if (['opening', 'closing', 'rotating'].includes(phase)) return;
  let url: string;
  try {
    url = formatUrl(raw);
  } catch (error) {
    addressForm.setAttribute('aria-invalid', 'true');
    addressInput.setAttribute('aria-invalid', 'true');
    addressInput.setAttribute('aria-describedby', 'notice-text');
    showNotice(error instanceof Error ? error.message : String(error));
    void focusAddress().catch(reportError);
    return;
  }
  if (phase === 'loading') await stopLoading();
  const version = ++epoch;
  navigation.cancel();
  setRecentOpen(false);
  dismissNotice();
  clearAddressError();
  retryUrl = url;
  activeUrl = url;
  addressInput.value = url;
  addressInput.blur();
  setPhase(siteWebview || browserFrame ? 'loading' : 'opening');
  let created: Webview | null = null;
  try {
    if (isTauri()) {
      await siteEventsReady;
      if (version !== epoch) return;
      if (!siteWebview) {
        await syncLayout();
        const view = new Webview(getCurrentWindow(), 'site', {
          ...(browserArguments ? { additionalBrowserArgs: browserArguments } : {}),
          ...(browserArguments ? { devtools: true } : {}),
          url: 'about:blank',
          ...bounds(),
        });
        created = view;
        await waitForWebview(view);
        if (version !== epoch) {
          await view.close();
          return;
        }
        siteWebview = view;
        navigation.reset(++session);
        const size = VIEWPORT_SIZE[orientation];
        await nativeBrowser.configure({
          ...size,
          userAgent: mobileUserAgent(),
          landscape: orientation === 'landscape',
          scale: bounds().width / size.width,
          session,
        });
        if (version !== epoch) return;
      }
      beginLoading();
      await nativeBrowser.navigate(url);
      if (version === epoch) await siteWebview?.setFocus();
    } else {
      browserFrame?.remove();
      const frame = document.createElement('iframe');
      browserFrame = frame;
      frame.className = 'browser-fallback';
      frame.title = 'Website preview';
      frame.addEventListener('load', () => {
        if (frame !== browserFrame || version !== epoch) return;
        finishLoading();
        rememberCurrent();
      });
      frame.addEventListener('error', () => {
        if (frame === browserFrame && version === epoch)
          reportError('The website could not be opened. Check the URL.');
      });
      beginLoading();
      frame.src = url;
      viewport.append(frame);
      frame.focus();
    }
  } catch (error) {
    if (created && created === siteWebview) {
      try {
        await created.close();
      } catch {
        /* The failed view may already be closed. */
      }
      siteWebview = null;
    }
    if (version === epoch) reportError(error);
  }
}

async function stopLoading(): Promise<void> {
  if (phase === 'opening') {
    await goHome();
    return;
  }
  if (phase !== 'loading') return;
  ++epoch;
  navigation.cancel();
  clearTimeout(loadTimer);
  stopping = true;
  try {
    if (siteWebview) await nativeBrowser.action('stop');
    else {
      browserFrame?.remove();
      browserFrame = null;
    }
    navigation.cancel();
    finishLoading();
  } catch (error) {
    reportError(error);
  } finally {
    stopping = false;
  }
}

async function action(name: NavigationAction): Promise<void> {
  if (name === 'stop') {
    await stopLoading();
    return;
  }
  if (phase !== 'ready') return;
  if (!isTauri()) {
    if (name === 'reload') await openUrl(activeUrl);
    return;
  }
  ++epoch;
  navigation.cancel();
  beginLoading();
  try {
    await nativeBrowser.action(name);
  } catch (error) {
    reportError(error);
  }
}

async function goHome(): Promise<void> {
  if (phase === 'rotating' || phase === 'closing') return;
  ++epoch;
  navigation.reset(++session);
  clearTimeout(loadTimer);
  setPhase('closing');
  try {
    if (siteWebview) await siteWebview.close();
  } catch (error) {
    reportError(error);
    return;
  }
  siteWebview = null;
  browserFrame?.remove();
  browserFrame = null;
  canGoBack = false;
  canGoForward = false;
  addressInput.value = activeUrl;
  clearAddressError();
  activeUrl = '';
  retryUrl = '';
  dismissNotice();
  setRecentOpen(false);
  lastBounds = '';
  setPhase('empty');
  renderRecent();
  await focusAddress();
}

async function rotatePhone(): Promise<void> {
  if (phase !== 'empty' && phase !== 'ready') return;
  const previous = orientation;
  const next = previous === 'portrait' ? 'landscape' : 'portrait';
  rotationResume = phase;
  setPhase('rotating');
  try {
    await resizeWindow(appWindow, next);
    orientation = next;
    phone.dataset.orientation = next;
    buttons.rotate.setAttribute('aria-pressed', String(next === 'landscape'));
    buttons.rotate.setAttribute(
      'aria-label',
      next === 'landscape' ? 'Rotate to portrait' : 'Rotate to landscape',
    );
    buttons.rotate.title = buttons.rotate.getAttribute('aria-label')!;
    await syncLayout(true);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await phone.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: TIMING.rotation })
        .finished;
    }
  } catch (error) {
    orientation = previous;
    phone.dataset.orientation = previous;
    buttons.rotate.setAttribute('aria-pressed', String(previous === 'landscape'));
    buttons.rotate.setAttribute(
      'aria-label',
      previous === 'landscape' ? 'Rotate to portrait' : 'Rotate to landscape',
    );
    buttons.rotate.title = buttons.rotate.getAttribute('aria-label')!;
    try {
      await resizeWindow(appWindow, previous);
      await syncLayout(true);
    } catch (restoreError) {
      showNotice(String(restoreError));
    }
    showNotice(`Could not rotate the preview: ${String(error)}`);
  } finally {
    setPhase(rotationResume);
  }
}

async function refreshSiteState(): Promise<void> {
  if (!siteWebview || phase !== 'ready' || refreshing) return;
  const view = siteWebview;
  const version = epoch;
  refreshing = true;
  try {
    const state = await nativeBrowser.state();
    if (view !== siteWebview || version !== epoch || phase !== 'ready') return;
    canGoBack = state.canGoBack ?? false;
    canGoForward = state.canGoForward ?? false;
    if (/^https?:/.test(state.url)) {
      activeUrl = state.url;
      retryUrl = activeUrl;
      if (document.activeElement !== addressInput) addressInput.value = activeUrl;
    }
    setPhase(phase);
  } catch {
    /* The view can disappear while Home is closing it. */
  } finally {
    refreshing = false;
  }
}

const siteEventsReady = isTauri()
  ? nativeBrowser.prepare().then((arguments_) => {
      browserArguments = arguments_ ?? undefined;
      return getCurrentWebview().listen<NavigationEvent>('pew:navigation', ({ payload }) => {
        if (!siteWebview || phase === 'closing' || !navigation.accept(payload)) return;
        if (stopping) {
          navigation.cancel();
          return;
        }
        if (payload.phase === 'started') beginLoading();
        else if (payload.phase === 'failed')
          reportError('The website could not be loaded. Check the address and your connection.');
        else {
          finishLoading();
          void refreshSiteState().then(() => {
            if (payload.phase === 'finished') rememberCurrent();
          });
        }
      });
    })
  : Promise.resolve(() => {});
void siteEventsReady.catch(() => {});

addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openUrl(addressInput.value);
});
addressInput.addEventListener('input', () => {
  clearAddressError();
  dismissNotice();
});
addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    setRecentOpen(false);
    addressInput.value = activeUrl;
    clearAddressError();
    dismissNotice();
    addressInput.blur();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    setRecentOpen(true);
    recentSection.querySelector<HTMLButtonElement>('li button')?.focus();
  }
});
for (const name of ['back', 'forward', 'reload', 'stop'] as const)
  buttons[name].addEventListener('click', () => void action(name));
buttons.home.addEventListener('click', () => void goHome());
buttons.rotate.addEventListener('click', () => void rotatePhone());
buttons.screenshot.addEventListener('click', () => {
  if (phase !== 'ready' || !siteWebview) return;
  buttons.screenshot.disabled = true;
  void nativeBrowser
    .exportSnapshot()
    .then((path) => {
      showNotice('Screenshot saved to Pictures/PEW.', 'success', {
        label: 'Open folder',
        run: () => void nativeBrowser.openScreenshotFolder().catch(reportError),
      });
      noticeAction.title = path;
    })
    .catch(reportError)
    .finally(() => setPhase(phase));
});
noticeAction.addEventListener('click', () => noticeCallback?.());
requireElement<HTMLButtonElement>('#dismiss-notice').addEventListener('click', dismissNotice);
requireElement<HTMLButtonElement>('#focus-address').addEventListener(
  'click',
  () => void focusAddress().catch(reportError),
);
recentButton.addEventListener('click', () => setRecentOpen(recentSection.hidden));
recentSection.addEventListener('keydown', (event) => {
  const items = Array.from(recentSection.querySelectorAll<HTMLButtonElement>('li button'));
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!recentSection.hidden && !toolbar.contains(event.target as Node)) setRecentOpen(false);
});
document.addEventListener('focusin', (event) => {
  if (!recentSection.hidden && !toolbar.contains(event.target as Node)) setRecentOpen(false);
});
function shortcut(name: string): void {
  if (name === 'preview-focus') setRecentOpen(false);
  else if (name === 'address') void focusAddress().catch(reportError);
  else if (name === 'reload' && !buttons.reload.disabled) void action('reload');
  else if (name === 'back' && !buttons.back.disabled) void action('back');
  else if (name === 'forward' && !buttons.forward.disabled) void action('forward');
  else if (name === 'stop') {
    if (!recentSection.hidden) {
      setRecentOpen(false);
      recentButton.focus();
    } else if (phase === 'loading' || phase === 'opening') void stopLoading();
  }
}
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.repeat) return;
  const key = event.key.toLowerCase();
  let name = '';
  if (!event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey)) {
    if (key === 'l') name = 'address';
    if (key === 'r') name = 'reload';
  } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (key === 'arrowleft') name = 'back';
    if (key === 'arrowright') name = 'forward';
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (key === 'f5') name = 'reload';
    if (key === 'escape') name = 'stop';
  }
  if (name) {
    event.preventDefault();
    shortcut(name);
  }
});
if (isTauri())
  void getCurrentWebview().listen<string>('pew:shortcut', ({ payload }) => shortcut(payload));
requireElement<HTMLButtonElement>('#clear-recent').addEventListener('click', () => {
  try {
    localStorage.removeItem(HISTORY_KEY);
    renderRecent();
    void syncLayout();
  } catch {
    showNotice('Recent URLs could not be cleared.');
  }
});
requireElement<HTMLButtonElement>('#minimize-button').addEventListener('click', () => {
  void appWindow?.minimize().catch(reportError);
});
requireElement<HTMLButtonElement>('#close-button').addEventListener('click', () => {
  void appWindow?.close().catch(reportError);
});
const observer = new ResizeObserver(() => {
  void syncLayout().catch((error: unknown) => showNotice(String(error)));
});
observer.observe(toolbar);
window.addEventListener('resize', () => {
  void syncLayout().catch((error: unknown) => showNotice(String(error)));
});
const interval = setInterval(() => void refreshSiteState(), TIMING.stateRefresh);
window.addEventListener(
  'pagehide',
  () => {
    clearTimeout(loadTimer);
    clearTimeout(noticeTimer);
    clearInterval(interval);
    observer.disconnect();
  },
  { once: true },
);
renderRecent();
setPhase('empty');
void focusAddress().catch(reportError);
