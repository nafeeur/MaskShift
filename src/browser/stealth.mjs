// Stealth hardening for MaskShift browser instances.
//
// None of this solves a challenge that is actually presented — when a site
// decides to show a CAPTCHA anyway, the answer is browser_handoff, not more
// patching. What it does do is stop volunteering the signals bot scores key
// on before a challenge is ever considered:
//
//   1. Launch arguments that change the binary's self-description: Chrome's
//      `--headless=new` leaks "HeadlessChrome" in the User-Agent and
//      `Sec-CH-UA` headers, and the headless binary defaults WebGL's
//      UNMASKED_RENDERER to "SwiftShader" (software rasterization) — both
//      are near-certain automation tells. We neutralize both, plus a
//      handful of automation-adjacent features (AutomationControlled).
//   2. A script installed via Page.addScriptToEvaluateOnNewDocument on
//      every tab, so it runs before any page script in every document
//      (including iframes). It deletes navigator.webdriver and rebuilds
//      the small navigator surface (plugins, languages, permissions,
//      chrome runtime) that headless Chrome leaves empty.

// The only thing the UA override should change is stripping "Headless" from
// the product token. Everything else — arch, platform, brand, version — must
// match what the binary already puts on the wire (Sec-CH-UA) and in JS
// (userAgentData, navigator.platform), or the mismatch itself is the signal.
// So identity is derived from the host arch, not hardcoded to a desktop guess.
const CHROME_MAJOR = '151';

// process.arch -> the CPU token Chrome bakes into its User-Agent string.
const ARCH_TOKEN = { arm64: 'aarch64', x64: 'x86_64' };

// Consistent identities, keyed by platform. UA, Sec-CH-UA headers,
// navigator.platform and navigator.userAgentData must all tell the same
// story or the mismatch itself becomes the signal.
const IDENTITIES = {
  darwin: {
    platform: 'MacIntel',
    uaPlatform: 'macOS',
    ua: (major) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  },
  win32: {
    platform: 'Win32',
    uaPlatform: 'Windows',
    ua: (major) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  },
  linux: {
    platform: 'Linux x86_64',
    uaPlatform: 'Linux',
    // Chrome's linux UA carries the real CPU arch; aarch64 stays aarch64.
    ua: (major, arch = 'x86_64') => `Mozilla/5.0 (X11; Linux ${arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  },
};

export function stealthIdentity(platform = process.platform, { arch = process.arch, major = CHROME_MAJOR } = {}) {
  const base = IDENTITIES[platform] || IDENTITIES.linux;
  const archToken = platform === 'linux' || (!IDENTITIES[platform]) ? (ARCH_TOKEN[arch] || 'x86_64') : undefined;
  return {
    platform: base.platform,
    uaPlatform: base.uaPlatform,
    ua: base.ua(major, archToken),
    major,
  };
}

/**
 * Extra Chrome arguments for a stealth launch. Caller still owns
 * --remote-debugging-port, --user-data-dir and friends.
 *
 * `headless: false` skips the headless-only fixes (UA override,
 * SwiftShader WebGL mask) that would be wrong or redundant in a visible
 * window, where the binary already reports the real thing.
 */
export function stealthArgs({ platform = process.platform, headless = true } = {}) {
  const identity = stealthIdentity(platform);
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
  ];
  if (headless) {
    args.push(`--user-agent=${identity.ua}`);
    // Headless's SwiftShader default is the tell; ask for a GL backend so
    // WebGL reports a real GPU family instead. Falls back harmlessly on
    // hosts without one — the init script's renderer-string patch is the
    // second layer in that case.
    args.push('--use-gl=angle');
  }
  return args;
}

/**
 * JavaScript source for Page.addScriptToEvaluateOnNewDocument. Runs in the
 * page's own world before any page script, once per document. Kept as a
 * function of the identity so tests can assert the exact strings a page
 * would see.
 */
export function stealthInitScript({ platform = process.platform, headless = true, languages = ['en-US', 'en'], arch = process.arch } = {}) {
  const identity = stealthIdentity(platform, { arch });
  return `(() => {
  'use strict';
  const define = (obj, key, value) => {
    try {
      // Blink defines webdriver on Navigator.prototype as non-configurable in
      // some builds; delete it first so the define below replaces rather than
      // silently fails against the existing descriptor.
      try { delete obj[key]; } catch { /* non-configurable */ }
      Object.defineProperty(obj, key, { get: () => value, configurable: true });
    } catch { /* leave the platform default */ }
  };

  // The single highest-signal tell: true only under automation. Real Chrome
  // reports false, so report false — and report it identically in workers
  // (which otherwise leave the property absent, a cross-thread mismatch).
  define(Navigator.prototype, 'webdriver', false);

  define(Navigator.prototype, 'platform', ${JSON.stringify(identity.platform)});
  define(Navigator.prototype, 'languages', ${JSON.stringify(languages)});
  define(Navigator.prototype, 'hardwareConcurrency', 8);
  // deviceMemory is non-configurable on some builds, so define may no-op; fall
  // back to setting it straight on navigator itself when the prototype patch
  // didn't take.
  define(Navigator.prototype, 'deviceMemory', 8);
  try { if (navigator.deviceMemory !== 8) Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true }); } catch { /* leave default */ }

  // Page.addScriptToEvaluateOnNewDocument does NOT run inside Web Workers, so a
  // worker's WorkerNavigator would show default (headless) values while the main
  // thread shows patched ones — that mismatch is itself a detector signal. Wrap
  // the Worker constructor to prepend the navigator patch into every worker's
  // source, so the worker's own values agree with the main thread.
  const workerPatch = '(function(){var d=function(o,k,v){try{delete o[k];Object.defineProperty(o,k,{get:function(){return v},configurable:true})}catch(e){}};'
    + 'try{var np=Object.getPrototypeOf(navigator);'
    // Match the main thread: with AutomationControlled off, navigator.webdriver is
    // defined-but-false there, so the worker must report false too (not absent).
    + 'd(np,"webdriver",false);'
    + 'd(np,"hardwareConcurrency",8);d(np,"deviceMemory",8);'
    + 'd(np,"languages",' + JSON.stringify(JSON.stringify(languages)) + ');'
    + 'd(np,"platform",' + JSON.stringify(JSON.stringify(identity.platform)) + ');}catch(e){}})();';
  if (typeof Worker === 'function' && !Worker.__stealthWrapped) {
    const OriginalWorker = Worker;
    const WrappedWorker = function (scriptURL, options) {
      try {
        const url = String(scriptURL);
        // Only same-origin / blob / data URLs can be fetched and rewritten here.
        if (/^(blob:|data:)/i.test(url)) {
          return new OriginalWorker(scriptURL, options); // already our own or opaque; leave
        }
        const request = new XMLHttpRequest();
        request.open('GET', url, false); // synchronous so the constructor stays synchronous
        request.send(null);
        if (request.status >= 200 && request.status < 400 || request.status === 0) {
          const combined = workerPatch + ';\n' + request.responseText;
          const blob = new Blob([combined], { type: 'application/javascript' });
          return new OriginalWorker(URL.createObjectURL(blob), options);
        }
      } catch { /* fall through to unmodified construction */ }
      return new OriginalWorker(scriptURL, options);
    };
    WrappedWorker.prototype = OriginalWorker.prototype;
    Object.setPrototypeOf(WrappedWorker, OriginalWorker);
    WrappedWorker.__stealthWrapped = true;
    window.Worker = WrappedWorker;
  }

  // userAgentData must agree with the wire client hints (Sec-CH-UA), which the
  // binary sets from its real brand: Chromium, the real major, Not=A?Brand 99.
  // Claiming "Google Chrome" here while Sec-Ch-Ua says "Chromium" is a tell.
  const major = ${JSON.stringify(identity.major)};
  define(Navigator.prototype, 'userAgentData', {
    brands: [
      { brand: 'Chromium', version: major },
      { brand: 'Not=A?Brand', version: '99' },
    ],
    mobile: false,
    platform: ${JSON.stringify(identity.uaPlatform)},
    getHighEntropyValues: (hints) => Promise.resolve({
      architecture: ${JSON.stringify((ARCH_TOKEN[arch] === 'aarch64') ? 'arm' : 'x86')},
      bitness: '64',
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Not=A?Brand', version: '99' },
      ],
      fullVersionList: [
        { brand: 'Chromium', version: major + '.0.0.0' },
        { brand: 'Not=A?Brand', version: '99.0.0.0' },
      ],
      mobile: false,
      model: '',
      platform: ${JSON.stringify(identity.uaPlatform)},
      platformVersion: '15.0.0',
      uaFullVersion: major + '.0.0.0',
      wow64: false,
    }),
    toJSON: () => ({}),
  });

  // Headless Chrome ships zero plugins and zero mimeTypes; a desktop
  // browser always reports the PDF viewer set. Each object must sit on its
  // real prototype: navigator.plugins instanceof PluginArray and each entry
  // instanceof Plugin are checks a plain array of objects fails.
  const pluginData = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ];
  const mimeTypeData = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
  ];
  // Instantiate against the real prototypes when present (any real Chromium);
  // fall back to plain objects only where the constructor is unavailable.
  const onProto = (proto, props) => {
    const obj = proto ? Object.create(proto) : {};
    for (const [k, v] of Object.entries(props)) {
      try { Object.defineProperty(obj, k, { get: () => v, enumerable: true, configurable: true }); } catch { obj[k] = v; }
    }
    return obj;
  };
  const makeList = (Ctor, items) => {
    const list = Ctor ? Object.create(Ctor.prototype) : [];
    items.forEach((item, i) => {
      Object.defineProperty(list, i, { get: () => item, enumerable: true, configurable: true });
      const key = item.name || item.type;
      if (key) Object.defineProperty(list, key, { get: () => item, configurable: true });
    });
    Object.defineProperty(list, 'length', { get: () => items.length, configurable: true });
    if (!list.item) list.item = (i) => items[i] || null;
    if (!list.namedItem) list.namedItem = (name) => items.find((x) => (x.name || x.type) === name) || null;
    if (Ctor && Ctor.prototype && 'refresh' in Ctor.prototype && !list.refresh) list.refresh = () => {};
    return list;
  };
  const MimeTypeCtor = window.MimeType;
  const PluginCtor = window.Plugin;
  const mimeTypes = makeList(window.MimeTypeArray, mimeTypeData.map((m) => onProto(MimeTypeCtor && MimeTypeCtor.prototype, { ...m, enabledPlugin: null })));
  const plugins = makeList(window.PluginArray, pluginData.map((p) => onProto(PluginCtor && PluginCtor.prototype, { ...p, length: 1 })));
  define(Navigator.prototype, 'plugins', plugins);
  define(Navigator.prototype, 'mimeTypes', mimeTypes);

  // permissions.query({name:'notifications'}) returns 'denied' under
  // automation, 'prompt' for a fresh real profile.
  if (window.navigator.permissions && typeof window.navigator.permissions.query === 'function') {
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) =>
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : originalQuery(parameters);
  }

  // window.chrome is present in every desktop Chrome, absent in headless.
  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
      runtime: {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      },
    };
  }

  // SwiftShader = software rendering = headless. If the GL backend arg
  // didn't find a GPU, patch the two debug strings WebGL exposes. Uses a
  // plain prototype wrap (no toString games): pages calling
  // getParameter directly still work, and nothing claims to be native code.
  if (${headless ? 'true' : 'false'}) {
    const patchContext = (proto) => {
      if (!proto || proto.__stealthPatched) return;
      const original = proto.getParameter;
      proto.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
        return original.call(this, parameter);
      };
      proto.__stealthPatched = true;
    };
    patchContext(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patchContext(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);

    // Headless clamps performance.now() to a coarse 100µs grid; a desktop
    // browser returns sub-microsecond floats. Add a tiny jitter so successive
    // reads aren't suspiciously rounded. Kept small so timing logic still works.
    const origNow = performance.now.bind(performance);
    performance.now = function () { const t = origNow(); return t + (t % 0.001 ? 0 : Math.random() * 0.0009); };
    if (window.Performance && window.Performance.prototype) {
      try { Object.defineProperty(window.Performance.prototype, 'now', { value: performance.now, configurable: true, writable: true }); } catch { /* leave */ }
    }
  }
})();`;
}
