import test from 'node:test';
import assert from 'node:assert/strict';
import { Theme } from '../src/tui/theme.mjs';
import { ROLES } from '../src/tui/tokens.mjs';
import { statusLine } from '../src/tui/status.mjs';

const retro = ROLES;

function channels(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the theme is the green-phosphor palette', () => {
  const theme = new Theme({ depth: 24 });
  assert.equal(theme.roles, ROLES);
  assert.equal(theme.themeId, undefined);
});

test('palette uses only green: every role is a pure green hue (red === blue, green dominant)', () => {
  for (const [role, hex] of Object.entries(retro)) {
    const [r, g, b] = channels(hex);
    assert.equal(r, b, `${role} ${hex} is not a pure green`);
    assert.ok(g >= r, `${role} ${hex} is not green-dominant`);
  }
});

test('palette text roles stay readable on every surface they are drawn on', () => {
  const surfaces = ['background', 'surface', 'surfaceRaised', 'surfaceSunken', 'selection'];
  const text = ['heading', 'text', 'label', 'dim', 'muted', 'success', 'warning', 'danger', 'info', 'tool', 'skill', 'user'];
  for (const surface of surfaces) {
    for (const role of text) {
      assert.ok(contrast(retro[role], retro[surface]) >= 4.5, `${role} on ${surface} is below 4.5:1`);
    }
  }
});

test('palette severity is carried by brightness order, not hue', () => {
  const l = (role) => luminance(retro[role]);
  assert.ok(l('danger') >= l('warning'));
  assert.ok(l('warning') > l('success'));
  assert.ok(l('success') > l('info'));
  assert.ok(l('info') > l('muted'));
});

test('palette draws failure inverse and warning bold', () => {
  const theme = new Theme({ depth: 24 });
  const fail = theme.signal('danger');
  assert.equal(fail.inverse, undefined);
  assert.equal(fail.bg, retro.danger);
  assert.equal(fail.fg, retro.background);
  assert.equal(theme.signal('warning').bold, true);
  assert.notEqual(statusLine(theme, 'failed'), statusLine(theme, 'completed'));
  assert.ok(statusLine(theme, 'failed').includes('\u001b[48;2;'), 'failed status should paint a background bar');
});
