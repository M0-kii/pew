import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test('browser and desktop preview flows', { timeout: 120_000 }, async (t) => {
  const output = process.env.PEW_TEST_ARTIFACT_DIR ?? path.join(tmpdir(), 'pew-tests');
  await mkdir(output, { recursive: true });
  const delayed = new Set();
  const fixture = http.createServer((req, res) => {
    const send = () => {
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview fixture</title><style>body{font:16px system-ui;padding:20px}a{display:block;margin:20px 0}</style><h1>${req.url.includes('second') ? 'Second page' : 'First page'}</h1><a href="/second">Next page</a><input aria-label="Page value" value="preserved">`,
      );
    };
    if (req.url.includes('delayed')) delayed.add(send);
    else send();
  });
  const finishDelayed = () => {
    for (const send of delayed) send();
    delayed.clear();
  };
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  let vite;
  let browser;
  let native;
  let desktop;
  let profile;
  let nativeMain;
  let savedHistory;
  const errors = [];
  const watch = (page) => page.on('pageerror', (error) => errors.push(error.message));
  const ready = async (page) => {
    try {
      await page.waitForFunction(
        () => document.querySelector('#site-viewport').dataset.state === 'ready',
      );
    } catch (error) {
      const state = await page.evaluate(() => ({
        phase: document.querySelector('#site-viewport').dataset.state,
        notice: document.querySelector('#notice-text').textContent,
      }));
      throw new Error(`Preview did not become ready: ${JSON.stringify(state)}`, { cause: error });
    }
  };
  const open = async (page, url) => {
    const input = '#address-input';
    await page.locator(input).fill(url);
    await page.locator(input).press('Enter');
  };
  try {
    vite = await createServer({ server: { host: '127.0.0.1', port: 1420, strictPort: true } });
    await vite.listen();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
    });
    const page = await browser.newPage({
      viewport: { width: 430, height: 900 },
      reducedMotion: 'reduce',
    });
    watch(page);
    await page.goto('http://127.0.0.1:1420');
    assert.match(await page.title(), /PEW/);
    assert.equal(await page.locator('h1').textContent(), 'Open a website');
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(
      await page.locator('#address-input').evaluate((input) => input === document.activeElement),
      true,
    );
    await page.screenshot({ path: path.join(output, 'portrait.png') });

    await t.test('fixed viewport, visible validation, and recent URL persistence', async () => {
      await open(page, 'javascript:alert(1)');
      await page.locator('#notice').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#address-input').getAttribute('aria-invalid'), 'true');
      await open(page, `${fixtureUrl}/first?token=secret#private`);
      await ready(page);
      assert.deepEqual(
        await page
          .frameLocator('iframe')
          .locator('body')
          .evaluate(() => [innerWidth, innerHeight]),
        [393, 852],
      );
      const beforeError = await page.locator('#site-viewport').boundingBox();
      await open(page, 'invalid address');
      await page.locator('#notice').waitFor({ state: 'visible' });
      assert.deepEqual(await page.locator('#site-viewport').boundingBox(), beforeError);
      assert.equal(await page.frameLocator('iframe').locator('h1').textContent(), 'First page');
      assert.deepEqual(
        await page
          .frameLocator('iframe')
          .locator('body')
          .evaluate(() => [innerWidth, innerHeight]),
        [393, 852],
      );
      await page.locator('#home-button').click();
      assert.equal(
        await page.locator('#address-input').inputValue(),
        `${fixtureUrl}/first?token=secret#private`,
      );
      assert.equal(await page.locator('#address-input').getAttribute('aria-invalid'), null);
      await page.locator('#recent-button').click();
      assert.equal(
        await page.locator('#recent-list button').first().getAttribute('aria-label'),
        `${fixtureUrl}/first`,
      );
      await page.reload();
      await page.locator('#recent-button').click();
      await page.locator('#recent-list button').first().click();
      await ready(page);
      assert.equal(await page.locator('#address-input').inputValue(), `${fixtureUrl}/first`);
    });

    await t.test('address shortcuts and recent URLs keep the current page intact', async () => {
      await page.frameLocator('iframe').getByRole('textbox').fill('still here');
      await page.locator('#recent-button').click();
      assert.equal(await page.locator('#recent-button').getAttribute('aria-expanded'), 'true');
      assert.equal(
        await page.frameLocator('iframe').getByRole('textbox').inputValue(),
        'still here',
      );
      assert.deepEqual(
        await page
          .frameLocator('iframe')
          .locator('body')
          .evaluate(() => [innerWidth, innerHeight]),
        [393, 852],
      );
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#recent-section').isHidden(), true);
      await page.keyboard.press('Control+l');
      assert.equal(
        await page
          .locator('#address-input')
          .evaluate(
            (input) =>
              input === document.activeElement &&
              input.selectionEnd === input.value.length &&
              input.selectionStart === 0,
          ),
        true,
      );
      await page.locator('#address-input').press('ArrowDown');
      assert.equal(
        await page
          .locator('#recent-list button')
          .first()
          .evaluate((button) => button === document.activeElement),
        true,
      );
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#recent-section').isHidden(), true);
      await page.locator('#recent-button').click();
      await page.locator('#recent-list button').first().click();
      await ready(page);
      assert.equal(await page.locator('#recent-section').isHidden(), true);
    });

    await t.test('Stop and Home cancel pending loads without stale updates', async () => {
      await open(page, `${fixtureUrl}/delayed`);
      await page.locator('#stop-button').click();
      await page.locator('#empty-state').waitFor({ state: 'visible' });
      await open(page, `${fixtureUrl}/second`);
      await ready(page);
      finishDelayed();
      assert.equal(await page.frameLocator('iframe').locator('h1').textContent(), 'Second page');
      await open(page, `${fixtureUrl}/delayed`);
      await page.locator('#home-button').click();
      await page.locator('#empty-state').waitFor({ state: 'visible' });
      finishDelayed();
      await page.locator('#rotate-button').click();
      await page.setViewportSize({ width: 900, height: 450 });
      await open(page, `${fixtureUrl}/first`);
      await ready(page);
      assert.deepEqual(
        await page
          .frameLocator('iframe')
          .locator('body')
          .evaluate(() => [innerWidth, innerHeight]),
        [852, 393],
      );
      await page.screenshot({ path: path.join(output, 'landscape.png') });
      await page.locator('#home-button').click();
      await page.locator('#recent-button').click();
      await page.locator('#clear-recent').click();
      assert.equal(await page.locator('#recent-empty').isVisible(), true);
      await page.locator('#recent-button').click();
    });

    await t.test('a timed-out page restores controls', async () => {
      await page.clock.install();
      await open(page, `${fixtureUrl}/delayed`);
      await page.clock.fastForward(20_001);
      await page.locator('#notice').waitFor({ state: 'visible' });
      assert.match(await page.locator('#notice-text').textContent(), /too long to load/);
      assert.equal(await page.locator('#address-input').isVisible(), true);
      assert.equal(await page.locator('#notice-action').textContent(), 'Retry');
      finishDelayed();
      await page.locator('#notice-action').click();
      await page.locator('#stop-button').waitFor({ state: 'visible' });
      await page.locator('#home-button').click();
      finishDelayed();
    });

    await t.test('controls and recent URLs fit the smallest supported window', async () => {
      const small = await browser.newPage({
        viewport: { width: 380, height: 400 },
        reducedMotion: 'reduce',
      });
      watch(small);
      try {
        await small.goto('http://127.0.0.1:1420');
        await small.evaluate(() =>
          localStorage.setItem(
            'pew.recent-urls',
            JSON.stringify(
              Array.from({ length: 5 }, (_, index) => `https://example.com/project/${index}`),
            ),
          ),
        );
        await small.reload();
        await small.locator('#recent-button').click();
        const toolbar = await small.locator('.toolbar').boundingBox();
        for (const id of [
          'back',
          'forward',
          'home',
          'reload',
          'rotate',
          'screenshot',
          'minimize',
          'close',
        ]) {
          const button = await small.locator(`#${id}-button`).boundingBox();
          assert.ok(button.x >= toolbar.x && button.x + button.width <= toolbar.x + toolbar.width);
        }
        const frame = await small.locator('.phone').boundingBox();
        assert.ok(frame.y >= toolbar.y + toolbar.height, 'Device does not overlap the toolbar');
        assert.ok(frame.y + frame.height <= 400, 'Device fits below the expanded recent URLs');
        assert.equal(await small.locator('#recent-list button').count(), 5);
        await small.locator('#recent-list button').last().focus();
        await small.keyboard.press('ArrowDown');
        assert.equal(
          await small
            .locator('#recent-list button')
            .first()
            .evaluate((button) => button === document.activeElement),
          true,
        );
        await small.screenshot({ path: path.join(output, 'small-recent.png') });
      } finally {
        await small.close();
      }
    });

    await t.test('custom viewports preserve the page, rotate, validate, and persist', async () => {
      const responsive = await browser.newPage({
        viewport: { width: 430, height: 900 },
        reducedMotion: 'reduce',
      });
      watch(responsive);
      try {
        await responsive.goto('http://127.0.0.1:1420');
        await open(responsive, `${fixtureUrl}/first`);
        await ready(responsive);
        await responsive.frameLocator('iframe').getByRole('textbox').fill('keep this page');
        await responsive.locator('#viewport-size').click();
        await responsive.locator('#viewport-width').fill('239');
        await responsive.locator('#apply-viewport').click();
        await responsive.locator('#viewport-error').waitFor({ state: 'visible' });
        await responsive.locator('#viewport-width').fill('600');
        await responsive.locator('#viewport-height').fill('960');
        await responsive.locator('#viewport-density').selectOption('2');
        await responsive.locator('#apply-viewport').click();
        await ready(responsive);
        assert.equal(await responsive.locator('#viewport-panel').isHidden(), true);
        assert.equal(
          await responsive.frameLocator('iframe').getByRole('textbox').inputValue(),
          'keep this page',
        );
        assert.deepEqual(
          await responsive
            .frameLocator('iframe')
            .locator('body')
            .evaluate(() => [innerWidth, innerHeight]),
          [600, 960],
        );
        await responsive.locator('#rotate-button').click();
        await ready(responsive);
        assert.deepEqual(
          await responsive
            .frameLocator('iframe')
            .locator('body')
            .evaluate(() => [innerWidth, innerHeight]),
          [960, 600],
        );
        await responsive.reload();
        assert.match(await responsive.locator('#viewport-size').textContent(), /960 × 600 · 2×/);
        assert.equal(
          await responsive.locator('#rotate-button').getAttribute('aria-label'),
          'Rotate to portrait',
        );
        await responsive.locator('#viewport-size').click();
        await responsive.locator('#viewport-preset').selectOption('3');
        assert.equal(await responsive.locator('#viewport-width').inputValue(), '768');
        assert.equal(await responsive.locator('#viewport-height').inputValue(), '1024');
        await responsive.locator('#reset-viewport').click();
        await responsive.locator('#apply-viewport').click();
        await responsive.waitForFunction(() =>
          document.querySelector('#viewport-size').textContent.includes('393 × 852 · 3×'),
        );
        await responsive.locator('#viewport-size').click();
        await responsive.keyboard.press('Escape');
        assert.equal(await responsive.locator('#viewport-panel').isHidden(), true);
      } finally {
        await responsive.close();
      }
    });

    if (process.env.PEW_NATIVE_TEST === '1') {
      assert.equal(process.platform, 'win32', 'Native tests require Windows');
      profile = await mkdtemp(path.join(tmpdir(), 'pew-native-'));
      const debugServer = http.createServer();
      await new Promise((resolve) => debugServer.listen(0, '127.0.0.1', resolve));
      const debugPort = debugServer.address().port;
      await new Promise((resolve) => debugServer.close(resolve));
      desktop = spawn(
        path.resolve(process.env.PEW_NATIVE_EXECUTABLE ?? 'src-tauri/target/debug/pew.exe'),
        [],
        {
          windowsHide: process.env.CI !== 'true',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --disable-gpu --no-sandbox`,
            WEBVIEW2_USER_DATA_FOLDER: profile,
            PEW_TEST_DEBUG_PORT: String(debugPort),
          },
        },
      );
      let stderr = '';
      desktop.stderr.on('data', (data) => {
        stderr += data;
      });
      desktop.stdout.resume();
      let debuggerReady = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
          if (response.ok) {
            debuggerReady = true;
            break;
          }
        } catch {
          /* The runtime takes a moment to start its local debugger. */
        }
        if (desktop.exitCode !== null) throw Error(`Desktop exited: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!debuggerReady) {
        const diagnostics = execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `$pewProcesses = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${desktop.pid} -or $_.ParentProcessId -eq ${desktop.pid} }; $pewProcesses | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress; Get-Process -Id ${desktop.pid} -ErrorAction SilentlyContinue | Select-Object Id,Responding,MainWindowTitle | ConvertTo-Json -Compress; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $pewProcesses.ProcessId } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
        );
        throw Error(`Native browser debugger did not start: ${stderr}\n${diagnostics}`);
      }
      native = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const context = native.contexts()[0];
      let main;
      for (let attempt = 0; attempt < 100; attempt++) {
        main = context
          .pages()
          .find(
            (candidate) =>
              candidate.url().includes('1420') || candidate.url().includes('tauri.localhost'),
          );
        if (main) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(main, 'Main desktop view is available');
      nativeMain = main;
      watch(main);
      await main.locator('#address-input').waitFor({ state: 'visible' });
      savedHistory = await main.evaluate(() => localStorage.getItem('pew.recent-urls'));

      await t.test('native viewport, history, rotation, and page state', async () => {
        await open(main, `${fixtureUrl}/first`);
        await ready(main);
        const site = context.pages().find((candidate) => candidate.url().includes(fixtureUrl));
        assert.ok(site);
        assert.deepEqual(
          await site.evaluate(() => [
            innerWidth,
            innerHeight,
            devicePixelRatio,
            navigator.maxTouchPoints,
          ]),
          [393, 852, 3, 5],
        );
        await site.evaluate(() => document.querySelector('a').click());
        await main.waitForFunction(
          () =>
            document.querySelector('#address-input').value.includes('second') &&
            !document.querySelector('#back-button').disabled,
        );
        await main.locator('#back-button').click();
        await main.waitForFunction(
          () =>
            document.querySelector('#address-input').value.includes('first') &&
            !document.querySelector('#forward-button').disabled,
        );
        await main.locator('#forward-button').click();
        await ready(main);
        await site.getByRole('textbox').fill('keep this value');
        await main.locator('#recent-button').click();
        assert.equal(await main.locator('#recent-section').isVisible(), true);
        assert.equal(await site.getByRole('textbox').inputValue(), 'keep this value');
        assert.deepEqual(await site.evaluate(() => [innerWidth, innerHeight]), [393, 852]);
        await main.locator('#recent-button').click();
        await main.screenshot({ path: path.join(output, 'native-portrait.png') });
        const position = await main.evaluate(async () => {
          return window.__TAURI_INTERNALS__.invoke('plugin:window|outer_position', {
            label: 'main',
          });
        });
        await main.locator('#rotate-button').click();
        await main.waitForFunction(
          () =>
            document.querySelector('.phone').dataset.orientation === 'landscape' &&
            !document.querySelector('#rotate-button').disabled,
        );
        assert.deepEqual(await site.evaluate(() => [innerWidth, innerHeight]), [852, 393]);
        assert.equal(await site.getByRole('textbox').inputValue(), 'keep this value');
        const after = await main.evaluate(async () => {
          return window.__TAURI_INTERNALS__.invoke('plugin:window|outer_position', {
            label: 'main',
          });
        });
        assert.deepEqual(after, position);
        await main.screenshot({ path: path.join(output, 'native-landscape.png') });
      });

      await t.test('navigation during rotation retains the loading state', async () => {
        const rotating = main.locator('#rotate-button').click();
        await main.waitForFunction(
          () => document.querySelector('#site-viewport').dataset.state === 'rotating',
        );
        const site = context.pages().find((candidate) => candidate.url().includes(fixtureUrl));
        await site.evaluate((url) => {
          location.href = url;
        }, `${fixtureUrl}/delayed`);
        await rotating;
        await main.waitForFunction(
          () => document.querySelector('#site-viewport').dataset.state === 'loading',
          undefined,
          { timeout: 5_000 },
        );
        assert.equal(await main.locator('#rotate-button').isDisabled(), true);
        await main.locator('#stop-button').click();
        await ready(main);
        finishDelayed();
        await open(main, `${fixtureUrl}/first`);
        await ready(main);
      });

      await t.test('native PNG export, cancellation, and failure recovery', async () => {
        const beforeExport = await main.locator('#site-viewport').boundingBox();
        await main.locator('#screenshot-button').click();
        await main.waitForFunction(
          () => document.querySelector('#notice').dataset.kind === 'success',
        );
        assert.equal(await main.locator('#notice-text').getAttribute('role'), 'status');
        assert.equal(await main.locator('#notice-action').textContent(), 'Open folder');
        assert.deepEqual(await main.locator('#site-viewport').boundingBox(), beforeExport);
        const file = await main.locator('#notice-action').getAttribute('title');
        assert.equal(path.basename(path.dirname(file)), 'PEW');
        assert.match(path.basename(file), /^pew-\d+\.png$/);
        const data = await readFile(file);
        assert.equal(data.subarray(1, 4).toString(), 'PNG');
        assert.ok(data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0);
        await unlink(file);
        await open(main, `${fixtureUrl}/delayed`);
        await main.locator('#stop-button').click();
        await ready(main);
        finishDelayed();
        await open(main, `${fixtureUrl}/first`);
        await ready(main);
        await open(main, `${fixtureUrl}/delayed`);
        await main.locator('#home-button').click();
        await main.locator('#empty-state').waitFor({ state: 'visible' });
        finishDelayed();
        await open(main, 'http://127.0.0.1:1/unavailable');
        await main.locator('#notice').waitFor({ state: 'visible' });
        assert.match(await main.locator('#notice-text').textContent(), /could not be loaded/);
        await main.locator('#home-button').click();
        await main.locator('#empty-state').waitFor({ state: 'visible' });
      });

      await t.test('native custom viewports update density without losing page state', async () => {
        await open(main, `${fixtureUrl}/first`);
        await ready(main);
        const site = context.pages().find((candidate) => candidate.url().includes(fixtureUrl));
        await site.getByRole('textbox').fill('viewport state');
        await main.locator('#viewport-size').click();
        await main.locator('#viewport-preset').selectOption('3');
        await main.locator('#apply-viewport').click();
        await ready(main);
        assert.deepEqual(
          await site.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]),
          [768, 1024, 2],
        );
        assert.equal(await site.getByRole('textbox').inputValue(), 'viewport state');
        const rejection = await main.evaluate(async () => {
          try {
            await window.__TAURI_INTERNALS__.invoke('resize_site', {
              width: 99999,
              height: 1024,
              pixelRatio: 2,
              landscape: false,
              scale: 0.5,
            });
          } catch (error) {
            return String(error);
          }
        });
        assert.match(rejection, /between 240 and 1920/);
        assert.deepEqual(
          await site.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]),
          [768, 1024, 2],
        );
        await main.locator('#viewport-size').click();
        await main.locator('#viewport-width').fill('600');
        await main.locator('#viewport-height').fill('900');
        await main.locator('#viewport-density').selectOption('1');
        await main.locator('#apply-viewport').click();
        await ready(main);
        assert.deepEqual(
          await site.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]),
          [600, 900, 1],
        );
        await main.locator('#rotate-button').click();
        await ready(main);
        assert.deepEqual(
          await site.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]),
          [900, 600, 1],
        );
        assert.equal(await site.getByRole('textbox').inputValue(), 'viewport state');
      });
    }
    assert.deepEqual(errors, []);
  } finally {
    if (nativeMain && savedHistory !== undefined) {
      await nativeMain
        .evaluate((value) => {
          if (value === null) localStorage.removeItem('pew.recent-urls');
          else localStorage.setItem('pew.recent-urls', value);
        }, savedHistory)
        .catch(() => {});
    }
    if (native) await native.close();
    if (desktop && desktop.exitCode === null) desktop.kill();
    if (
      profile &&
      path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(profile).startsWith('pew-native-')
    ) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(
        () => {},
      );
    }
    if (browser) await browser.close();
    if (vite) await vite.close();
    finishDelayed();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
  }
});
