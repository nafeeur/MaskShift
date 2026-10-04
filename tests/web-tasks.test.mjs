import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { InteractionBroker, NoInteractiveSurfaceError, normalizeOptions } from '../src/core/interaction.mjs';
import { SecretVault, keychainBackends } from '../src/core/secrets.mjs';
import { loginFlow, maskUsername } from '../src/web/login.mjs';
import { renderPageModel } from '../src/web/page-model.mjs';
import { createProject, jsonServer, runtimeForTest } from './helpers.mjs';

async function findBrowser(runtime) {
  const candidates = [process.env.MASKSHIFT_TEST_BROWSER, '/opt/pw-browsers/chromium'].filter(Boolean);
  for (const candidate of candidates) { try { await fsp.access(candidate); return candidate; } catch { /* next */ } }
  const found = await runtime.browserManager.discover(true).catch(() => null);
  return found?.executable || found?.executables?.[0]?.path || null;
}

const PASSWORD = 'correct horse battery';
const CODE = '246810';

// A small site: a restaurant list, a two-step login with a code, and a CAPTCHA-gated login.
function siteHandler(log) {
  const page = (body, title = 'Fixture') => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;
  const names = ['Luigi Pizza', 'Sushi Go', 'Taco Town', 'Burger Barn', 'Pho Real'];
  return (request, response) => {
    const url = new URL(request.url, 'http://x');
    const send = (html, headers = {}) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); response.end(html); };
    const redirect = (to, headers = {}) => { response.writeHead(302, { location: to, ...headers }); response.end(); };
    const readBody = () => new Promise((resolve) => { let data = ''; request.on('data', (chunk) => { data += chunk; }); request.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data)))); });
    if (url.pathname === '/menu') {
      return send(page(`<nav><a href="/">Home</a></nav><h2>Restaurants near you</h2><div>${names.map((name, index) => `<a href="/r/${index}" class="card"><h3>${name}</h3><div>4.${index} ★ · 20-30 min</div><div>Delivery $${index}.99</div></a>`).join('')}</div>
        <div role="dialog" aria-label="x" style="display:none"></div>`, 'Nearby'));
    }
    if (url.pathname.startsWith('/r/')) return send(page(`<h1>${names[Number(url.pathname.slice(3))]}</h1><button>Place order</button><button>Add to cart</button>`, 'Restaurant'));
    if (url.pathname === '/login' && request.method === 'GET') {
      const gate = url.searchParams.get('captcha') ? '<div class="g-recaptcha" style="width:300px;height:80px;border:1px solid #888">I am not a robot</div>' : '';
      return send(page(`${url.searchParams.get('err') ? '<div role="alert">Incorrect email or password</div>' : ''}${gate}
        <form method="post" action="/login${url.searchParams.get('captcha') ? '?captcha=1' : ''}"><label>Email <input name="email" type="email" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`, 'Sign in'));
    }
    if (url.pathname === '/login' && request.method === 'POST') {
      return readBody().then((body) => {
        log.posted.push(body);
        if (body.email === 'jane@example.com' && body.password === PASSWORD) return redirect('/code', { 'set-cookie': 'step1=1; Path=/' });
        return redirect('/login?err=1');
      });
    }
    if (url.pathname === '/code' && request.method === 'GET') {
      return send(page(`${url.searchParams.get('err') ? '<div role="alert">Incorrect code</div>' : ''}<form method="post" action="/code"><label>Verification code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label><button type="submit">Verify</button></form>`, 'Verify'));
    }
    if (url.pathname === '/code' && request.method === 'POST') {
      return readBody().then((body) => {
        log.codes.push(body.code);
        return body.code === CODE ? redirect('/account', { 'set-cookie': 'session=ok; Path=/' }) : redirect('/code?err=1');
      });
    }
    if (url.pathname === '/account') return send(page('<h1>Welcome back</h1><a href="/orders">Your orders</a>', 'Account'));
    if (url.pathname === '/plain') return send(page('<p>Nothing here</p>', 'Plain'));
    response.writeHead(404); response.end('not found');
  };
}

async function setup(t) {
  const project = await createProject(t);
  const runtime = await runtimeForTest(t, project);
  const executable = await findBrowser(runtime);
  if (!executable) { t.skip('no Chromium available'); return null; }
  const log = { posted: [], codes: [] };
  const site = await jsonServer(t, siteHandler(log));
  const instance = await runtime.browserManager.launch({ headless: true, url: `${site.url}/menu`, executable, extraArgs: ['--window-size=1100,800'] });
  t.after(async () => runtime.browserManager.closeAll());
  return { runtime, site, instance, log, browser: runtime.browserManager };
}

test('InteractionBroker validates answers, fails closed without a surface and never logs them', async () => {
  const events = [];
  const broker = new InteractionBroker({ eventBus: { emit: (name, payload) => events.push({ name, payload }) } });
  await assert.rejects(() => broker.choose({ options: ['a'] }), NoInteractiveSurfaceError);
  assert.equal(broker.supports('secret'), false);
  broker.attach({
    choose: async () => ({ ids: ['b', 'not-an-option'] }),
    secret: async () => ({ value: 'swordfish' }),
    confirm: async () => true,
    handoff: async () => true,
  });
  const picked = await broker.choose({ title: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assert.deepEqual(picked.ids, ['b']);
  assert.equal((await broker.secret({ title: 'Password' })).value, 'swordfish');
  assert.equal(await broker.confirm({ message: 'ok?' }), true);
  assert.equal((await broker.handoff({ message: 'go' })).done, true);
  assert.ok(events.some((event) => event.name === 'interaction.requested'));
  assert.doesNotMatch(JSON.stringify(events), /swordfish/);
  assert.equal(normalizeOptions(['x', 'x']).length, 2);
  assert.notEqual(normalizeOptions(['x', 'x'])[0].id, normalizeOptions(['x', 'x'])[1].id);
});

test('SecretVault keeps values out of the index and talks to the keychain through stdin, not argv', async () => {
  const calls = [];
  const settings = new Map();
  const runner = async (command, args, options = {}) => { calls.push({ command, args, input: options.input }); return { code: 0, stdout: 'stored-value\n', stderr: '' }; };
  const vault = new SecretVault({
    config: { get: () => ({ secrets: { backend: 'keychain' } }) },
    store: { getSetting: (key, fallback) => settings.get(key) ?? fallback, setSetting: (key, value) => settings.set(key, value) },
    platform: 'linux',
    backends: { linux: { ...keychainBackends(runner).linux, available: async () => true } },
  });
  const saved = await vault.set('login:example.com', 'password', 's3cret', { persist: true });
  assert.equal(saved.persisted, true);
  const store = calls.find((call) => call.args.includes('store'));
  assert.equal(store.input, 's3cret');
  assert.ok(!store.args.some((arg) => arg.includes('s3cret')), 'the secret is not in the command line');
  assert.deepEqual(vault.list(), [{ service: 'login:example.com', account: 'password', where: 'keychain' }]);
  assert.doesNotMatch(JSON.stringify([...settings.values()]), /s3cret/);
  await vault.delete('login:example.com', 'password');
  assert.deepEqual(vault.list(), []);
  assert.equal(maskUsername('jane.doe@example.com'), 'j***@example.com');
});

test('the page model finds the options, the form and the blockers on a real page', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { model } = await ctx.browser.extract({ instanceId: ctx.instance.id });
  assert.equal(model.lists.length >= 1, true);
  assert.deepEqual(model.lists[0].options.map((option) => option.title), ['Luigi Pizza', 'Sushi Go', 'Taco Town', 'Burger Barn', 'Pho Real']);
  assert.equal(model.lists[0].options[1].url, `${ctx.site.url}/r/1`);
  assert.match(model.lists[0].options[2].price, /\$2\.99/);
  const text = renderPageModel(model);
  assert.match(text, /Sushi Go/);
  assert.ok(text.length < 2500, 'the description is compact');
  // Choosing by ref opens the page.
  const sushi = model.lists[0].options[1];
  const result = await ctx.browser.act({ instanceId: ctx.instance.id, ref: sushi.ref });
  assert.equal(result.url, `${ctx.site.url}/r/1`);
  // Refs are scoped to the page they came from.
  await assert.rejects(() => ctx.browser.act({ instanceId: ctx.instance.id, ref: sushi.ref }), /page changed/);
});

test('act refuses purchase buttons and password typing unless the caller opts in', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  await ctx.browser.navigate({ instanceId: ctx.instance.id, url: `${ctx.site.url}/r/0` });
  const { model } = await ctx.browser.extract({ instanceId: ctx.instance.id });
  const order = model.actions.find((action) => action.label === 'Place order');
  await assert.rejects(() => ctx.browser.act({ instanceId: ctx.instance.id, ref: order.ref }), (error) => error.code === 'RISKY_ACTION');
  const add = model.actions.find((action) => action.label === 'Add to cart');
  assert.equal((await ctx.browser.act({ instanceId: ctx.instance.id, ref: add.ref })).action, 'click');

  await ctx.browser.navigate({ instanceId: ctx.instance.id, url: `${ctx.site.url}/login` });
  const login = (await ctx.browser.extract({ instanceId: ctx.instance.id })).model.forms[0];
  const passwordField = login.fields.find((field) => field.type === 'password');
  await assert.rejects(() => ctx.browser.act({ instanceId: ctx.instance.id, ref: passwordField.ref, action: 'fill', value: 'x' }), /browser_login/);
});

test('login signs in through a code step, never exposes the secrets and can remember them for the session', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const asked = [];
  const broker = new InteractionBroker({ eventBus: ctx.runtime.eventBus });
  broker.attach({
    text: async (request) => { asked.push(request.title); return { value: 'jane@example.com' }; },
    secret: async (request) => { asked.push(request.title); return { value: /code/i.test(request.title) ? CODE : PASSWORD }; },
    confirm: async () => true,
  });
  const captured = [];
  ctx.runtime.eventBus.subscribe((event) => captured.push(event));
  const result = await loginFlow({ browser: ctx.browser, broker, vault: ctx.runtime.secretVault, instanceId: ctx.instance.id, url: `${ctx.site.url}/login` });
  assert.equal(result.status, 'logged_in', JSON.stringify(result));
  assert.equal(result.username, 'j***@example.com');
  assert.deepEqual(ctx.log.posted, [{ email: 'jane@example.com', password: PASSWORD }]);
  assert.deepEqual(ctx.log.codes, [CODE]);
  const everything = JSON.stringify([result, captured, asked]);
  assert.doesNotMatch(everything, new RegExp(PASSWORD));
  assert.doesNotMatch(everything, /jane@example\.com/);
  assert.doesNotMatch(everything, new RegExp(CODE));
  // Remembered for the session: the next login asks only for the code.
  assert.equal(await ctx.runtime.secretVault.get('login:127.0.0.1', 'password'), PASSWORD);
  const second = new InteractionBroker({});
  const secondAsked = [];
  second.attach({ secret: async (request) => { secondAsked.push(request.title); return { value: CODE }; }, text: async () => { throw new Error('should not ask for the username'); }, confirm: async () => false });
  await ctx.browser.navigate({ instanceId: ctx.instance.id, url: `${ctx.site.url}/login` });
  const again = await loginFlow({ browser: ctx.browser, broker: second, vault: ctx.runtime.secretVault, instanceId: ctx.instance.id });
  assert.equal(again.status, 'logged_in', JSON.stringify(again));
  assert.equal(secondAsked.length, 1);
  assert.match(secondAsked[0], /code/i);
});

test('login re-asks after a rejected password and gives up after a second rejection', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  let passwords = [PASSWORD.toUpperCase(), PASSWORD];
  const broker = new InteractionBroker({});
  broker.attach({ text: async () => ({ value: 'jane@example.com' }), secret: async (request) => ({ value: /code/i.test(request.title) ? CODE : passwords.shift() }), confirm: async () => false });
  const ok = await loginFlow({ browser: ctx.browser, broker, vault: ctx.runtime.secretVault, instanceId: ctx.instance.id, url: `${ctx.site.url}/login` });
  assert.equal(ok.status, 'logged_in', JSON.stringify(ok));

  passwords = ['nope', 'still nope', 'again'];
  const failed = await loginFlow({ browser: ctx.browser, broker, vault: new SecretVault({ config: { get: () => ({}) } }), instanceId: ctx.instance.id, url: `${ctx.site.url}/login` });
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.match(failed.message, /rejected/);
});

test('a CAPTCHA wall is handed to the person, not attempted', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const broker = new InteractionBroker({});
  let handedOff = 0;
  broker.attach({
    text: async () => ({ value: 'jane@example.com' }),
    secret: async (request) => ({ value: /code/i.test(request.title) ? CODE : PASSWORD }),
    confirm: async () => false,
    // The person solving it in the live browser view: the widget goes away.
    handoff: async (request) => {
      handedOff += 1;
      await ctx.browser.evaluate({ instanceId: request.instanceId, tabId: request.tabId, expression: "document.querySelector('.g-recaptcha').remove(); true" });
      return { done: true };
    },
  });
  const result = await loginFlow({ browser: ctx.browser, broker, vault: new SecretVault({ config: { get: () => ({}) } }), instanceId: ctx.instance.id, url: `${ctx.site.url}/login?captcha=1` });
  assert.equal(handedOff, 1);
  assert.equal(result.status, 'logged_in', JSON.stringify(result));

  // With no way to hand off, it says what is needed instead of guessing.
  const bare = new InteractionBroker({});
  bare.attach({ text: async () => ({ value: 'x' }), secret: async () => ({ value: 'y' }) });
  const stuck = await loginFlow({ browser: ctx.browser, broker: bare, vault: new SecretVault({ config: { get: () => ({}) } }), instanceId: ctx.instance.id, url: `${ctx.site.url}/login?captcha=1` });
  assert.equal(stuck.status, 'needs_user');
});

test('network traces never carry posted bodies, cookies or auth headers', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  await ctx.browser.navigate({ instanceId: ctx.instance.id, url: `${ctx.site.url}/plain` });
  await ctx.browser.evaluate({ instanceId: ctx.instance.id, expression: "fetch('/login', { method: 'POST', headers: { Authorization: 'Bearer topsecret', 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=hunter2' }).then(() => true)" });
  const { events } = await ctx.browser.network({ instanceId: ctx.instance.id, limit: 200 });
  const text = JSON.stringify(events);
  assert.ok(events.length > 0);
  assert.doesNotMatch(text, /hunter2|topsecret/);
});
