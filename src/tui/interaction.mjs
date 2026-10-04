// The full-screen interface's answer to InteractionBroker. Questions appear inside the chat, above
// the composer (see prompt.mjs), rather than in a dialog or on another screen. They are queued so
// only one is showing at a time, and declining always resolves the request as cancelled instead of
// leaving the run waiting.
import { InlinePrompt } from './prompt.mjs';

export function createInteractionHandler(app) {
  let queue = Promise.resolve();

  const ask = (build) => {
    const run = () => new Promise((resolve) => {
      app.showPrompt(build((answer) => resolve(answer)));
    });
    queue = queue.then(run, run);
    return queue;
  };

  return {
    async choose(request) {
      const answer = await ask((done) => new InlinePrompt({
        kind: 'choose',
        title: request.title || 'Choose',
        question: request.question || 'Pick one',
        options: request.options,
        multi: request.multi,
        allowOther: request.allowOther,
        otherLabel: request.otherLabel,
        defaultId: request.defaultId,
        onAnswer: done,
      }));
      if (!answer || (!answer.ids?.length && !answer.other)) return { cancelled: true };
      return { ids: answer.ids || [], other: answer.other || null };
    },

    async text(request) {
      const answer = await ask((done) => new InlinePrompt({
        kind: 'text', title: request.title || 'Question', question: request.question || '', placeholder: request.placeholder || 'Type your answer', onAnswer: done,
      }));
      return answer ? { value: answer.value } : { cancelled: true };
    },

    async secret(request) {
      const answer = await ask((done) => new InlinePrompt({
        kind: 'secret',
        title: request.title || 'Secret',
        question: `${request.question || 'Enter the value'} Typed here and sent straight to the page; it is not shown to the model or logged.`,
        placeholder: 'Hidden as you type',
        onAnswer: done,
      }));
      return answer ? { value: answer.value } : { cancelled: true };
    },

    async confirm(request) {
      const answer = await ask((done) => new InlinePrompt({
        kind: 'confirm',
        title: request.title || 'Confirm',
        question: request.message,
        preview: (request.details || []).map((line) => String(line)),
        danger: Boolean(request.danger),
        options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
        onAnswer: done,
      }));
      return Boolean(answer?.yes);
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
