import assert from 'node:assert/strict';
import test from 'node:test';
import { stealthArgs, stealthIdentity, stealthInitScript } from '../src/browser/stealth.mjs';
import { BrowserManager } from '../src/browser/manager.mjs';
import { createProject, runtimeForTest } from './helpers.mjs';

test('stealthArgs removes automation and headless tells', () => {
  const headless = stealthArgs({ headless: true });
  assert.ok(headless.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(headless.some((arg) => arg.startsWith('--user-agent=Mozilla/5.0') && !arg.includes('HeadlessChrome')));
  assert.ok(headless.includes('--use-gl=angle'));

  const visible = stealthArgs({ headless: false });
  assert.ok(visible.includes('--disable-blink-features=AutomationControlled'));
  // UA override is headless-only; a real window already reports itself honestly.
  assert.ok(!visible.some((arg) => arg.startsWith('--user-agent=')));
});

test('stealthIdentity stays internally consistent per platform', () => {
  assert.equal(stealthIdentity('darwin').platform, 'MacIntel');
  assert.match(stealthIdentity('darwin').ua, /Macintosh/);
  assert.equal(stealthIdentity('win32').platform, 'Win32');
  assert.match(stealthIdentity('win32').ua, /Windows NT/);
  assert.equal(stealthIdentity('linux').platform, 'Linux x86_64');
  assert.match(stealthIdentity('linux').ua, /X11; Linux x86_64/);
  // Unknown platforms fall back to linux rather than producing nothing.
  assert.deepEqual(stealthIdentity('freebsd'), stealthIdentity('linux'));
});

test('stealthInitScript patches the navigator surface a page can probe', () => {
  const source = stealthInitScript({ headless: true });
  assert.ok(source.includes('webdriver'));
  assert.ok(source.includes("'plugins'"));
  assert.ok(source.includes("'languages'"));
  assert.ok(source.includes('window.chrome'));
  assert.ok(source.includes('37446'), 'WebGL UNMASKED_RENDERER is patched');
  assert.ok(!source.includes('HeadlessChrome'));
});

test('stealth launch config defaults on and can be disabled per launch', async (t) => {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);

  assert.equal(runtime.config.get().browser.stealth, true, 'stealth defaults on in config');

  const discovery = await runtime.browserManager.discover();
  if (!discovery.available) {
    t.skip('no Chromium-based browser installed on this host');
    return;
  }

  const probe = `(() => ({
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
    languages: navigator.languages,
    plugins: navigator.plugins.length,
    hasChrome: Boolean(window.chrome),
    webglRenderer: (() => {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      } catch { return null; }
    })(),
  }))()`;

  // Stealth on (default): the page must not see automation. reuse:false so a
  // stale pre-stealth instance from an earlier test/run is never handed back —
  // reuse matches on profile+headless, not stealth, and a reused instance has
  // no init script installed. Navigate after launch so the init script (added
  // on new documents) has run before the probe.
  const instance = await runtime.browserManager.launch({ headless: true, url: 'about:blank', reuse: false });
  await runtime.browserManager.navigate({ instanceId: instance.id, url: 'about:blank' });
  const on = await runtime.browserManager.evaluate({ instanceId: instance.id, expression: probe });
  assert.equal(on.value.webdriver, undefined, 'navigator.webdriver must be absent');
  assert.ok(!on.value.ua.includes('HeadlessChrome'), `UA leaked headless: ${on.value.ua}`);
  assert.ok(Array.isArray(on.value.languages) && on.value.languages.length >= 1);
  assert.ok(on.value.plugins >= 1, 'plugins must not be empty');
  assert.equal(on.value.hasChrome, true, 'window.chrome must exist');
  if (on.value.webglRenderer) assert.ok(!/swiftshader/i.test(on.value.webglRenderer), `WebGL leaked SwiftShader: ${on.value.webglRenderer}`);
  await runtime.browserManager.close(instance.id);

  // Stealth explicitly off: the unpatched browser tells the truth again.
  const plain = await runtime.browserManager.launch({ headless: true, stealth: false, reuse: false });
  const off = await runtime.browserManager.evaluate({ instanceId: plain.id, expression: probe });
  assert.match(off.value.ua, /HeadlessChrome/, 'without stealth the headless UA should be visible');
  await runtime.browserManager.close(plain.id);
});
