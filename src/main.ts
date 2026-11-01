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
  Rotate3d,
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
  icons: { ArrowLeft, ArrowRight, House, RefreshCw, Rotate3d, Minus, X, Square, Camera },
});
const urlForm = requireElement<HTMLFormElement>('#url-form');
const urlInput = requireElement<HTMLInputElement>('#url-input');
const viewport = requireElement<HTMLDivElement>('#site-viewport');
const phone = requireElement<HTMLElement>('.phone');
const stage = requireElement<HTMLDivElement>('.device-stage');
const deviceScale = requireElement<HTMLDivElement>('.device-scale');
const toolbar = requireElement<HTMLElement>('.toolbar');
const emptyState = requireElement<HTMLDivElement>('#empty-state');
const loadingState = requireElement<HTMLDivElement>('#loading-state');
const inputError = requireElement<HTMLParagraphElement>('#input-error');
const addressForm = requireElement<HTMLFormElement>('#address-form');
const addressInput = requireElement<HTMLInputElement>('#address-input');
const addressStatus = requireElement<HTMLSpanElement>('#address-status');
const addressGo = requireElement<HTMLButtonElement>('#address-go');
const notice = requireElement<HTMLDivElement>('#notice');
const noticeText = requireElement<HTMLSpanElement>('#notice-text');
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

function setPhase(value: ViewState): void {
  phase = value;
  const loading = value === 'loading' || value === 'opening';
  const busy = value === 'rotating' || value === 'closing';
  const hasSite = Boolean(siteWebview || browserFrame);
  emptyState.hidden = value !== 'empty';
  loadingState.hidden = !loading;
  viewport.dataset.state = value;
  viewport.setAttribute('aria-busy', String(loading));
  addressForm.hidden = !hasSite && !loading;
  addressStatus.textContent = loading ? 'Loading…' : 'Ready';
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
  void syncLayout().catch((error: unknown) => showNotice(String(error)));
}

function showNotice(message: string): void {
  noticeText.textContent = message;
  notice.hidden = false;
  void syncLayout().catch(() => {});
}

function beginLoading(): void {
  clearTimeout(loadTimer);
  notice.hidden = true;
  if (phase === 'rotating') rotationResume = 'loading';
  else setPhase('loading');
  const version = epoch;
  loadTimer = setTimeout(() => {
    void stopLoading().then(() => {
      if (version + 1 === epoch)
        showNotice('The website took too long to load. Reload it or enter another URL.');
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
  if (siteWebview || browserFrame) showNotice(message);
  else {
    inputError.textContent = message;
    inputError.hidden = false;
    urlInput.focus();
  }
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
    orientation === 'portrait' ? { width: 411, height: 927 } : { width: 927, height: 411 };
  const scale = Math.max(
    0.1,
    Math.min(
      1,
      (innerWidth - 30) / frame.width,
      (innerHeight - toolbar.offsetHeight - 26) / frame.height,
    ),
  );
  phone.style.width = `${frame.width}px`;
  phone.style.height = `${frame.height}px`;
  deviceScale.style.width = `${frame.width}px`;
  deviceScale.style.height = `${frame.height}px`;
  deviceScale.style.transform = `scale(${scale})`;
  stage.style.width = `${frame.width * scale}px`;
  stage.style.height = `${frame.height * scale}px`;
  requireElement<HTMLSpanElement>('#viewport-size').textContent = `${size.width} × ${size.height}`;
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
    button.textContent = url;
    button.title = url;
    button.addEventListener('click', () => void openUrl(url));
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  }
  requireElement<HTMLElement>('#recent-section').hidden = urls.length === 0;
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
    reportError(error);
    return;
  }
  if (phase === 'loading') await stopLoading();
  const version = ++epoch;
  navigation.cancel();
  inputError.hidden = true;
  notice.hidden = true;
  activeUrl = url;
  addressInput.value = url;
  urlInput.value = url;
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
  urlInput.value = activeUrl;
  activeUrl = '';
  inputError.hidden = true;
  notice.hidden = true;
  lastBounds = '';
  setPhase('empty');
  renderRecent();
  urlInput.focus();
  urlInput.select();
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

urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openUrl(urlInput.value);
});
addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openUrl(addressInput.value);
});
urlInput.addEventListener('input', () => {
  inputError.hidden = true;
});
addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    addressInput.value = activeUrl;
    addressInput.blur();
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
    .then((path) => showNotice(`Screenshot saved: ${path}`))
    .catch(reportError)
    .finally(() => setPhase(phase));
});
requireElement<HTMLButtonElement>('#dismiss-notice').addEventListener('click', () => {
  notice.hidden = true;
  void syncLayout();
});
requireElement<HTMLButtonElement>('#clear-recent').addEventListener('click', () => {
  try {
    localStorage.removeItem(HISTORY_KEY);
    renderRecent();
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
    clearInterval(interval);
    observer.disconnect();
  },
  { once: true },
);
renderRecent();
setPhase('empty');
