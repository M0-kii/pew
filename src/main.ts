import { invoke, isTauri } from '@tauri-apps/api/core';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Webview, getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createIcons, ArrowLeft, ArrowRight, House, RefreshCw, Rotate3d, Minus, X } from 'lucide';
import './style.css';
import ui from './ui.html?raw';
import { formatUrl } from './url';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = ui;
createIcons({ icons: { ArrowLeft, ArrowRight, House, RefreshCw, Rotate3d, Minus, X } });

const urlForm = document.querySelector<HTMLFormElement>('#url-form')!;
const urlInput = document.querySelector<HTMLInputElement>('#url-input')!;
const viewport = document.querySelector<HTMLDivElement>('#site-viewport')!;
const phone = document.querySelector<HTMLElement>('.phone')!;
const rotateButton = document.querySelector<HTMLButtonElement>('#rotate-button')!;
const rotationSnapshot = document.querySelector<HTMLImageElement>('#rotation-snapshot')!;
const emptyState = document.querySelector<HTMLDivElement>('#empty-state')!;
const loadingState = document.querySelector<HTMLDivElement>('#loading-state')!;
const inputError = document.querySelector<HTMLParagraphElement>('#input-error')!;
const addressForm = document.querySelector<HTMLFormElement>('#address-form')!;
const addressInput = document.querySelector<HTMLInputElement>('#address-input')!;
const addressStatus = document.querySelector<HTMLSpanElement>('#address-status')!;
const addressGo = document.querySelector<HTMLButtonElement>('#address-go')!;
const notice = document.querySelector<HTMLDivElement>('#notice')!;
const noticeText = document.querySelector<HTMLSpanElement>('#notice-text')!;
const buttons = {
  back: document.querySelector<HTMLButtonElement>('#back-button')!,
  forward: document.querySelector<HTMLButtonElement>('#forward-button')!,
  home: document.querySelector<HTMLButtonElement>('#home-button')!,
  reload: document.querySelector<HTMLButtonElement>('#reload-button')!,
};

let siteWebview: Webview | null = null;
let browserFrame: HTMLIFrameElement | null = null;
let activeUrl = '';
let loading = false;
let opening = false;
let closing = false;
let canGoBack: boolean | null = null;
let canGoForward: boolean | null = null;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let navigationVersion = 0;
let rotating = false;
let orientation: 'portrait' | 'landscape' = 'portrait';

const chromiumVersion = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'Chrome/125.0.0.0';
const mobileUserAgent = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ${chromiumVersion} Mobile Safari/537.36`;

function updateControls(): void {
  const hasSite = Boolean(siteWebview || browserFrame);
  const busy = opening || closing || rotating;
  buttons.home.disabled = busy || !hasSite;
  buttons.reload.disabled = busy || loading || !hasSite;
  buttons.back.disabled = busy || loading || !hasSite || canGoBack === false;
  buttons.forward.disabled = busy || loading || !hasSite || canGoForward === false;
  rotateButton.disabled = busy || loading;
  addressGo.disabled = busy || loading;
  addressInput.readOnly = busy;
  urlInput.readOnly = busy;
}

function setState(state: 'empty' | 'loading' | 'loaded'): void {
  emptyState.hidden = state !== 'empty';
  loadingState.hidden = state !== 'loading';
  viewport.dataset.state = state;
  addressForm.hidden = state === 'empty';
  viewport.setAttribute('aria-busy', String(state === 'loading'));
  addressStatus.textContent = state === 'loading' ? 'Loading…' : 'Ready';
  addressStatus.dataset.loading = String(state === 'loading');
  updateControls();
}

function beginLoading(): void {
  clearTimeout(loadTimer);
  loading = true;
  notice.hidden = true;
  setState('loading');
  loadTimer = setTimeout(() => {
    finishLoading();
    showNotice('This website is taking longer than expected. You can reload it, enter another URL, or return Home.');
  }, 20000);
}

function finishLoading(): void {
  clearTimeout(loadTimer);
  loading = false;
  setState(siteWebview || browserFrame ? 'loaded' : 'empty');
}

function showNotice(message: string): void {
  noticeText.textContent = message;
  notice.hidden = false;
}
function bounds() {
  const rect = viewport.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
}

async function syncBounds(force = false): Promise<void> {
  const webview = siteWebview;
  if (!webview || (rotating && !force)) return;
  const box = bounds();
  await webview.setPosition(new LogicalPosition(box.x, box.y));
  await webview.setSize(new LogicalSize(box.width, box.height));
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
    const timer = setTimeout(() => finish(new Error('The website viewer took too long to start. Please try again.')), 10000);
    const register = (listener: Promise<() => void>): void => {
      void listener.then((unlisten) => {
        if (settled) unlisten();
        else listeners.push(unlisten);
      }).catch((error: unknown) => finish(new Error(String(error))));
    };
    register(webview.listen('tauri://created', () => finish()));
    register(webview.listen('tauri://error', (event) => finish(new Error(String(event.payload)))));
  });
}

function reportError(message: string): void {
  if (siteWebview || browserFrame) {
    finishLoading();
    showNotice(message);
    return;
  }
  activeUrl = '';
  finishLoading();
  inputError.textContent = message;
  inputError.hidden = false;
  urlInput.focus();
}
async function openUrl(raw: string): Promise<void> {
  if (loading || opening || closing || rotating) return;
  let url: string;
  try {
    url = formatUrl(raw);
  } catch (error) {
    reportError((error as Error).message);
    (siteWebview || browserFrame ? addressInput : urlInput).focus();
    return;
  }

  urlInput.setCustomValidity('');
  inputError.hidden = true;
  opening = true;
  const version = ++navigationVersion;
  let newWebview: Webview | null = null;
  activeUrl = url;
  urlInput.value = url;
  addressInput.value = url;
  beginLoading();
  try {
    if (isTauri()) {
      await siteEventsReady;
      if (siteWebview) {
        await invoke('navigate_site', { url });
      } else {
        const box = bounds();
        const webview = new Webview(getCurrentWindow(), 'site', {
          url: 'about:blank',
          ...box,
        });
        newWebview = webview;
        await waitForWebview(webview);
        siteWebview = webview;
        updateControls();
        await invoke('configure_site', { width: box.width, height: box.height, userAgent: mobileUserAgent, landscape: orientation === 'landscape' });
        await invoke('navigate_site', { url });
        await syncBounds();
      }
    } else {
      browserFrame?.remove();
      browserFrame = document.createElement('iframe');
      browserFrame.className = 'browser-fallback';
      browserFrame.title = 'Website preview';
      canGoBack = false;
      canGoForward = false;
      const frame = browserFrame;
      frame.addEventListener('load', () => {
        if (browserFrame === frame && version === navigationVersion) finishLoading();
      });
      frame.addEventListener('error', () => {
        if (browserFrame === frame) reportError('The website could not be opened. Check the URL and try again.');
      });
      browserFrame.src = url;
      viewport.append(browserFrame);
    }
  } catch (error) {
    if (newWebview) {
      try { await newWebview.close(); } catch { /* The failed view may already be closed. */ }
      siteWebview = null;
    }
    reportError(String(error));
  } finally {
    opening = false;
    updateControls();
  }
}

async function action(name: 'back' | 'forward' | 'reload'): Promise<void> {
  if (!activeUrl || loading || opening || closing || rotating) return;
  try {
    beginLoading();
    if (isTauri()) {
      await invoke('site_action', { action: name });
    } else if (browserFrame?.contentWindow) {
      if (name === 'reload') browserFrame.src = activeUrl;
    }
  } catch (error) {
    reportError(String(error));
  }
}

async function goHome(): Promise<void> {
  if (opening || closing || rotating) return;
  closing = true;
  ++navigationVersion;
  clearTimeout(loadTimer);
  loading = false;
  updateControls();
  try {
    if (siteWebview) await siteWebview.close();
  } catch (error) {
    closing = false;
    reportError(`Could not return Home: ${String(error)}`);
    return;
  }
  siteWebview = null;
  browserFrame?.remove();
  browserFrame = null;
  urlInput.value = activeUrl || urlInput.value;
  activeUrl = '';
  // Keep the last URL so it is easy to reopen or edit.
  canGoBack = null;
  canGoForward = null;
  urlInput.setCustomValidity('');
  inputError.hidden = true;
  notice.hidden = true;
  closing = false;
  setState('empty');
  urlInput.focus();
  urlInput.select();
}

async function animateWindowSize(from: 'portrait' | 'landscape', to: 'portrait' | 'landscape', duration: number): Promise<void> {
  if (!appWindow) return;
  const startWidth = from === 'portrait' ? 430 : 900;
  const startHeight = from === 'portrait' ? 900 : 450;
  const endWidth = to === 'portrait' ? 430 : 900;
  const endHeight = to === 'portrait' ? 900 : 450;
  const startedAt = performance.now();

  while (true) {
    const progress = Math.min(1, (performance.now() - startedAt) / duration);
    const eased = progress * progress * (3 - 2 * progress);
    const width = Math.round(startWidth + (endWidth - startWidth) * eased);
    const height = Math.round(startHeight + (endHeight - startHeight) * eased);
    await appWindow.setSize(new LogicalSize(width, height));
    await appWindow.center();
    if (progress >= 1) break;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
function animatePhone(from: Keyframe, to: Keyframe, duration: number): Animation {
  return phone.animate([from, to], {
    duration,
    easing: 'cubic-bezier(.22, 1, .36, 1)',
    fill: 'forwards',
  });
}

async function rotatePhone(): Promise<void> {
  if (rotating || loading || opening || closing) return;
  rotating = true;
  updateControls();

  const previous = orientation;
  const next = previous === 'portrait' ? 'landscape' : 'portrait';
  const angle = next === 'landscape' ? 90 : -90;
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let siteHidden = false;
  let outgoing: Animation | null = null;
  let incoming: Animation | null = null;

  try {
    if (siteWebview && animate) {
      try {
        rotationSnapshot.src = await invoke<string>('site_snapshot');
        await rotationSnapshot.decode();
        rotationSnapshot.hidden = false;
        await siteWebview.hide();
        siteHidden = true;
      } catch (snapshotError) {
        rotationSnapshot.hidden = true;
        console.warn('PEW could not prepare a rotation snapshot:', snapshotError);
      }
    }

    if (animate) {
      outgoing = animatePhone(
        { transform: 'rotate(0deg) scale(1)', opacity: 1 },
        { transform: 'rotate(' + angle + 'deg) scale(.44)', opacity: .12 },
        235,
      );
    }
    const windowMotion = animate
      ? animateWindowSize(previous, next, 470).then(() => null, (error: unknown) => error)
      : Promise.resolve(null);
    if (outgoing) await outgoing.finished;
    if (!animate && appWindow) {
      await appWindow.setSize(new LogicalSize(next === 'landscape' ? 900 : 430, next === 'landscape' ? 450 : 900));
      await appWindow.center();
    }

    orientation = next;
    phone.dataset.orientation = next;
    rotateButton.setAttribute('aria-pressed', String(next === 'landscape'));
    rotateButton.setAttribute('aria-label', next === 'landscape' ? 'Rotate to portrait' : 'Rotate to landscape');
    rotateButton.title = next === 'landscape' ? 'Rotate to portrait' : 'Rotate to landscape';

    if (animate) {
      incoming = animatePhone(
        { transform: 'rotate(' + -angle + 'deg) scale(.44)', opacity: .12 },
        { transform: 'rotate(0deg) scale(1)', opacity: 1 },
        235,
      );
      outgoing?.cancel();
      outgoing = null;
    }
    const [windowError] = await Promise.all([
      windowMotion,
      incoming?.finished ?? Promise.resolve(),
    ]);
    if (windowError) throw windowError;

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await syncBounds(true);
    if (siteWebview) {
      const box = bounds();
      await invoke('resize_site', { width: box.width, height: box.height, landscape: next === 'landscape' });
    }
  } catch (error) {
    console.error('Could not rotate PEW:', error);
    showNotice('Could not rotate the preview. Please try again.');
    orientation = previous;
    phone.dataset.orientation = previous;
    rotateButton.setAttribute('aria-pressed', String(previous === 'landscape'));
    rotateButton.setAttribute('aria-label', previous === 'landscape' ? 'Rotate to portrait' : 'Rotate to landscape');
    rotateButton.title = previous === 'landscape' ? 'Rotate to portrait' : 'Rotate to landscape';
    if (appWindow) {
      try {
        await appWindow.setSize(new LogicalSize(previous === 'landscape' ? 900 : 430, previous === 'landscape' ? 450 : 900));
        await appWindow.center();
        await syncBounds(true);
        if (siteWebview) {
          const box = bounds();
          await invoke('resize_site', { width: box.width, height: box.height, landscape: previous === 'landscape' });
        }
      } catch (restoreError) {
        console.error('Could not restore PEW window:', restoreError);
      }
    }
  } finally {
    outgoing?.cancel();
    incoming?.cancel();
    if (siteHidden && siteWebview) {
      try { await siteWebview.show(); } catch (error) { console.error('Could not restore website view:', error); }
    }
    rotationSnapshot.hidden = true;
    rotationSnapshot.removeAttribute('src');
    rotating = false;
    setState(viewport.dataset.state as 'empty' | 'loading' | 'loaded');
  }
}
urlInput.addEventListener('input', () => { urlInput.setCustomValidity(''); inputError.hidden = true; });

urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openUrl(urlInput.value);
});
addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void openUrl(addressInput.value);
});
addressInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    addressInput.value = activeUrl;
    addressInput.blur();
  }
});
document.querySelector<HTMLButtonElement>('#dismiss-notice')!.addEventListener('click', () => { notice.hidden = true; });
buttons.back.addEventListener('click', () => void action('back'));
buttons.forward.addEventListener('click', () => void action('forward'));
buttons.reload.addEventListener('click', () => void action('reload'));
buttons.home.addEventListener('click', () => void goHome());
rotateButton.addEventListener('click', () => void rotatePhone());

const appWindow = isTauri() ? getCurrentWindow() : null;
document.querySelector<HTMLButtonElement>('#minimize-button')!.addEventListener('click', () => {
  if (appWindow) void appWindow.minimize();
});
document.querySelector<HTMLButtonElement>('#close-button')!.addEventListener('click', () => {
  if (appWindow) void appWindow.close();
});

function scheduleBoundsSync(): void {
  void syncBounds().catch(() => { /* A closing webview may no longer have bounds. */ });
}
const resizeObserver = new ResizeObserver(scheduleBoundsSync);
resizeObserver.observe(viewport);
window.addEventListener('resize', scheduleBoundsSync);

const siteEventsReady = isTauri() ? Promise.all([
  getCurrentWebview().listen<[string, boolean]>('pew:page-load', ({ payload: [url, started] }) => {
    if (!siteWebview || closing || !/^https?:/.test(url)) return;
    activeUrl = url;
    if (document.activeElement !== addressInput) addressInput.value = url;
    if (started) beginLoading();
    else {
      finishLoading();
      void refreshSiteState();
    }
  }),
  getCurrentWebview().listen<string>('pew:load-error', ({ payload }) => {
    if (siteWebview && !closing) reportError(payload);
  }),
]) : Promise.resolve([]);
// Keep startup listener failures handled until openUrl can display them.
void siteEventsReady.catch(() => {});

let refreshing = false;
async function refreshSiteState(): Promise<void> {
  if (!isTauri() || !siteWebview || closing || refreshing) return;
  refreshing = true;
  const version = navigationVersion;
  try {
    const [current, back, forward] = await invoke<[string, boolean | null, boolean | null]>('site_state');
    if (version !== navigationVersion || !siteWebview) return;
    canGoBack = back;
    canGoForward = forward;
    if (current && /^https?:/.test(current)) {
      activeUrl = current;
      if (document.activeElement !== addressInput) addressInput.value = current;
    }
    updateControls();
  } catch {
    // A navigation in progress may briefly have no readable URL.
  } finally {
    refreshing = false;
  }
}
const stateInterval = setInterval(() => void refreshSiteState(), 1200);
window.addEventListener('pagehide', () => {
  clearTimeout(loadTimer);
  clearInterval(stateInterval);
  resizeObserver.disconnect();
  void siteEventsReady.then((listeners) => listeners.forEach((unlisten) => unlisten())).catch(() => {});
}, { once: true });

setState('empty');
