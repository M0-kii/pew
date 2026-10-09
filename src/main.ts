import { isTauri } from '@tauri-apps/api/core';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Webview, getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createIcons, ArrowLeft, ArrowRight, House, RefreshCw, Rotate3d, Minus, X } from 'lucide';
import './style.css';
import ui from './ui.html?raw';
import { formatUrl } from './url';
import { TIMING, WINDOW_SIZE, type Orientation, type ViewState } from './config';
import { requireElement } from './dom';
import { nativeBrowser, mobileUserAgent, type NavigationAction } from './native';
import { animateWindowSize } from './rotation';

requireElement<HTMLDivElement>('#app').innerHTML = ui;
createIcons({ icons: { ArrowLeft, ArrowRight, House, RefreshCw, Rotate3d, Minus, X } });

const urlForm = requireElement<HTMLFormElement>('#url-form');
const urlInput = requireElement<HTMLInputElement>('#url-input');
const viewport = requireElement<HTMLDivElement>('#site-viewport');
const phone = requireElement<HTMLElement>('.phone');
const rotateButton = requireElement<HTMLButtonElement>('#rotate-button');
const rotationSnapshot = requireElement<HTMLImageElement>('#rotation-snapshot');
const emptyState = requireElement<HTMLDivElement>('#empty-state');
const loadingState = requireElement<HTMLDivElement>('#loading-state');
const inputError = requireElement<HTMLParagraphElement>('#input-error');
const addressForm = requireElement<HTMLFormElement>('#address-form');
const addressInput = requireElement<HTMLInputElement>('#address-input');
const addressStatus = requireElement<HTMLSpanElement>('#address-status');
const addressGo = requireElement<HTMLButtonElement>('#address-go');
const notice = requireElement<HTMLDivElement>('#notice');
const noticeText = requireElement<HTMLSpanElement>('#notice-text');
const buttons = {
  back: requireElement<HTMLButtonElement>('#back-button'),
  forward: requireElement<HTMLButtonElement>('#forward-button'),
  home: requireElement<HTMLButtonElement>('#home-button'),
  reload: requireElement<HTMLButtonElement>('#reload-button'),
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
let orientation: Orientation = 'portrait';
let viewState: ViewState = 'empty';

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

function setState(state: ViewState): void {
  viewState = state;
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
    showNotice(
      'This website is taking longer than expected. You can reload it, enter another URL, or return Home.',
    );
  }, TIMING.pageLoad);
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
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
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
        await nativeBrowser.navigate(url);
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
        await nativeBrowser.configure({
          width: box.width,
          height: box.height,
          userAgent: mobileUserAgent(),
          landscape: orientation === 'landscape',
        });
        await nativeBrowser.navigate(url);
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
        if (browserFrame === frame)
          reportError('The website could not be opened. Check the URL and try again.');
      });
      browserFrame.src = url;
      viewport.append(browserFrame);
    }
  } catch (error) {
    if (newWebview) {
      try {
        await newWebview.close();
      } catch {
        /* The failed view may already be closed. */
      }
      siteWebview = null;
    }
    reportError(String(error));
  } finally {
    opening = false;
    updateControls();
  }
}

async function action(name: NavigationAction): Promise<void> {
  if (!activeUrl || loading || opening || closing || rotating) return;
  try {
    beginLoading();
    if (isTauri()) {
      await nativeBrowser.action(name);
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

function animatePhone(from: Keyframe, to: Keyframe, duration: number): Animation {
  return phone.animate([from, to], {
    duration,
    easing: 'cubic-bezier(.22, 1, .36, 1)',
    fill: 'forwards',
  });
}

function applyOrientation(value: Orientation): void {
  orientation = value;
  phone.dataset.orientation = value;
  const landscape = value === 'landscape';
  const label = landscape ? 'Rotate to portrait' : 'Rotate to landscape';
  rotateButton.setAttribute('aria-pressed', String(landscape));
  rotateButton.setAttribute('aria-label', label);
  rotateButton.title = label;
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
        rotationSnapshot.src = await nativeBrowser.snapshot();
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
        { transform: 'rotate(' + angle + 'deg) scale(.44)', opacity: 0.12 },
        TIMING.rotation / 2,
      );
    }
    const windowMotion = animate
      ? animateWindowSize(appWindow, previous, next, TIMING.rotation).then(
          () => null,
          (error: unknown) => error,
        )
      : Promise.resolve(null);
    if (outgoing) await outgoing.finished;
    if (!animate && appWindow) {
      await appWindow.setSize(new LogicalSize(WINDOW_SIZE[next].width, WINDOW_SIZE[next].height));
      await appWindow.center();
    }

    applyOrientation(next);

    if (animate) {
      incoming = animatePhone(
        { transform: 'rotate(' + -angle + 'deg) scale(.44)', opacity: 0.12 },
        { transform: 'rotate(0deg) scale(1)', opacity: 1 },
        TIMING.rotation / 2,
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
      await nativeBrowser.resize(box, next === 'landscape');
    }
  } catch (error) {
    console.error('Could not rotate PEW:', error);
    showNotice('Could not rotate the preview. Please try again.');
    applyOrientation(previous);
    if (appWindow) {
      try {
        await appWindow.setSize(
          new LogicalSize(WINDOW_SIZE[previous].width, WINDOW_SIZE[previous].height),
        );
        await appWindow.center();
        await syncBounds(true);
        if (siteWebview) {
          const box = bounds();
          await nativeBrowser.resize(box, previous === 'landscape');
        }
      } catch (restoreError) {
        console.error('Could not restore PEW window:', restoreError);
      }
    }
  } finally {
    outgoing?.cancel();
    incoming?.cancel();
    if (siteHidden && siteWebview) {
      try {
        await siteWebview.show();
      } catch (error) {
        console.error('Could not restore website view:', error);
      }
    }
    rotationSnapshot.hidden = true;
    rotationSnapshot.removeAttribute('src');
    rotating = false;
    setState(viewState);
  }
}
urlInput.addEventListener('input', () => {
  urlInput.setCustomValidity('');
  inputError.hidden = true;
});

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
requireElement<HTMLButtonElement>('#dismiss-notice').addEventListener('click', () => {
  notice.hidden = true;
});
buttons.back.addEventListener('click', () => void action('back'));
buttons.forward.addEventListener('click', () => void action('forward'));
buttons.reload.addEventListener('click', () => void action('reload'));
buttons.home.addEventListener('click', () => void goHome());
rotateButton.addEventListener('click', () => void rotatePhone());

const appWindow = isTauri() ? getCurrentWindow() : null;
requireElement<HTMLButtonElement>('#minimize-button').addEventListener('click', () => {
  if (appWindow) void appWindow.minimize();
});
requireElement<HTMLButtonElement>('#close-button').addEventListener('click', () => {
  if (appWindow) void appWindow.close();
});

function scheduleBoundsSync(): void {
  void syncBounds().catch(() => {
    /* A closing webview may no longer have bounds. */
  });
}
const resizeObserver = new ResizeObserver(scheduleBoundsSync);
resizeObserver.observe(viewport);
window.addEventListener('resize', scheduleBoundsSync);

const siteEventsReady = isTauri()
  ? Promise.all([
      getCurrentWebview().listen<[string, boolean]>(
        'pew:page-load',
        ({ payload: [url, started] }) => {
          if (!siteWebview || closing || !/^https?:/.test(url)) return;
          activeUrl = url;
          if (document.activeElement !== addressInput) addressInput.value = url;
          if (started) beginLoading();
          else {
            finishLoading();
            void refreshSiteState();
          }
        },
      ),
      getCurrentWebview().listen<string>('pew:load-error', ({ payload }) => {
        if (siteWebview && !closing) reportError(payload);
      }),
    ])
  : Promise.resolve([]);
// Keep startup listener failures handled until openUrl can display them.
void siteEventsReady.catch(() => {});

let refreshing = false;
async function refreshSiteState(): Promise<void> {
  if (!isTauri() || !siteWebview || closing || refreshing) return;
  refreshing = true;
  const version = navigationVersion;
  try {
    const state = await nativeBrowser.state();
    if (version !== navigationVersion || !siteWebview) return;
    canGoBack = state.canGoBack;
    canGoForward = state.canGoForward;
    if (state.url && /^https?:/.test(state.url)) {
      activeUrl = state.url;
      if (document.activeElement !== addressInput) addressInput.value = state.url;
    }
    updateControls();
  } catch {
    // A navigation in progress may briefly have no readable URL.
  } finally {
    refreshing = false;
  }
}
const stateInterval = setInterval(() => void refreshSiteState(), TIMING.stateRefresh);
window.addEventListener(
  'pagehide',
  () => {
    clearTimeout(loadTimer);
    clearInterval(stateInterval);
    resizeObserver.disconnect();
  },
  { once: true },
);

setState('empty');
