// The full-screen interface's answer to InteractionBroker: pickers, masked prompts, confirmations
// and the browser hand-off. Requests are queued so only one dialog is on screen at a time, and
// pressing escape always resolves the request as cancelled instead of leaving the run waiting.
import { ConfirmOverlay, FormOverlay, PickerOverlay } from './overlays.mjs';

const OTHER = '__other__';
const DONE = '__done__';

function describe(option) {
  return [option.price, option.rating ? `${option.rating}★` : '', option.detail].filter(Boolean).join('  ·  ');
}

export function createInteractionHandler(app) {
  let queue = Promise.resolve();

  // `build(finish)` returns the overlay; `cancelValue` is what escape means.
  const ask = (build, cancelValue) => {
    const run = () => new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      const originalClose = app.closeOverlay.bind(app);
      app.closeOverlay = () => {
        app.closeOverlay = originalClose;
        originalClose();
        // Overlays close themselves just before delivering their answer; let that answer win.
        setImmediate(() => finish(cancelValue));
      };
      app.overlay = build(finish);
      app.requestRender();
    });
    queue = queue.then(run, run);
    return queue;
  };

  const form = (title, field, note = '') => ask((finish) => new FormOverlay({
    title, fields: [field], submitLabel: 'OK', note,
    onSubmit: (values) => { finish({ value: values[field.name] }); },
  }), { cancelled: true });

  const pickOne = (request, items) => ask((finish) => new PickerOverlay({
    title: request.title || 'Choose',
    placeholder: request.question || 'Filter…',
    items,
    footer: request.question || '',
    preview: (_app, item) => (item.full ? [item.full] : []),
    previewRows: 2,
    selectedId: request.defaultId,
    onSelect: (item) => finish({ id: item.id }),
  }), { cancelled: true });

  return {
    async choose(request) {
      const base = request.options.map((option) => ({ id: option.id, label: option.label, detail: describe(option), full: option.detail }));
      const withOther = (items) => (request.allowOther ? [...items, { id: OTHER, label: request.otherLabel, detail: '' }] : items);
      if (!request.multi) {
        const answer = await pickOne(request, withOther(base));
        if (answer.cancelled) return { cancelled: true };
        if (answer.id === OTHER) {
          const typed = await form(request.title || 'Choose', { name: 'value', label: request.question || 'Your answer', type: 'text', value: '' });
          return typed.cancelled || !typed.value?.trim() ? { cancelled: true } : { ids: [], other: typed.value };
        }
        return { ids: [answer.id] };
      }
      const chosen = [];
      for (;;) {
        const remaining = base.filter((item) => !chosen.includes(item.id));
        const items = [
          ...(chosen.length ? [{ id: DONE, label: `Done — ${chosen.length} chosen`, detail: '' }] : []),
          ...remaining.map((item) => ({ ...item, label: item.label })),
        ];
        if (!remaining.length) break;
        const answer = await pickOne({ ...request, question: `${request.question || 'Pick'} (choose more, then Done)` }, items);
        if (answer.cancelled) return chosen.length ? { ids: chosen } : { cancelled: true };
        if (answer.id === DONE) break;
        chosen.push(answer.id);
      }
      return { ids: chosen };
    },

    text(request) {
      return form(request.title || 'Question', { name: 'value', label: request.question || 'Answer', type: 'text', value: request.defaultValue || '', hint: request.placeholder || '' });
    },

    secret(request) {
      return form(request.title || 'Secret', { name: 'value', label: request.question || 'Value', type: 'text', mask: true, value: '' },
        'Typed here, sent straight to the page. It is not shown to the model or written to any log.');
    },

    confirm(request) {
      return ask((finish) => new ConfirmOverlay({
        title: request.title || 'Confirm',
        message: request.message,
        details: request.details || [],
        danger: Boolean(request.danger),
        onConfirm: () => { finish(true); },
      }), false);
    },

    async handoff(request) {
      let instanceId = request.instanceId;
      if (!instanceId) instanceId = app.runtime.browserManager.list()[0]?.id;
      if (!instanceId) return { done: false };
      const run = () => new Promise((resolve) => {
        app.handoff = {
          message: request.message,
          finish: (done) => { app.handoff = null; app.requestRender(); resolve({ done }); },
        };
        app.toast('The agent needs you in the browser view', 'warn');
        void app.openBrowserView(instanceId, request.tabId || null);
      });
      queue = queue.then(run, run);
      return queue;
    },
  };
}
