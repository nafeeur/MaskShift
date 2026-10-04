// `maskshift --plain`: the whole agent, one line per event, no full-screen drawing.
//
// The TUI repaints a grid of box-drawing characters dozens of times a second, which a screen
// reader announces as noise and a log file records as escape soup. This mode prints each event
// once, in order, as ordinary lines — the same stream `maskshift run` produces — and reads the
// next request from an ordinary prompt, so it works with screen readers, over flaky links, and
// under `script`/`tee`.

import readline from 'node:readline';
import { approvalPreview } from '../tui/approval.mjs';
import { oneLine } from './ui.mjs';

/** Prints a run's events as they happen. Returns the unsubscribe function. */
export function streamRunEvents(runtime, ui, sessionId, { onDelta = null } = {}) {
  // Without Unicode the marks degrade to letters ("y" for a check), which read as words; say
  // what they mean instead.
  const words = !ui.theme.unicode;
  const callMark = words ? 'call' : ui.marks.caret;
  const okMark = words ? 'ok' : ui.marks.check;
  const failMark = words ? 'error' : ui.marks.cross;
  return runtime.eventBus.subscribe((event) => {
    if (event.sessionId !== sessionId) return;
    const payload = event.payload || {};
    switch (event.type) {
      case 'run.started':
        ui.line(ui.theme.paint(`${ui.marks.diamond} run ${event.runId} on ${payload.model}`, { fg: ui.theme.roles.primary, bold: true }));
        break;
      case 'run.model-turn':
        ui.line(ui.theme.paint(`${ui.marks.dot} turn ${String(payload.step).padStart(2, '0')} — ${payload.tools?.length ?? 0} tools active`, { fg: ui.theme.roles.border }));
        break;
      case 'run.assistant-delta':
        onDelta?.(payload.content || '');
        break;
      case 'run.assistant':
        if (payload.content?.trim()) { ui.line(); ui.markdown(payload.content); }
        for (const call of payload.toolCalls || []) {
          ui.line(ui.theme.paint(`  ${callMark} ${call.name}`, { fg: ui.theme.roles.tool })
            + ui.theme.paint(` ${oneLine(JSON.stringify(call.args ?? {}), ui.width - call.name.length - 8)}`, { fg: ui.theme.roles.border }));
        }
        break;
      case 'run.tool-result':
        ui.line(ui.theme.paint(`  ${okMark} ${payload.tool}`, { fg: ui.theme.roles.success })
          + ui.theme.paint(` ${oneLine(payload.content, ui.width - String(payload.tool).length - 8)}`, { fg: ui.theme.roles.muted }));
        break;
      case 'run.tool-error':
        ui.line(ui.theme.paint(`  ${failMark} ${payload.tool}`, { fg: ui.theme.roles.danger })
          + ui.theme.paint(` ${oneLine(payload.content, ui.width - String(payload.tool).length - 8)}`, { fg: ui.theme.roles.muted }));
        break;
      case 'run.checkpoint':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} checkpoint ${payload.ref || payload.kind || ''}`, { fg: ui.theme.roles.border }));
        break;
      case 'run.context-compacted':
        if (payload.summarized) ui.line(ui.theme.paint(`  ${ui.marks.dot} summarized ${payload.omittedTurns} earlier turns to fit the window`, { fg: ui.theme.roles.info }));
        break;
      case 'run.context-window-learned':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} model window is ${payload.next} tokens, not ${payload.previous}; resized and retrying`, { fg: ui.theme.roles.warning }));
        break;
      case 'run.tool-call-repaired':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} fixed ${payload.tool}: ${oneLine((payload.repairs || []).map((entry) => entry.detail.replace(/^[^:]+: /, '')).join('; '), ui.width - 24)}`, { fg: ui.theme.roles.border }));
        break;
      case 'run.edit-check':
        ui.line(ui.theme.paint(`  ${failMark} ${payload.problems} problem${payload.problems === 1 ? '' : 's'} in the edited file — the model has been told`, { fg: ui.theme.roles.warning }));
        break;
      case 'run.verification':
        ui.line(ui.theme.paint(`  ${payload.ok ? okMark : failMark} project checks ${payload.ok ? 'pass' : 'fail'} (attempt ${payload.attempt})`, { fg: payload.ok ? ui.theme.roles.success : ui.theme.roles.warning }));
        break;
      case 'run.stagnation':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} ${payload.level === 'stop' ? 'stopping: the run is repeating itself' : 'nudged: the run is repeating itself'}`, { fg: ui.theme.roles.warning }));
        break;
      case 'run.context-reset':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} context reset #${payload.resets}; continuing from ${payload.file}`, { fg: ui.theme.roles.info }));
        break;
      case 'run.scaffold-level':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} giving this model more help: level ${payload.from} → ${payload.to} (${payload.reason})`, { fg: ui.theme.roles.info }));
        break;
      case 'run.steered':
        ui.line(ui.theme.paint(`  ${ui.marks.dot} delivered: ${oneLine(payload.message, ui.width - 16)}`, { fg: ui.theme.roles.user }));
        break;
      default: break;
    }
  });
}

export async function plainSession(runtime, ui, args) {
  const workspace = await runtime.workspaceManager.open(args.workspace || process.cwd());
  runtime.store.setSetting('lastWorkspaceId', workspace.id);
  const newSession = () => runtime.engine.createSession({ workspaceId: workspace.id, title: 'Plain session', modelRef: args.model || null });
  let session = newSession();
  let activeRunId = null;
  let pendingAnswer = null;
  const approved = new Set();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl.setPrompt('> ');
  const ask = (question) => new Promise((resolve) => { pendingAnswer = resolve; ui.line(question); rl.prompt(); });

  // balanced/review permission modes ask here, in the same line-by-line stream.
  runtime.toolRegistry.confirmHandler = async ({ name, tool, args: callArgs }) => {
    if (approved.has(name)) return true;
    ui.line();
    ui.line(ui.theme.paint(`Approve ${name} (${tool?.risk || 'normal'} risk)?`, { fg: ui.theme.roles.warning, bold: true }));
    for (const line of approvalPreview(ui.theme, name, callArgs || {}, Math.min(ui.width, 100) - 4)) ui.line(`  ${line}`);
    const answer = String(await ask('Answer y (yes), n (no), or a (always, for this session):')).trim().toLowerCase();
    if (answer === 'a' || answer === 'always') { approved.add(name); return true; }
    return answer === 'y' || answer === 'yes';
  };

  // Questions from tools: numbered choices, text, masked secrets, yes/no, and a visible-browser hand-off.
  let muted = false;
  const writeOut = rl._writeToOutput?.bind(rl);
  if (writeOut) rl._writeToOutput = (text) => { if (!muted || text.includes('\n')) writeOut(text); };
  let interactionQueue = Promise.resolve();
  const serialized = (fn) => { const run = () => fn(); interactionQueue = interactionQueue.then(run, run); return interactionQueue; };
  const interactionHandler = {
    choose: (request) => serialized(async () => {
      ui.line();
      ui.line(ui.theme.paint(request.question || request.title, { bold: true }));
      request.options.forEach((option, index) => {
        const extra = [option.price, option.rating ? `${option.rating}★` : '', option.detail].filter(Boolean).join(' · ');
        ui.line(`  ${String(index + 1).padStart(2)}. ${option.label}${extra ? `  — ${extra.slice(0, 90)}` : ''}`);
      });
      if (request.allowOther) ui.line(`   0. ${request.otherLabel}`);
      const answer = String(await ask(request.multi ? 'Numbers separated by commas (blank to cancel):' : 'Number (blank to cancel):')).trim();
      if (!answer) return { cancelled: true };
      if (answer === '0' && request.allowOther) {
        const typed = String(await ask('Your answer:')).trim();
        return typed ? { ids: [], other: typed } : { cancelled: true };
      }
      const ids = answer.split(/[\s,]+/).map((part) => request.options[Number(part) - 1]?.id).filter(Boolean);
      return ids.length ? { ids: request.multi ? ids : ids.slice(0, 1) } : { cancelled: true };
    }),
    text: (request) => serialized(async () => {
      const value = String(await ask(request.question || request.title)).trim();
      return value ? { value } : { cancelled: true };
    }),
    secret: (request) => serialized(async () => {
      ui.line(`${request.question || request.title} (input is hidden; it is not shown to the model or logged)`);
      muted = true;
      let value;
      try { value = await ask(''); } finally { muted = false; ui.line(); }
      return value ? { value: String(value) } : { cancelled: true };
    }),
    confirm: (request) => serialized(async () => {
      ui.line();
      ui.line(ui.theme.paint(request.message, { fg: request.danger ? ui.theme.roles.danger : ui.theme.roles.warning, bold: true }));
      for (const detail of request.details || []) ui.line(`  ${detail}`);
      const answer = String(await ask(request.defaultYes ? 'Proceed? [Y/n]:' : 'Proceed? [y/N]:')).trim().toLowerCase();
      return answer ? answer.startsWith('y') : Boolean(request.defaultYes);
    }),
    handoff: (request) => serialized(async () => {
      const instance = runtime.browserManager.list().find((item) => !request.instanceId || item.id === request.instanceId);
      if (!instance || instance.headless) {
        ui.line('This step needs you in the browser, but the browser is running headless. Open the full-screen interface (maskshift) and use the Browser view, or relaunch the browser with headless:false.');
        return { done: false };
      }
      ui.line(`${request.message} Finish it in the browser window.`);
      const answer = String(await ask('Press Enter when done, or type n to cancel:')).trim().toLowerCase();
      return { done: !answer.startsWith('n') };
    }),
  };
  const detachInteraction = runtime.interaction.attach(interactionHandler);

  ui.line(`MaskShift plain mode in ${workspace.path}.`);
  ui.line('Type a request and press Enter. While a run is working, what you type steers it. Commands: /new, /quit.');
  rl.prompt();

  rl.on('SIGINT', () => {
    if (activeRunId) { ui.line('Cancelling the run…'); void runtime.engine.cancel(activeRunId); return; }
    rl.close();
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (pendingAnswer) { const answer = pendingAnswer; pendingAnswer = null; answer(line); continue; }
    if (!line) { rl.prompt(); continue; }
    if (line === '/quit' || line === '/exit') break;
    if (line === '/new') { session = newSession(); approved.clear(); ui.line('New session.'); rl.prompt(); continue; }
    if (activeRunId) {
      const result = runtime.engine.steer(activeRunId, line);
      ui.line(result.accepted ? 'Sent to the running run; it reads this at its next step.' : 'That run just finished — send it again as a new request.');
      continue;
    }
    // Runs in the background of this loop so input stays live for steering and approvals.
    const unsubscribe = streamRunEvents(runtime, ui, session.id);
    const run = await runtime.engine.startRun({ sessionId: session.id, workspaceId: workspace.id, prompt: line, modelRef: args.model || null, options: { source: 'plain' } });
    activeRunId = run.id;
    void runtime.engine.waitForRun(run.id).then((completed) => {
      unsubscribe();
      activeRunId = null;
      ui.line();
      ui.line(`Run ${completed?.status || 'ended'}${completed?.error ? `: ${completed.error}` : ''}.`);
      rl.prompt();
    });
  }
  rl.close();
  runtime.toolRegistry.confirmHandler = null;
  detachInteraction();
  if (activeRunId) await runtime.engine.cancel(activeRunId).catch(() => {});
  return 0;
}
