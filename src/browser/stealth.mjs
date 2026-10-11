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

// Match the Chromium major your users are actually on — a UA claiming an old
// Chrome while the binary's behavior says otherwise is itself a signal. Bump
// when the supported floor moves; ideally this tracks the discovered binary
// (see BrowserManager, which knows the real version from /json/version).
const CHROME_MAJOR = '151';

// Consistent desktop identities, keyed by platform. UA, Sec-CH-UA headers,
// navigator.platform and navigator.userAgentData must all tell the same
// story or the mismatch itself becomes the signal.
const IDENTITIES = {
  darwin: {
    platform: 'MacIntel',
    uaPlatform: '"macOS"',
    ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  },
  win32: {
    platform: 'Win32',
    uaPlatform: '"Windows"',
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  },
  linux: {
    platform: 'Linux x86_64',
    uaPlatform: '"Linux"',
    ua: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  },
};

export function stealthIdentity(platform = process.platform) {
  return IDENTITIES[platform] || IDENTITIES.linux;
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
export function stealthInitScript({ platform = process.platform, headless = true, languages = ['en-US', 'en'] } = {}) {
  const identity = stealthIdentity(platform);
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

  // The single highest-signal tell: true only under automation. Delete the
  // prototype descriptor outright so the property is absent, not false —
  // detectors check for undefined, and blink leaves it defined-but-false
  // once AutomationControlled strips the automation-controlled true.
  define(Navigator.prototype, 'webdriver', undefined);

  define(Navigator.prototype, 'platform', ${JSON.stringify(identity.platform)});
  define(Navigator.prototype, 'languages', ${JSON.stringify(languages)});
  define(Navigator.prototype, 'hardwareConcurrency', 8);
  define(Navigator.prototype, 'deviceMemory', 8);

  // clientHint headers say one platform; userAgentData must agree.
  define(Navigator.prototype, 'userAgentData', {
    brands: [
      { brand: 'Google Chrome', version: ${JSON.stringify(CHROME_MAJOR)} },
      { brand: 'Chromium', version: ${JSON.stringify(CHROME_MAJOR)} },
      { brand: 'Not_A Brand', version: '24' },
    ],
    mobile: false,
    platform: ${JSON.stringify(identity.uaPlatform.replace(/"/g, ''))},
    getHighEntropyValues: (hints) => Promise.resolve({
      architecture: 'x86',
      bitness: '64',
      brands: [
        { brand: 'Google Chrome', version: ${JSON.stringify(CHROME_MAJOR)} },
        { brand: 'Chromium', version: ${JSON.stringify(CHROME_MAJOR)} },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: ${JSON.stringify(`${CHROME_MAJOR}.0.0.0`)} },
        { brand: 'Chromium', version: ${JSON.stringify(`${CHROME_MAJOR}.0.0.0`)} },
        { brand: 'Not_A Brand', version: '24.0.0.0' },
      ],
      mobile: false,
      model: '',
      platform: ${JSON.stringify(identity.uaPlatform.replace(/"/g, ''))},
      platformVersion: '15.0.0',
      uaFullVersion: ${JSON.stringify(`${CHROME_MAJOR}.0.0.0`)},
    }),
    toJSON: () => ({}),
  });

  // Headless Chrome ships zero plugins and zero mimeTypes; a desktop
  // browser always reports the PDF viewer set.
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
  const makeNamedArray = (items) => {
    const arr = [...items];
    for (const item of items) arr[item.name || item.type] = item;
    arr.item = (i) => items[i] || null;
    arr.namedItem = (name) => arr[name] || null;
    arr.refresh = () => {};
    return arr;
  };
  const mimeTypes = makeNamedArray(mimeTypeData.map((m) => ({ ...m, enabledPlugin: null })));
  const plugins = makeNamedArray(pluginData.map((p) => ({ ...p })));
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
  }
})();`;
}
