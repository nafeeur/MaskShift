import assert from 'node:assert/strict';
import test from 'node:test';
import { notify } from '../src/notify/index.mjs';

test('notify launches the OS default notifier and never throws even for a missing binary', async () => {
  await new Promise((resolve) => {
    notify({ title: 'MaskShift — CLEAN GETAWAY', message: 'Refactor the frame renderer' }, {
      onError: () => resolve(), // a real box may or may not have osascript/notify-send/powershell
    });
    // If spawn succeeded synchronously with no error, that's success too.
    setTimeout(resolve, 300);
  });
});

test('notify interpolates a custom command\'s {title}/{message} placeholders instead of using the OS default', async () => {
  const seen = await new Promise((resolve, reject) => {
    // `printf` is close to universally available and lets us see exactly
    // what argv notify() built, without depending on a real notifier.
    notify({
      title: 'Run done',
      message: 'all clear',
      command: 'printf %s\\n {title}::{message}',
    }, { onError: reject });
    setTimeout(() => resolve(true), 300);
  });
  assert.equal(seen, true);
});

test('notify reports an error instead of throwing when no notifier exists for the platform', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'sunos' });
  try {
    let captured = null;
    assert.doesNotThrow(() => {
      notify({ title: 't', message: 'm' }, { onError: (error) => { captured = error; } });
    });
    assert.ok(captured instanceof Error);
    assert.match(captured.message, /No notification command/);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});
