// Turning a live web page into something a person or a small model can choose from.
//
// A page's HTML is hundreds of thousands of tokens of markup nobody asked for. What a task needs
// is: what can I pick here (restaurants, products, flights), what can I fill in, what is in the
// way (a login wall, a CAPTCHA, a cookie banner, an open dialog), and what else can I click.
// `pageModelInPage` runs inside the page, finds those, and gives every element worth touching a
// short reference (`e12`) that `browser_act` can use later — so the model names a thing instead of
// reproducing a CSS selector, and a small model's whole job becomes "pick a number".
//
// It is deliberately heuristic and self-contained (no libraries, no site-specific knowledge):
// repeated sibling blocks that are clickable and carry text are "options"; inputs are grouped into
// forms; known challenge widgets are "blockers". It copes with open shadow roots, ignores hidden
// elements, and when a modal dialog is open it describes only the dialog, since the page behind it
// cannot be used until it is dismissed.

/* eslint-disable no-undef */
export function pageModelInPage(opts) {
  const MAX_OPTIONS = opts.maxOptions || 40;
  const MAX_ACTIONS = opts.maxActions || 80;
  const TEXT_CHARS = opts.textChars || 1800;
  const MAX_ELEMENTS = 20000;

  document.querySelectorAll('[data-ms-ref]').forEach((el) => el.removeAttribute('data-ms-ref'));
  const refs = (window.__msRefs = new Map());
  let counter = 0;
  const refOf = (el) => {
    let ref = el.getAttribute('data-ms-ref');
    if (!ref) {
      counter += 1;
      ref = `e${counter}`;
      el.setAttribute('data-ms-ref', ref);
      refs.set(ref, el);
    }
    return ref;
  };

  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const clip = (value, max) => { const text = clean(value); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // One walk over the whole tree, open shadow roots included.
  const all = [];
  const walk = (root) => {
    for (const el of root.children) {
      if (all.length >= MAX_ELEMENTS) return;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG' || tag === 'svg') continue;
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
    }
  };
  walk(document.documentElement);

  const labelledBy = (el) => {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)?.textContent || '').join(' ');
  };
  const labelOf = (el) => {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    let text = el.getAttribute('aria-label') || labelledBy(el);
    if (!clean(text) && (tag === 'INPUT') && ['submit', 'button', 'reset'].includes(type)) text = el.value;
    if (!clean(text) && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') text = el.innerText || el.textContent;
    if (!clean(text)) text = el.getAttribute('title') || el.querySelector?.('img[alt]')?.getAttribute('alt') || '';
    if (!clean(text)) text = el.getAttribute('placeholder') || el.getAttribute('name') || '';
    return clip(text, 90);
  };
  const regionOf = (el) => {
    if (el.closest('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')) return 'dialog';
    if (el.closest('nav,[role=navigation]')) return 'nav';
    if (el.closest('footer,[role=contentinfo]')) return 'footer';
    if (el.closest('header,[role=banner]')) return 'header';
    if (el.closest('aside,[role=complementary]')) return 'aside';
    return 'main';
  };

  // ---------------------------------------------------------------- modal
  const dialogs = all.filter((el) => el.matches('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]') && visible(el)
    && el.getBoundingClientRect().width > 160 && el.getBoundingClientRect().height > 80);
  const modal = dialogs.length ? dialogs[dialogs.length - 1] : null;
  const inScope = (el) => (modal ? modal.contains(el) : true);
  const scoped = modal ? all.filter((el) => modal.contains(el)) : all;

  // ----------------------------------------------------------- blockers
  const blockers = [];
  const bodyText = clean(document.body ? document.body.innerText : '');
  const consentHost = scoped.find((el) => /cookie|consent|gdpr|onetrust|truste|cmp|privacy-banner|cc-window/i.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`) && visible(el)
    && el.getBoundingClientRect().height > 16 && el.querySelector('button,[role=button],a[role=button]'));
  if (consentHost) {
    const accept = [...consentHost.querySelectorAll('button,[role=button],a[role=button]')].filter(visible)
      .find((el) => /^(accept|agree|allow|got it|ok|okay|i understand|i agree|accept all|allow all)\b/i.test(labelOf(el)));
    if (accept) blockers.push({ kind: 'consent', label: labelOf(accept), ref: refOf(accept) });
  }
  const challengeFrame = all.find((el) => el.tagName === 'IFRAME' && /recaptcha|hcaptcha|turnstile|captcha|arkoselabs|funcaptcha|geetest/i.test(el.src || '') && visible(el));
  const challengeBox = all.find((el) => /g-recaptcha|h-captcha|cf-turnstile|captcha/i.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`) && visible(el));
  if (challengeFrame || challengeBox) blockers.push({ kind: 'captcha', label: 'A human-verification widget is on the page' });
  if (/just a moment|attention required|access denied|robot check|are you a human|verify you are human/i.test(document.title)
    || /verify (that )?you(?:'|’)?re (a )?human|i(?:'|’)?m not a robot|are you a robot|checking your browser|unusual traffic|press (and|&) hold|complete the security check/i.test(bodyText.slice(0, 4000))) {
    if (!blockers.some((b) => b.kind === 'captcha')) blockers.push({ kind: 'challenge', label: clip(document.title || 'The site is checking whether you are a person', 90) });
  }

  // -------------------------------------------------------------- forms
  const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]),select,textarea,[role=textbox],[role=combobox],[role=searchbox],[role=switch]';
  const isField = (el) => el.matches(FIELD);
  const fieldTarget = (el) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !visible(el)) {
      const label = el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      return label && visible(label) ? label : null;
    }
    return visible(el) ? el : null;
  };
  const fieldLabel = (el) => {
    let text = el.getAttribute('aria-label') || labelledBy(el);
    if (!clean(text) && el.id) text = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || '';
    if (!clean(text)) {
      const wrap = el.closest('label');
      if (wrap) { const copy = wrap.cloneNode(true); copy.querySelectorAll('input,select,textarea').forEach((n) => n.remove()); text = copy.textContent; }
    }
    if (!clean(text)) text = el.getAttribute('placeholder') || '';
    if (!clean(text)) { const prev = el.previousElementSibling; if (prev && clean(prev.textContent).length <= 40) text = prev.textContent; }
    if (!clean(text)) text = el.getAttribute('name') || el.getAttribute('type') || 'field';
    return clip(text, 70);
  };
  const describeField = (el) => {
    const target = fieldTarget(el);
    if (!target) return null;
    const type = (el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.getAttribute('role') === 'combobox' ? 'combobox' : 'text')).toLowerCase();
    const out = {
      ref: refOf(target), label: fieldLabel(el), type, name: el.getAttribute('name') || '',
      autocomplete: el.getAttribute('autocomplete') || '', required: el.required || el.getAttribute('aria-required') === 'true',
      disabled: Boolean(el.disabled), invalid: el.getAttribute('aria-invalid') === 'true',
    };
    if (type === 'password') out.filled = Boolean(el.value);
    else if (type === 'checkbox' || type === 'radio') out.checked = Boolean(el.checked);
    else if ('value' in el) out.value = clip(el.value, 80);
    if (el.tagName === 'SELECT') out.options = [...el.options].slice(0, 30).map((o) => ({ value: o.value, label: clip(o.textContent, 60), selected: o.selected }));
    if (type === 'radio' && el.name) out.group = el.name;
    return out;
  };

  const fieldEls = scoped.filter((el) => isField(el) && (el.tagName !== 'INPUT' || (el.getAttribute('type') || 'text') !== 'hidden'));
  const groups = new Map();
  for (const el of fieldEls) {
    const form = el.closest('form') || (modal || document.body);
    if (!groups.has(form)) groups.set(form, []);
    groups.get(form).push(el);
  }
  const forms = [];
  for (const [container, members] of groups) {
    const fields = members.map(describeField).filter(Boolean);
    if (!fields.length) continue;
    const text = `${fields.map((f) => `${f.label} ${f.autocomplete} ${f.name}`).join(' ')}`;
    let kind = 'form';
    if (fields.some((f) => f.type === 'password')) kind = fields.filter((f) => f.type === 'password').length > 1 ? 'signup' : 'login';
    else if (fields.some((f) => /one-time-code/i.test(f.autocomplete)) || /verification code|one.?time|\botp\b|security code|6.?digit|enter the code|passcode/i.test(text)) kind = 'code';
    else if (fields.length <= 2 && fields.some((f) => f.type === 'search' || /search|query|find/i.test(`${f.label} ${f.name}`))) kind = 'search';
    const buttons = [...container.querySelectorAll('button,input[type=submit],[role=button]')].filter(visible);
    const submit = buttons.find((b) => (b.getAttribute('type') || '').toLowerCase() === 'submit')
      || buttons.find((b) => /^(sign|log|continue|next|submit|search|save|add|apply|send|verify|confirm|place|pay|done|go)\b/i.test(labelOf(b)))
      || buttons[buttons.length - 1];
    forms.push({ kind, fields: fields.slice(0, 30), submit: submit ? { ref: refOf(submit), label: labelOf(submit), disabled: Boolean(submit.disabled) } : null });
  }

  // ------------------------------------------------------------ options
  const PRICE = /(?:US)?[$€£¥₹]\s?\d{1,3}(?:[,\d]{0,9})(?:\.\d{1,2})?|\d+(?:\.\d{2})?\s?(?:USD|EUR|GBP)\b/;
  const RATING = /(?<![\d.])([0-5](?:\.\d)?)\s*(?:★|⭐|stars?\b|\/\s*5)/i;
  const signature = (el) => {
    const classes = typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => c && !/\d{3,}/.test(c)).slice(0, 4).join('.') : '';
    const tid = (el.getAttribute('data-testid') || el.getAttribute('data-anchor-id') || '').replace(/\d+/g, '');
    return `${el.tagName}.${classes}|${el.getAttribute('role') || ''}|${tid}`;
  };
  const clickable = (el) => el.matches('a[href],button,[role=button],[role=link]') || el.querySelector('a[href],button,[role=button],[role=link]') || el.hasAttribute('onclick');
  const regionPenalty = (el) => ({ nav: 0.1, footer: 0.1, header: 0.2, aside: 0.5 }[regionOf(el)] ?? 1);

  const candidates = [];
  const parents = new Set();
  for (const el of scoped) if (el.children.length >= 3) parents.add(el);
  for (const parent of parents) {
    const bySignature = new Map();
    for (const child of parent.children) {
      if (!bySignature.has(signature(child))) bySignature.set(signature(child), []);
      bySignature.get(signature(child)).push(child);
    }
    for (const members of bySignature.values()) {
      if (members.length < 3) continue;
      const usable = members.filter((child) => {
        if (!visible(child)) return false;
        const r = child.getBoundingClientRect();
        const length = clean(child.innerText).length;
        return r.width >= 80 && r.height >= 28 && length >= 6 && length <= 800;
      });
      if (usable.length < 3) continue;
      const linked = usable.filter(clickable).length / usable.length;
      if (linked < 0.6) continue;
      const average = usable.reduce((sum, child) => sum + clean(child.innerText).length, 0) / usable.length;
      const priced = usable.filter((child) => PRICE.test(child.innerText)).length / usable.length;
      const score = usable.length * Math.sqrt(average) * (priced > 0.5 ? 1.6 : 1) * linked * regionPenalty(parent);
      candidates.push({ parent, members: usable, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen = [];
  const claimed = [];
  for (const candidate of candidates) {
    if (chosen.length >= 3) break;
    // A list nested inside an already chosen item (the price tags inside a card) is not a list of its own.
    if (claimed.some((item) => item.contains(candidate.parent) || candidate.members.some((member) => item.contains(member)) || candidate.members.some((member) => member.contains(item)))) continue;
    chosen.push(candidate);
    claimed.push(...candidate.members);
  }
  const headingFor = (parent) => {
    const section = parent.closest('section,[role=region],article,div[class*=section i]');
    const heading = (section || parent.parentElement || parent).querySelector('h1,h2,h3,h4,[role=heading]');
    let before = parent.previousElementSibling;
    for (let step = 0; before && step < 3; step += 1, before = before.previousElementSibling) {
      if (/^H[1-6]$/.test(before.tagName) || before.getAttribute('role') === 'heading') return clip(before.textContent, 60);
    }
    return heading ? clip(heading.textContent, 60) : '';
  };
  const describeOption = (child) => {
    const lines = (child.innerText || '').split('\n').map(clean).filter(Boolean);
    const titleEl = [...child.querySelectorAll('h1,h2,h3,h4,h5,[role=heading],strong,b,[class*=title i],[class*=name i]')].find((el) => visible(el) && clean(el.textContent));
    let title = titleEl ? clip(titleEl.textContent, 100) : '';
    if (!title) title = clip(lines.find((line) => !PRICE.test(line) && !RATING.test(line) && line.length > 2) || lines[0] || child.querySelector('img[alt]')?.getAttribute('alt') || '', 100);
    if (!title) return null;
    const text = lines.join(' · ');
    const priceMatch = text.match(PRICE);
    const ariaRating = [...child.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')).find((value) => /rat(ed|ing)/i.test(value || ''));
    const ratingMatch = text.match(RATING) || (ariaRating ? ariaRating.match(/([0-5](?:\.\d)?)/) : null);
    const facts = lines.filter((line) => line !== title && line.length <= 48 && !line.startsWith(title)).slice(0, 6);
    const link = child.matches('a[href]') ? child : child.querySelector('a[href]');
    const primary = child.matches('a[href],button,[role=button],[role=link]') ? child : (link || child.querySelector('button,[role=button]') || child);
    const buttons = [...child.querySelectorAll('button,[role=button],a[role=button]')].filter((el) => el !== primary && visible(el)).slice(0, 3)
      .map((el) => ({ ref: refOf(el), label: labelOf(el) })).filter((b) => b.label);
    return {
      ref: refOf(primary), title,
      detail: clip(lines.filter((line) => line !== title).join(' · '), 220),
      price: priceMatch ? priceMatch[0].replace(/\s+/g, '') : '',
      rating: ratingMatch ? ratingMatch[1] : '',
      url: link ? link.href : '', facts, buttons,
    };
  };
  const lists = chosen.map((candidate) => ({
    name: headingFor(candidate.parent),
    total: candidate.members.length,
    options: candidate.members.slice(0, MAX_OPTIONS).map(describeOption).filter(Boolean),
  })).filter((list) => list.options.length);

  // ------------------------------------------------------------ actions
  const taken = new Set(claimed.flatMap((member) => [member, ...member.querySelectorAll('*')]));
  const fieldSet = new Set(fieldEls);
  const submitRefs = new Set(forms.map((form) => form.submit && form.submit.ref).filter(Boolean));
  const ACTION = 'a[href],button,input[type=submit],input[type=button],summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio]';
  const seen = new Set();
  const perRegion = { nav: 0, footer: 0 };
  const actions = [];
  for (const el of scoped) {
    if (actions.length >= MAX_ACTIONS) break;
    if (!el.matches(ACTION) || taken.has(el) || fieldSet.has(el) || !visible(el)) continue;
    const label = labelOf(el);
    if (!label) continue;
    const region = regionOf(el);
    if (region === 'nav' && perRegion.nav >= 14) continue;
    if (region === 'footer' && perRegion.footer >= 6) continue;
    const href = el.tagName === 'A' ? el.href : '';
    const key = `${label}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (region in perRegion) perRegion[region] += 1;
    const role = el.getAttribute('role');
    const r = el.getBoundingClientRect();
    actions.push({
      ref: refOf(el), label, kind: el.tagName === 'A' || role === 'link' ? 'link' : role === 'tab' ? 'tab' : 'button', region,
      ...(href ? { href: href.length > 120 ? `${href.slice(0, 120)}…` : href } : {}),
      ...(el.disabled || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
      ...(submitRefs.has(el.getAttribute('data-ms-ref')) ? { submit: true } : {}),
      inViewport: r.bottom > 0 && r.top < window.innerHeight,
    });
  }

  const alerts = scoped.filter((el) => el.matches('[role=alert],[aria-live=assertive],[class*=error i],[class*=alert i]') && visible(el))
    .map((el) => clip(el.textContent, 160)).filter((text) => text && text.length > 3);

  return {
    url: location.href,
    title: clip(document.title, 140),
    modal: modal ? { label: clip(modal.getAttribute('aria-label') || labelledBy(modal) || modal.querySelector('h1,h2,h3,[role=heading]')?.textContent || 'Dialog', 80) } : null,
    blockers,
    alerts: [...new Set(alerts)].slice(0, 5),
    lists,
    forms,
    actions,
    text: clip(bodyText, TEXT_CHARS),
    scroll: { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: Math.round(window.innerHeight) },
  };
}
/* eslint-enable no-undef */

export function pageModelExpression(options = {}) {
  return `(${pageModelInPage.toString()})(${JSON.stringify(options)})`;
}

const short = (text, max) => (String(text).length > max ? `${String(text).slice(0, max - 1)}…` : String(text));

/** The page model as compact text a model can read: every element worth touching has a [ref]. */
export function renderPageModel(model, { maxChars = 6000, includeText = true } = {}) {
  const lines = [`Page: ${short(model.title || '(untitled)', 100)} — ${short(model.url, 140)}`];
  if (model.modal) lines.push(`A dialog is open ("${model.modal.label}"). Only the dialog is listed; dismiss it to use the rest of the page.`);
  for (const blocker of model.blockers || []) {
    lines.push(`BLOCKER ${blocker.kind}: ${blocker.label}${blocker.ref ? ` [${blocker.ref}]` : ''}`);
  }
  for (const alert of model.alerts || []) lines.push(`Alert: ${alert}`);

  for (const [index, list] of (model.lists || []).entries()) {
    lines.push('', `Options${list.name ? ` — ${list.name}` : ''} (list ${index}, ${list.options.length}${list.total > list.options.length ? ` of ${list.total}` : ''}):`);
    for (const option of list.options) {
      const bits = [option.price, option.rating ? `${option.rating}★` : '', ...option.facts.filter((fact) => fact !== option.price && !fact.startsWith(option.rating || '\u0000')).slice(0, 3)].filter(Boolean);
      const extra = option.buttons?.length ? `  {${option.buttons.map((button) => `${button.label} [${button.ref}]`).join(', ')}}` : '';
      lines.push(`  [${option.ref}] ${short(option.title, 80)}${bits.length ? ` — ${short(bits.join(' · '), 90)}` : ''}${extra}`);
    }
  }
  for (const form of model.forms || []) {
    lines.push('', `Form (${form.kind}):`);
    for (const field of form.fields) {
      const state = field.type === 'checkbox' || field.type === 'radio' ? (field.checked ? ' ✓' : ' ○')
        : field.type === 'password' ? (field.filled ? ' (filled)' : '')
          : field.value ? ` = "${short(field.value, 40)}"` : '';
      const options = field.options ? ` {${field.options.slice(0, 8).map((o) => o.label).join(' | ')}${field.options.length > 8 ? ' …' : ''}}` : '';
      lines.push(`  [${field.ref}] ${field.label} (${field.type}${field.required ? ', required' : ''}${field.autocomplete ? `, ${field.autocomplete}` : ''})${state}${options}${field.invalid ? ' — invalid' : ''}`);
    }
    if (form.submit) lines.push(`  submit: "${form.submit.label}" [${form.submit.ref}]${form.submit.disabled ? ' (disabled)' : ''}`);
  }
  if (model.actions?.length) {
    lines.push('', 'Actions:');
    const groups = {};
    for (const action of model.actions) (groups[action.region] ||= []).push(action);
    for (const [region, items] of Object.entries(groups)) {
      lines.push(`  ${region}: ${items.map((item) => `${short(item.label, 40)} [${item.ref}]${item.disabled ? ' (disabled)' : ''}`).join(' · ')}`);
    }
  }
  if (model.scroll && model.scroll.y + model.scroll.viewport < model.scroll.height - 40) lines.push('', 'More of this page is below; scroll to see it.');
  if (includeText && !(model.lists || []).length && model.text) lines.push('', `Text: ${short(model.text, 900)}`);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (trimmed)` : text;
}

export function primaryList(model, index = 0) {
  return (model.lists || [])[index] || null;
}

export function findForm(model, kind) {
  return (model.forms || []).find((form) => form.kind === kind) || null;
}

export function findField(form, predicate) {
  return (form?.fields || []).find(predicate) || null;
}
