import { loginFlow, hostOf } from '../web/login.mjs';
import { renderPageModel } from '../web/page-model.mjs';

const base = { instanceId: { type: 'string' }, tabId: { type: 'string' } };
const scopeOf = (context = {}) => ({ runId: context.runId, sessionId: context.sessionId, workspaceId: context.workspaceId });

export function registerWebTaskTools(registry, { browserManager, interaction, secretVault }) {
  registry.register({
    name: 'browser_extract', title: 'Extract page options', category: 'browser', readOnly: true,
    description: 'Describe the current page as selectable options (restaurants, products, results), forms, blockers (login wall, CAPTCHA, cookie notice) and actions, each with a short ref such as e12 for browser_act. Far smaller than the raw page; prefer it to browser_snapshot for web tasks.',
    keywords: ['web', 'page', 'options', 'list', 'products', 'restaurants', 'form'],
    inputSchema: { type: 'object', properties: { ...base, maxOptions: { type: 'integer', minimum: 1, maximum: 60, default: 40 }, format: { type: 'string', enum: ['text', 'json'], default: 'text' } } },
    execute: async (args) => {
      const { model, instanceId, tabId } = await browserManager.extract({ instanceId: args.instanceId || null, tabId: args.tabId || null, maxOptions: args.maxOptions || 40 });
      return args.format === 'json' ? { instanceId, tabId, ...model } : `${renderPageModel(model)}\n\n(instanceId ${instanceId}, tabId ${tabId})`;
    },
  });

  registry.register({
    name: 'browser_act', title: 'Act on a page element', category: 'browser', risk: 'external-action',
    description: 'Click, fill, select, check or press a key on an element by its ref from browser_extract. Waits for the page to settle and returns the new URL. Refuses to click purchase-style buttons ("Place order", "Pay now") unless the person confirms; refuses to type into password fields (use browser_login).',
    keywords: ['click', 'fill', 'select', 'type', 'web'],
    inputSchema: { type: 'object', required: ['ref'], properties: { ...base, ref: { type: 'string' }, action: { type: 'string', enum: ['click', 'fill', 'select', 'check', 'press'], default: 'click' }, value: { type: 'string' }, submit: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const request = { instanceId: args.instanceId || null, tabId: args.tabId || null, ref: args.ref, action: args.action || 'click', value: args.value ?? '', submit: Boolean(args.submit) };
      try {
        return await browserManager.act(request);
      } catch (error) {
        if (error.code !== 'RISKY_ACTION') throw error;
        const ok = await interaction.confirm({ title: 'Confirm this action', message: `The agent wants to click "${error.label}". This may spend money or cannot be undone.`, danger: true, defaultYes: false, scope: scopeOf(context) });
        if (!ok) return { declined: true, label: error.label, message: 'The person declined. Do not retry; ask what they want instead.' };
        return browserManager.act({ ...request, allowRisky: true });
      }
    },
  });

  registry.register({
    name: 'browser_choose', title: 'Let the person choose from the page', category: 'browser', risk: 'external-action',
    description: 'Extract the options on the current page, show them to the person as a picker and return what they chose. With open:true the chosen option is opened. Use this when a decision is theirs: which restaurant, product, flight or result.',
    keywords: ['choose', 'pick', 'select', 'options', 'restaurant', 'menu', 'product'],
    inputSchema: { type: 'object', properties: { ...base, question: { type: 'string' }, list: { type: 'integer', minimum: 0, default: 0 }, multi: { type: 'boolean', default: false }, open: { type: 'boolean', default: true } } },
    execute: async (args, context) => {
      const { model, instanceId, tabId } = await browserManager.extract({ instanceId: args.instanceId || null, tabId: args.tabId || null });
      const list = model.lists[args.list || 0];
      if (!list) return { chosen: [], message: 'No list of options was found on this page.', page: renderPageModel(model, { maxChars: 2500 }) };
      const picked = await interaction.choose({
        title: list.name || model.title || 'Choose',
        question: args.question || 'Pick one',
        multi: Boolean(args.multi),
        options: list.options.map((option) => ({ id: option.ref, label: option.title, detail: option.detail, price: option.price, rating: option.rating, meta: { url: option.url } })),
        scope: scopeOf(context),
      });
      if (picked.cancelled) return { chosen: [], cancelled: true, message: 'The person did not choose anything.' };
      const chosen = picked.ids.map((id) => list.options.find((option) => option.ref === id)).filter(Boolean);
      let opened = null;
      if (args.open !== false && chosen.length === 1) {
        opened = await browserManager.act({ instanceId, tabId, ref: chosen[0].ref, action: 'click' });
      }
      return { chosen: chosen.map((option) => ({ ref: option.ref, title: option.title, price: option.price, rating: option.rating, url: option.url })), opened };
    },
  });

  registry.register({
    name: 'browser_login', title: 'Sign in through the terminal', category: 'browser', risk: 'external-action',
    description: 'Sign in to the site open in the browser. The person is asked for their username, password and any verification code in the terminal; the values are typed into the page directly and never shown to you. CAPTCHAs are handed to the person in the live browser view. Returns only the outcome.',
    keywords: ['login', 'sign in', 'password', 'account', 'otp', 'captcha'],
    inputSchema: { type: 'object', properties: { ...base, url: { type: 'string', description: 'Sign-in page to open first (optional).' }, remember: { type: 'boolean', default: true } } },
    execute: async (args, context) => loginFlow({
      browser: browserManager, broker: interaction, vault: secretVault,
      instanceId: args.instanceId || null, tabId: args.tabId || null, url: args.url || null, remember: args.remember !== false, scope: scopeOf(context),
    }),
  });

  registry.register({
    name: 'browser_handoff', title: 'Hand the browser to the person', category: 'browser', risk: 'external-action',
    description: 'Ask the person to do something in the live browser view that you should not (solve a CAPTCHA, approve a bank prompt, enter payment details) and wait until they say they are done.',
    keywords: ['handoff', 'captcha', 'human', 'payment'],
    inputSchema: { type: 'object', required: ['message'], properties: { ...base, message: { type: 'string' } } },
    execute: async (args, context) => {
      const done = await interaction.handoff({ title: 'Your turn', message: args.message, instanceId: args.instanceId || null, tabId: args.tabId || null, scope: scopeOf(context) });
      return done.done ? { done: true } : { done: false, message: 'The person did not complete the step.' };
    },
  });

  registry.register({
    name: 'user_choose', title: 'Ask the person to choose', category: 'interaction', readOnly: true,
    description: 'Show a short list of options and return the person\'s choice. Use it instead of guessing when a decision belongs to them.',
    keywords: ['ask', 'choose', 'pick', 'options', 'question'],
    inputSchema: { type: 'object', required: ['options'], properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, detail: { type: 'string' }, price: { type: 'string' } }, required: ['label'] } }, multi: { type: 'boolean', default: false }, allowOther: { type: 'boolean', default: false } } },
    execute: async (args, context) => {
      const picked = await interaction.choose({ title: 'Choose', question: args.question || '', options: args.options, multi: Boolean(args.multi), allowOther: Boolean(args.allowOther), scope: scopeOf(context) });
      if (picked.cancelled) return { cancelled: true };
      return { ids: picked.ids, labels: picked.ids.map((id) => picked.options.find((option) => option.id === id)?.label), other: picked.other };
    },
  });

  registry.register({
    name: 'user_ask', title: 'Ask the person a question', category: 'interaction', readOnly: true,
    description: 'Ask the person for a short piece of free text (a delivery address, a date, a preference) and return it. Never use it for passwords or codes; browser_login handles those.',
    keywords: ['ask', 'question', 'input'],
    inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, placeholder: { type: 'string' } } },
    execute: async (args, context) => {
      const answer = await interaction.text({ title: 'Question', question: args.question, placeholder: args.placeholder || '', scope: scopeOf(context) });
      return answer.cancelled ? { cancelled: true } : { answer: answer.value };
    },
  });

  registry.register({
    name: 'user_confirm', title: 'Ask the person to confirm', category: 'interaction', readOnly: true,
    description: 'Ask a yes/no question before something irreversible, such as paying or sending, and return the answer. Include the facts they need to decide (item, total, address).',
    keywords: ['confirm', 'approve', 'yes', 'no'],
    inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' }, details: { type: 'array', items: { type: 'string' } }, danger: { type: 'boolean', default: false } } },
    execute: async (args, context) => ({ confirmed: await interaction.confirm({ title: 'Confirm', message: args.message, details: args.details || [], danger: Boolean(args.danger), scope: scopeOf(context) }) }),
  });

  registry.register({
    name: 'credentials_list', title: 'List saved sign-ins', category: 'interaction', readOnly: true,
    description: 'List which sites have a sign-in remembered, and where (this session or the system keychain). Never returns passwords or usernames.',
    keywords: ['credentials', 'passwords', 'saved'],
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const sites = new Map();
      for (const entry of secretVault.list()) {
        if (!entry.service.startsWith('login:')) continue;
        sites.set(entry.service.slice(6), entry.where);
      }
      return { backend: secretVault.describe(), sites: [...sites].map(([site, where]) => ({ site, where })) };
    },
  });

  registry.register({
    name: 'credentials_forget', title: 'Forget a saved sign-in', category: 'interaction', risk: 'write',
    description: 'Remove the remembered sign-in for a site (from memory and the keychain).',
    keywords: ['credentials', 'forget', 'delete'],
    inputSchema: { type: 'object', required: ['site'], properties: { site: { type: 'string', description: 'Host name such as example.com, or a URL.' } } },
    execute: async (args) => {
      const host = args.site.includes('/') ? hostOf(args.site) : args.site.replace(/^www\./, '');
      await secretVault.delete(`login:${host}`, 'username');
      await secretVault.delete(`login:${host}`, 'password');
      return { forgotten: host };
    },
  });
}
