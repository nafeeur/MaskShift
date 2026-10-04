// Signing in to a website from the terminal.
//
// The model decides *that* a login is needed; this module does it. The person is asked for the
// username, password and any one-time code through the interaction broker (a masked prompt in the
// interface), and the values are typed into the page here, in code. They never become tool
// arguments, tool results or log lines, so they never reach the model. A CAPTCHA or "verify you are
// human" wall is handed to the person in the live browser view instead of being attempted.
import { findField, findForm } from './page-model.mjs';

const BAD_LOGIN = /incorrect|invalid|wrong|doesn.t match|did not match|not recognized|couldn.t find|try again|failed|unable to (sign|log)|no account/i;
const LOGIN_LINK = /^(sign ?in|log ?in|login|account)\b/i;
const USERNAME_FIELD = (field) => !['password', 'checkbox', 'radio', 'hidden', 'select', 'search'].includes(field.type)
  && !/one-time-code/i.test(field.autocomplete || '') && !field.disabled;

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown-site'; }
}

/** `jane.doe@example.com` -> `j***@example.com`. Enough for the person to recognise, not to reuse. */
export function maskUsername(value) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at > 0) return `${text[0]}***${text.slice(at)}`;
  return text.length > 2 ? `${text[0]}***${text.slice(-1)}` : '***';
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loginFlow({ browser, broker, vault, instanceId = null, tabId = null, url = null, remember = true, maxSteps = 6, scope = null }) {
  const base = { instanceId, tabId };
  if (url) {
    const nav = await browser.navigate({ ...base, url });
    base.instanceId = nav.instanceId;
    base.tabId = nav.tabId;
  }
  const steps = [];
  let username = null;
  let password = null;
  let enteredPassword = false;
  let attempts = 0;
  let host = 'unknown-site';
  const saved = { username: null, password: null };

  const fill = (ref, value, allowPassword = false) => browser.act({ ...base, ref, action: 'fill', value, allowPassword, settle: false });
  const result = (status, message, extra = {}) => ({
    status, host, username: username ? maskUsername(username) : null, steps, message, ...extra,
  });

  for (let step = 0; step < maxSteps; step += 1) {
    const { model } = await browser.extract({ ...base });
    host = hostOf(model.url);
    if (step === 0) {
      saved.username = await vault.get(`login:${host}`, 'username');
      saved.password = await vault.get(`login:${host}`, 'password');
    }

    const wall = model.blockers.find((blocker) => blocker.kind === 'captcha' || blocker.kind === 'challenge');
    if (wall) {
      if (!broker.supports('handoff')) {
        return result('needs_user', `${host} is asking for human verification (${wall.label}). Open the browser view to complete it, then run the login again.`);
      }
      steps.push('human verification handed to the person');
      const done = await broker.handoff({
        title: 'Verification needed',
        message: `${host} wants to confirm you are a person. Complete it in the browser, then choose Done.`,
        instanceId: base.instanceId, tabId: base.tabId, scope,
      });
      if (!done.done) return result('cancelled', 'The person did not complete the verification.');
      await wait(400);
      continue;
    }
    const consent = model.blockers.find((blocker) => blocker.kind === 'consent' && blocker.ref);
    if (consent) {
      await browser.act({ ...base, ref: consent.ref, action: 'click' }).catch(() => {});
      steps.push('dismissed cookie notice');
      continue;
    }

    const codeForm = findForm(model, 'code');
    const loginForm = findForm(model, 'login')
      || (model.forms || []).find((form) => form.fields.some(USERNAME_FIELD) && /sign|log|continue|next/i.test(form.submit?.label || '') && form.kind !== 'search' && form.kind !== 'signup');

    if (!codeForm && !loginForm) {
      if (step === 0 || steps.length === 0) {
        // Not on a login page. Look for the way in.
        const link = model.actions.find((action) => LOGIN_LINK.test(action.label) && !action.disabled);
        if (link) {
          await browser.act({ ...base, ref: link.ref, action: 'click' });
          steps.push(`opened "${link.label}"`);
          continue;
        }
        return result('logged_in', `No sign-in form on ${host}; the browser session already looks signed in.`, { signedInAlready: true });
      }
      break;
    }

    if (attempts === 0 && model.alerts.some((alert) => BAD_LOGIN.test(alert)) && steps.length) {
      // A rejection from the previous submit.
      if (saved.password) await vault.delete(`login:${host}`, 'password');
      saved.password = null;
      password = null;
      attempts += 1;
    }

    if (codeForm) {
      const field = findField(codeForm, (candidate) => !candidate.disabled) || codeForm.fields[0];
      const answer = await broker.secret({ title: `Verification code — ${host}`, question: `Enter the code ${host} sent you (text, email or authenticator app).`, scope });
      if (answer.cancelled) return result('cancelled', 'No verification code was entered.');
      await fill(field.ref, answer.value);
      steps.push('entered a verification code');
      if (codeForm.submit && !codeForm.submit.disabled) await browser.act({ ...base, ref: codeForm.submit.ref, action: 'click', settle: false });
      else await browser.act({ ...base, ref: field.ref, action: 'press', value: 'Enter', settle: false });
      await browser.settle({ ...base });
      continue;
    }

    // A username and/or password form (login can be split over two pages).
    const userField = findField(loginForm, (field) => USERNAME_FIELD(field) && !field.value);
    const passField = findField(loginForm, (field) => field.type === 'password');
    if (userField) {
      if (!username) username = saved.username;
      if (!username) {
        const answer = await broker.text({ title: `Sign in — ${host}`, question: `Username or email for ${host}`, scope });
        if (answer.cancelled || !answer.value.trim()) return result('cancelled', 'No username was entered.');
        username = answer.value.trim();
      }
      await fill(userField.ref, username);
      steps.push('entered the username');
    }
    if (passField) {
      if (!password) password = saved.password;
      if (!password) {
        if (attempts > 1) return result('failed', `${host} rejected the password. Check it and try again.`);
        const answer = await broker.secret({ title: `Password — ${host}`, question: `Password for ${maskUsername(username || host)} on ${host}${attempts ? ' (the last one was rejected)' : ''}`, scope });
        if (answer.cancelled || !answer.value) return result('cancelled', 'No password was entered.');
        password = answer.value;
        enteredPassword = true;
      }
      await fill(passField.ref, password, true);
      steps.push('entered the password');
    }
    if (loginForm.submit && !loginForm.submit.disabled) await browser.act({ ...base, ref: loginForm.submit.ref, action: 'click', settle: false, allowRisky: false });
    else if (passField || userField) await browser.act({ ...base, ref: (passField || userField).ref, action: 'press', value: 'Enter', settle: false });
    steps.push('submitted');
    await browser.settle({ ...base, timeoutMs: 8000 });
    // Re-read: success, a rejection, a code prompt or the next step all show up on the next pass.
    const after = (await browser.extract({ ...base, settle: false })).model;
    const stillLogin = findForm(after, 'login');
    const rejected = after.alerts.some((alert) => BAD_LOGIN.test(alert));
    if (rejected && stillLogin) {
      if (saved.password) await vault.delete(`login:${host}`, 'password');
      saved.password = null;
      password = null;
      attempts += 1;
      if (attempts >= 2) return result('failed', `${host} rejected the sign-in: ${after.alerts[0]}`);
      steps.push('sign-in rejected; asking again');
    }
  }

  const final = (await browser.extract({ ...base, settle: false })).model;
  const stillAsking = findForm(final, 'login') || findForm(final, 'code');
  if (stillAsking) return result('needs_user', `${host} still shows a sign-in step I could not complete (${final.alerts[0] || 'unknown'}). Use the browser view to finish it.`);

  if (enteredPassword && remember && broker.supports('confirm') && username && password) {
    const keychain = vault.preferred() === 'keychain';
    const keep = await broker.confirm({
      title: 'Remember this sign-in?',
      message: keychain
        ? `Store the password for ${maskUsername(username)} on ${host} in your operating system's keychain?`
        : `Keep the password for ${maskUsername(username)} on ${host} in memory until MaskShift exits?`,
      defaultYes: false, scope,
    });
    if (keep) {
      await vault.set(`login:${host}`, 'username', username, { persist: keychain });
      await vault.set(`login:${host}`, 'password', password, { persist: keychain });
      steps.push(keychain ? 'saved to keychain' : 'saved for this session');
    }
  }
  return result('logged_in', `Signed in to ${host}${username ? ` as ${maskUsername(username)}` : ''}. The session is kept in the browser profile.`);
}
