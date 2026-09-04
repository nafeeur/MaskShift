import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CdpConnection } from './cdp.mjs';
import { absolutePath, commandExists, ensureDir, id, nowIso, truncate } from '../core/utils.mjs';

const BROWSER_COMMANDS = process.platform === 'darwin'
  ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  : process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge'];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  } finally { clearTimeout(timer); }
}

function sanitizeProfile(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function evaluateExpression(expression, awaitPromise = true) {
  return { expression, awaitPromise, returnByValue: true, userGesture: true };
}

export class BrowserManager {
  constructor({ config, logger, eventBus, workspaceManager }) {
    this.config = config;
    this.logger = logger;
    this.eventBus = eventBus;
    this.workspaceManager = workspaceManager;
    this.instances = new Map();
    this.executable = null;
  }

  async discover(force = false) {
    if (this.executable && !force) return { available: true, executable: this.executable };
    const configured = this.config.get().browser?.executable;
    if (configured) {
      try { await fsp.access(configured); this.executable = configured; } catch { this.executable = await commandExists(configured); }
    }
    if (!this.executable) {
      for (const command of BROWSER_COMMANDS) {
        if (path.isAbsolute(command)) {
          try { await fsp.access(command); this.executable = command; break; } catch { /* next */ }
        } else {
          const found = await commandExists(command);
          if (found) { this.executable = found; break; }
        }
      }
    }
    return { available: Boolean(this.executable), executable: this.executable, candidates: BROWSER_COMMANDS };
  }

  publicInstance(instance) {
    return {
      id: instance.id, pid: instance.process.pid, port: instance.port, headless: instance.headless,
      profile: instance.profile, userDataDir: instance.userDataDir, startedAt: instance.startedAt,
      status: instance.closed ? 'closed' : 'running', executable: instance.executable,
    };
  }

  list() { return [...this.instances.values()].map((item) => this.publicInstance(item)); }

  async launch({ headless = true, profile = 'default', url = 'about:blank', extraArgs = [], executable = null, reuse = true } = {}) {
    if (reuse) {
      const existing = [...this.instances.values()].find((item) => !item.closed && item.profile === profile && item.headless === headless);
      if (existing) {
        if (url && url !== 'about:blank') await this.navigate({ instanceId: existing.id, url });
        return this.publicInstance(existing);
      }
    }
    if (executable) this.executable = executable;
    const discovery = await this.discover();
    if (!discovery.available) throw new Error(`No Chromium-based browser found. Tried: ${discovery.candidates.join(', ')}`);
    const instanceId = id('browser');
    const port = await freePort();
    const profileName = sanitizeProfile(profile);
    const base = this.config.get().browser?.profilesDir || path.join(this.config.get().home, 'browser', 'profiles');
    const userDataDir = absolutePath(path.join(base, profileName));
    await ensureDir(userDataDir);
    const args = [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-features=Translate,OptimizationHints',
      '--window-size=1440,1000',
      ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
      ...(process.platform === 'linux' && (typeof process.getuid !== 'function' || process.getuid() === 0) ? ['--no-sandbox'] : []),
      ...(this.config.get().browser?.args || []), ...(extraArgs || []), url || 'about:blank',
    ];
    const child = spawn(this.executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    const instance = {
      id: instanceId, process: child, port, headless, profile: profileName, userDataDir,
      executable: this.executable, startedAt: nowIso(), connections: new Map(), closed: false, stderr: '',
    };
    this.instances.set(instanceId, instance);
    child.stderr.on('data', (chunk) => { instance.stderr = (instance.stderr + chunk.toString()).slice(-40_000); });
    child.once('close', (code, signal) => {
      instance.closed = true;
      for (const connection of instance.connections.values()) connection.close();
      instance.connections.clear();
      this.eventBus?.emit('browser.exited', { instanceId, code, signal });
    });
    child.once('error', (error) => { instance.stderr += `\n${error.message}`; instance.closed = true; });
    const deadline = Date.now() + 20_000;
    let version;
    while (Date.now() < deadline) {
      if (instance.closed) throw new Error(`Browser exited during startup: ${truncate(instance.stderr, 4000)}`);
      try { version = await fetchJson(`http://127.0.0.1:${port}/json/version`, {}, 1000); break; } catch { await new Promise((resolve) => setTimeout(resolve, 120)); }
    }
    if (!version) {
      await this.close(instanceId).catch(() => {});
      throw new Error(`Browser debugging endpoint did not start: ${truncate(instance.stderr, 4000)}`);
    }
    instance.version = version;
    this.eventBus?.emit('browser.started', { ...this.publicInstance(instance), version });
    return this.publicInstance(instance);
  }

  get(instanceId = null) {
    const instance = instanceId ? this.instances.get(instanceId) : [...this.instances.values()].find((item) => !item.closed);
    if (!instance || instance.closed) throw new Error(instanceId ? `Unknown browser instance: ${instanceId}` : 'No browser is running');
    return instance;
  }

  async tabs(instanceId = null) {
    const instance = this.get(instanceId);
    const targets = await fetchJson(`http://127.0.0.1:${instance.port}/json/list`);
    return targets.filter((target) => target.type === 'page').map((target) => ({
      id: target.id, title: target.title, url: target.url, type: target.type, webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }));
  }

  async newTab(instanceId = null, url = 'about:blank') {
    const instance = this.get(instanceId);
    let target;
    const endpoint = `http://127.0.0.1:${instance.port}/json/new?${encodeURIComponent(url)}`;
    try { target = await fetchJson(endpoint, { method: 'PUT' }); } catch { target = await fetchJson(endpoint); }
    return { id: target.id, title: target.title, url: target.url, type: target.type };
  }

  async target(instanceId = null, tabId = null) {
    const instance = this.get(instanceId);
    const tabs = await this.tabs(instance.id);
    const tab = tabId ? tabs.find((item) => item.id === tabId) : tabs[0];
    if (!tab) throw new Error(tabId ? `Browser tab not found: ${tabId}` : 'Browser has no page tab');
    let connection = instance.connections.get(tab.id);
    if (!connection) {
      connection = new CdpConnection(tab.webSocketDebuggerUrl);
      await connection.connect();
      instance.connections.set(tab.id, connection);
      await Promise.allSettled([
        connection.send('Page.enable'), connection.send('Runtime.enable'), connection.send('DOM.enable'),
        connection.send('Network.enable'), connection.send('Log.enable'), connection.send('Console.enable'),
      ]);
    }
    return { instance, tab, connection };
  }

  async navigate({ instanceId = null, tabId = null, url, waitUntil = 'complete', timeoutMs = 45_000 }) {
    if (!url) throw new Error('url is required');
    let target;
    try { target = await this.target(instanceId, tabId); } catch {
      const instance = this.get(instanceId);
      const tab = await this.newTab(instance.id, url);
      target = await this.target(instance.id, tab.id);
    }
    await target.connection.send('Page.navigate', { url }, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const result = await target.connection.send('Runtime.evaluate', evaluateExpression('document.readyState'));
        const state = result?.result?.value;
        if (waitUntil === 'domcontentloaded' ? ['interactive', 'complete'].includes(state) : state === 'complete') break;
      } catch { /* navigation context may be replacing */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const info = await this.evaluate({ instanceId: target.instance.id, tabId: target.tab.id, expression: '({url: location.href, title: document.title, readyState: document.readyState})' });
    this.eventBus?.emit('browser.navigated', { instanceId: target.instance.id, tabId: target.tab.id, ...info.value });
    return { instanceId: target.instance.id, tabId: target.tab.id, ...info.value };
  }

  async evaluate({ instanceId = null, tabId = null, expression, awaitPromise = true }) {
    if (!expression) throw new Error('expression is required');
    const { instance, tab, connection } = await this.target(instanceId, tabId);
    const result = await connection.send('Runtime.evaluate', evaluateExpression(expression, awaitPromise));
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed');
    return { instanceId: instance.id, tabId: tab.id, value: result.result?.value, description: result.result?.description, type: result.result?.type };
  }

  async snapshot({ instanceId = null, tabId = null, maxTextChars = 80_000 } = {}) {
    const expression = `(() => {
      const selector = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        while (el && el.nodeType === 1 && parts.length < 6) {
          let part = el.tagName.toLowerCase();
          if (el.classList.length) part += '.' + [...el.classList].slice(0, 2).map(CSS.escape).join('.');
          const parent = el.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter(x => x.tagName === el.tagName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
          }
          parts.unshift(part); el = parent;
        }
        return parts.join(' > ');
      };
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const interactive = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
        .filter(visible).slice(0, 500).map((el, index) => ({ index, tag: el.tagName.toLowerCase(), selector: selector(el), text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 500), type: el.type || null, href: el.href || null, disabled: Boolean(el.disabled), rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })() }));
      return { url: location.href, title: document.title, readyState: document.readyState, text: (document.body?.innerText || '').slice(0, ${Number(maxTextChars)}), interactive };
    })()`;
    return this.evaluate({ instanceId, tabId, expression });
  }

  async accessibility({ instanceId = null, tabId = null, limit = 1500 } = {}) {
    const { instance, tab, connection } = await this.target(instanceId, tabId);
    const tree = await connection.send('Accessibility.getFullAXTree');
    return { instanceId: instance.id, tabId: tab.id, nodes: (tree.nodes || []).slice(0, limit) };
  }

  async click({ instanceId = null, tabId = null, selector = null, x = null, y = null, button = 'left', clickCount = 1 }) {
    const target = await this.target(instanceId, tabId);
    if (selector) {
      const encoded = JSON.stringify(selector);
      const result = await this.evaluate({ instanceId: target.instance.id, tabId: target.tab.id, expression: `(() => { const el = document.querySelector(${encoded}); if (!el) throw new Error('Selector not found: ' + ${encoded}); el.scrollIntoView({block:'center', inline:'center'}); const r = el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()` });
      x = result.value.x; y = result.value.y;
    }
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('click requires selector or numeric x/y');
    const params = { x: Number(x), y: Number(y), button, clickCount: Number(clickCount) || 1 };
    await target.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
    await target.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
    return { instanceId: target.instance.id, tabId: target.tab.id, x: params.x, y: params.y, button, clickCount: params.clickCount };
  }

  async type({ instanceId = null, tabId = null, selector = null, text = '', clear = false, submit = false }) {
    const target = await this.target(instanceId, tabId);
    if (selector) {
      const encoded = JSON.stringify(selector);
      await this.evaluate({ instanceId: target.instance.id, tabId: target.tab.id, expression: `(() => { const el = document.querySelector(${encoded}); if (!el) throw new Error('Selector not found: ' + ${encoded}); el.focus(); ${clear ? "if ('value' in el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); }" : ''} return true; })()` });
    }
    await target.connection.send('Input.insertText', { text: String(text) });
    if (submit) {
      await target.connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await target.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    return { instanceId: target.instance.id, tabId: target.tab.id, characters: String(text).length, submitted: submit };
  }

  async waitFor({ instanceId = null, tabId = null, selector, state = 'visible', timeoutMs = 30_000 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.evaluate({ instanceId, tabId, expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return {exists:false,visible:false}; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return {exists:true,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'}; })()` }).catch(() => ({ value: { exists: false, visible: false } }));
      const value = result.value;
      if ((state === 'attached' && value.exists) || (state === 'visible' && value.visible) || (state === 'hidden' && !value.visible) || (state === 'detached' && !value.exists)) return { matched: true, state, selector };
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(`Timed out waiting for ${selector} to be ${state}`);
  }

  // A relative artifact path belongs to the workspace, not to whatever directory the
  // MaskShift process happens to run from.
  artifactBase(workspaceId) {
    const workspace = workspaceId ? this.workspaceManager.get(workspaceId) : null;
    return workspace?.path || path.join(this.config.get().home, 'artifacts');
  }

  async screenshot({ instanceId = null, tabId = null, file = null, fullPage = true, format = 'png', quality = 90, workspaceId = null } = {}) {
    const { instance, tab, connection } = await this.target(instanceId, tabId);
    let clip;
    if (fullPage) {
      const metrics = await connection.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      clip = { x: 0, y: 0, width: Math.max(1, size.width), height: Math.max(1, size.height), scale: 1 };
    }
    const result = await connection.send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? quality : undefined, captureBeyondViewport: fullPage, fromSurface: true, ...(clip ? { clip } : {}) }, 60_000);
    const base = this.artifactBase(workspaceId);
    const output = absolutePath(file || `maskshift-browser-${Date.now()}.${format === 'jpeg' ? 'jpg' : format}`, base);
    await ensureDir(path.dirname(output));
    await fsp.writeFile(output, Buffer.from(result.data, 'base64'));
    return { instanceId: instance.id, tabId: tab.id, file: output, bytes: Buffer.byteLength(result.data, 'base64'), format, fullPage };
  }

  async printPdf({ instanceId = null, tabId = null, file = null, landscape = false, printBackground = true, workspaceId = null } = {}) {
    const { instance, tab, connection } = await this.target(instanceId, tabId);
    const result = await connection.send('Page.printToPDF', { landscape, printBackground, preferCSSPageSize: true }, 60_000);
    const base = this.artifactBase(workspaceId);
    const output = absolutePath(file || `maskshift-page-${Date.now()}.pdf`, base);
    await ensureDir(path.dirname(output));
    await fsp.writeFile(output, Buffer.from(result.data, 'base64'));
    return { instanceId: instance.id, tabId: tab.id, file: output, bytes: Buffer.byteLength(result.data, 'base64') };
  }

  async console({ instanceId = null, tabId = null, limit = 200 } = {}) {
    const { instance, tab, connection } = await this.target(instanceId, tabId);
    const methods = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);
    return { instanceId: instance.id, tabId: tab.id, events: connection.recent(null, limit * 4).filter((event) => methods.has(event.method)).slice(-limit) };
  }

  async network({ instanceId = null, tabId = null, limit = 300 } = {}) {
    const { instance, tab, connection } = await this.target(instanceId, tabId);
    return { instanceId: instance.id, tabId: tab.id, events: connection.recent(null, limit * 5).filter((event) => event.method.startsWith('Network.')).slice(-limit) };
  }

  async closeTab(instanceId = null, tabId) {
    const instance = this.get(instanceId);
    if (!tabId) throw new Error('tabId is required');
    const response = await fetch(`http://127.0.0.1:${instance.port}/json/close/${encodeURIComponent(tabId)}`);
    const connection = instance.connections.get(tabId);
    connection?.close(); instance.connections.delete(tabId);
    return { instanceId: instance.id, tabId, closed: response.ok };
  }

  async close(instanceId = null) {
    const instance = this.get(instanceId);
    for (const connection of instance.connections.values()) connection.close();
    instance.connections.clear();
    try {
      if (process.platform !== 'win32') process.kill(-instance.process.pid, 'SIGTERM');
      else instance.process.kill('SIGTERM');
    } catch { try { instance.process.kill('SIGTERM'); } catch { /* exited */ } }
    instance.closed = true;
    this.instances.delete(instance.id);
    return { instanceId: instance.id, closed: true };
  }

  async closeAll() {
    for (const instance of [...this.instances.values()]) await this.close(instance.id).catch(() => {});
  }
}
