import assert from 'node:assert/strict';
import test from 'node:test';
import { sandboxUnavailable } from '../src/browser/manager.mjs';

// Chromium aborts outright — "No usable sandbox!" — when its sandbox cannot start, so this
// predicate decides whether a launch works at all on a given host. It is untestable by
// observation (no single machine exhibits every case), which is exactly why it is worth
// pinning: the previous rule inferred it from the uid alone and got a default GitHub
// Actions runner wrong.
const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const knobs = (values) => (file) => (file in values ? values[file] : missing());

const APPARMOR = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const USERNS_CLONE = '/proc/sys/kernel/unprivileged_userns_clone';
const MAX_USERNS = '/proc/sys/user/max_user_namespaces';

test('Chromium sandbox availability detection', async (suite) => {
  await suite.test('non-Linux hosts always keep the sandbox', () => {
    for (const platform of ['darwin', 'win32']) {
      assert.equal(sandboxUnavailable({ platform, uid: 0, readFile: missing }), false);
    }
  });

  await suite.test('root cannot use the sandbox at all', () => {
    assert.equal(sandboxUnavailable({ platform: 'linux', uid: 0, readFile: missing }), true);
  });

  await suite.test('a plain unprivileged user keeps the sandbox', () => {
    assert.equal(sandboxUnavailable({ platform: 'linux', uid: 1001, readFile: missing }), false);
    assert.equal(sandboxUnavailable({
      platform: 'linux', uid: 1001, readFile: knobs({ [APPARMOR]: '0\n', [MAX_USERNS]: '64230\n' }),
    }), false);
  });

  // The case that broke CI: non-root on Ubuntu 23.10+, where AppArmor withholds
  // unprivileged user namespaces from unconfined programs.
  await suite.test('AppArmor restricting unprivileged userns disables the sandbox', () => {
    assert.equal(sandboxUnavailable({
      platform: 'linux', uid: 1001, readFile: knobs({ [APPARMOR]: '1\n' }),
    }), true);
  });

  await suite.test('a kernel with user namespaces switched off disables the sandbox', () => {
    assert.equal(sandboxUnavailable({
      platform: 'linux', uid: 1001, readFile: knobs({ [USERNS_CLONE]: '0\n' }),
    }), true);
    assert.equal(sandboxUnavailable({
      platform: 'linux', uid: 1001, readFile: knobs({ [MAX_USERNS]: '0\n' }),
    }), true);
  });

  await suite.test('an unreadable knob is treated as no restriction, not as a failure', () => {
    assert.equal(sandboxUnavailable({
      platform: 'linux',
      uid: 1001,
      readFile: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    }), false);
  });

  await suite.test('a host that cannot report a uid is treated as unable to sandbox', () => {
    assert.equal(sandboxUnavailable({ platform: 'linux', uid: null, readFile: missing }), true);
  });
});
