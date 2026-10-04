import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyEdit, EditMatchError, replaceLines } from '../src/tools/edit-match.mjs';
import { findSymbol, listSymbols } from '../src/tools/symbols.mjs';
import { createProject, runtimeForTest } from './helpers.mjs';

const SOURCE = [
  'function total(items) {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price * item.qty;',
  '  }',
  '  return sum;',
  '}',
  '',
  'function tax(amount) {',
  '  return amount * 0.2;',
  '}',
  '',
].join('\n');

test('exact edits behave as before and report no looser strategy', () => {
  const result = applyEdit(SOURCE, 'return amount * 0.2;', 'return amount * 0.25;');
  assert.equal(result.strategy, 'exact');
  assert.match(result.content, /0\.25/);
  assert.equal(result.replacements, 1);
});

test('an ambiguous exact match is refused with line numbers, and replaceAll still works', () => {
  const content = 'a = 1\nb = 2\na = 1\n';
  assert.throws(() => applyEdit(content, 'a = 1', 'a = 9'), (error) => error instanceof EditMatchError && error.kind === 'ambiguous' && /lines 1, 3/.test(error.message));
  const all = applyEdit(content, 'a = 1', 'a = 9', { replaceAll: true });
  assert.equal(all.content, 'a = 9\nb = 2\na = 9\n');
  assert.equal(all.replacements, 2);
});

test('tolerates trailing whitespace the model dropped', () => {
  const content = 'const a = 1;   \nconst b = 2;\n';
  const result = applyEdit(content, 'const a = 1;\nconst b = 2;', 'const a = 10;\nconst b = 20;');
  assert.equal(result.strategy, 'trailing-whitespace');
  assert.equal(result.content, 'const a = 10;\nconst b = 20;\n');
});

test('tolerates a wrong indent level and re-indents the replacement to the file', () => {
  const content = 'class A {\n    run() {\n        go();\n        stop();\n    }\n}\n';
  const result = applyEdit(content, 'go();\nstop();', 'go();\nwait();\nstop();');
  assert.equal(result.strategy, 'indentation');
  assert.equal(result.content, 'class A {\n    run() {\n        go();\n        wait();\n        stop();\n    }\n}\n');
  assert.deepEqual([result.startLine, result.endLine], [3, 4]);
});

test('tabs versus spaces are matched, and the file keeps its own indentation', () => {
  const content = 'if (x) {\n\treturn 1;\n}\n';
  const result = applyEdit(content, 'if (x) {\n    return 1;\n}', 'if (x) {\n    return 2;\n}');
  assert.match(result.strategy, /indentation|whitespace/);
  assert.match(result.content, /return 2;/);
});

test('collapses internal runs of whitespace', () => {
  const content = 'const   a  =   1;\n';
  const result = applyEdit(content, 'const a = 1;', 'const a = 2;');
  assert.equal(result.strategy, 'whitespace');
  assert.equal(result.content, 'const a = 2;\n');
});

test('matches CRLF files when the model wrote LF, and keeps CRLF', () => {
  const content = 'one\r\ntwo\r\nthree\r\n';
  const result = applyEdit(content, 'one\ntwo', 'uno\ndos');
  assert.match(result.strategy, /line-endings/);
  assert.equal(result.content, 'uno\r\ndos\r\nthree\r\n');
});

test('strips the line-number gutter fs_read prints when the model copies it', () => {
  const old = '     2 |   let sum = 0;\n     3 |   for (const item of items) {';
  const next = '     2 |   let total = 0;\n     3 |   for (const item of items) {';
  const result = applyEdit(SOURCE, old, next);
  assert.match(result.strategy, /gutter/);
  assert.match(result.content, /let total = 0;/);
  assert.ok(!result.content.includes(' | '), 'the gutter did not leak into the file');
});

test('a single-line code that merely contains a pipe is not treated as a gutter', () => {
  const content = 'const m = 1 | 2;\n';
  assert.equal(applyEdit(content, 'const m = 1 | 2;', 'const m = 1 | 4;').strategy, 'exact');
});

test('near matches are accepted only when clearly the best, and are labelled', () => {
  const old = 'function total(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.quantity;\n  }';
  const result = applyEdit(SOURCE, old, 'function total(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.qty * 2;\n  }');
  assert.match(result.strategy, /^fuzzy \d+%$/);
  assert.match(result.content, /item\.qty \* 2/);
  assert.match(result.content, /function tax/);
});

test('two equally plausible near matches are refused, not guessed', () => {
  const twin = 'function render(user) {\n  const name = user.firstName + user.lastName;\n  return name;\n}\n';
  const content = `${twin}\n${twin.replace('render', 'render2')}`;
  const wanted = 'function render(user) {\n  const name = user.first + user.last;\n  return name;\n}';
  assert.throws(() => applyEdit(content, wanted, 'x'), EditMatchError);
});

test('a real miss reports the closest region instead of just "not found"', () => {
  let error;
  try { applyEdit(SOURCE, 'function total(list) {\n  let acc = 0;\n  for (const entry of list) {', 'x'); } catch (caught) { error = caught; }
  assert.ok(error instanceof EditMatchError);
  assert.equal(error.kind, 'missing');
  assert.match(error.message, /not found/);
  assert.match(error.message, /Closest match/);
  assert.match(error.message, /\| function total\(items\) \{/);
});

test('wholly unrelated text fails without inventing a match', () => {
  assert.throws(() => applyEdit(SOURCE, 'database.connect(credentials)', 'x'), (error) => error.kind === 'missing' && !/Closest/.test(error.message));
});

test('a tiny near-match never fuzzy-applies', () => {
  assert.throws(() => applyEdit('let a = 1;\nlet b = 2;\n', 'let c = 3;', 'x'), EditMatchError);
});

test('empty oldText is rejected', () => {
  assert.throws(() => applyEdit('abc', '', 'x'), (error) => error.kind === 'empty');
});

test('replaceLines swaps a range, can delete, can insert at end, and checks the anchor', () => {
  const content = 'a\nb\nc\nd\n';
  assert.equal(replaceLines(content, 2, 3, 'X\nY\nZ').content, 'a\nX\nY\nZ\nd\n');
  assert.equal(replaceLines(content, 2, 3, '').content, 'a\nd\n');
  assert.equal(replaceLines(content, 5, 5, 'e').content, 'a\nb\nc\nd\ne\n');
  assert.equal(replaceLines(content, 2, 2, 'B', { expect: ' b ' }).content, 'a\nB\nc\nd\n');
  assert.throws(() => replaceLines(content, 2, 2, 'B', { expect: 'nope' }), /file has changed or the line number is off/);
  assert.throws(() => replaceLines(content, 9, 9, 'B'), /past the end/);
  assert.throws(() => replaceLines(content, 3, 2, 'B'), /Invalid line range/);
  assert.equal(replaceLines('a\r\nb\r\n', 1, 1, 'A').content, 'A\r\nb\r\n');
});

const JS = `import x from './x.js';

export function alpha(a, b) {
  if (a > b) {
    return "}";
  }
  return a + b; // closes }
}

const beta = (n) =>
  n * 2;

const gamma = async (n) => {
  return n;
};

export class Shape {
  area() {
    return 0;
  }

  static make(kind) {
    return new Shape();
  }
}

function allman(x)
{
  return x;
}
`;

test('findSymbol locates functions, arrow functions, classes and methods by bracket matching', () => {
  const alpha = findSymbol(JS, 'alpha', { file: 'a.js' });
  assert.deepEqual([alpha.startLine, alpha.endLine], [3, 8], 'braces inside strings and comments do not end it early');
  const beta = findSymbol(JS, 'beta', { file: 'a.js' });
  assert.deepEqual([beta.startLine, beta.endLine], [10, 11], 'an expression-bodied arrow continues across lines');
  const gamma = findSymbol(JS, 'gamma', { file: 'a.js' });
  assert.deepEqual([gamma.startLine, gamma.endLine], [13, 15]);
  const shape = findSymbol(JS, 'Shape', { file: 'a.js' });
  assert.deepEqual([shape.startLine, shape.endLine], [17, 25]);
  const make = findSymbol(JS, 'Shape.make', { file: 'a.js' });
  assert.deepEqual([make.startLine, make.endLine], [22, 24]);
  const allman = findSymbol(JS, 'allman', { file: 'a.js' });
  assert.deepEqual([allman.startLine, allman.endLine], [27, 30], 'a brace on the next line still belongs to the function');
});

test('findSymbol on Python uses indentation and includes decorators', () => {
  const py = '@cache\ndef fib(n):\n    if n < 2:\n        return n\n\n    return fib(n-1) + fib(n-2)\n\nclass K:\n    def m(self):\n        pass\n';
  const fib = findSymbol(py, 'fib', { file: 'a.py' });
  assert.deepEqual([fib.startLine, fib.endLine], [1, 6]);
  const m = findSymbol(py, 'K.m', { file: 'a.py' });
  assert.deepEqual([m.startLine, m.endLine], [9, 10]);
});

test('findSymbol explains what it did find when the name is missing, duplicated or unsupported', () => {
  assert.throws(() => findSymbol(JS, 'nope', { file: 'a.js' }), /Definitions found: .*alpha/);
  assert.throws(() => findSymbol('function a(){}\nfunction a(){}\n', 'a', { file: 'a.js' }), /defined 2 times/);
  assert.throws(() => findSymbol('def x\nend\n', 'x', { file: 'a.rb' }), /not supported for \.rb/);
  assert.throws(() => findSymbol(JS, 'Missing.make', { file: 'a.js' }), /No class named `Missing`/);
  assert.deepEqual(listSymbols(JS).map((entry) => entry.name).slice(0, 3), ['alpha', 'beta', 'gamma']);
});

test('fs_patch tolerates a mis-indented edit end to end and says so', async (t) => {
  const project = await createProject(t);
  await fsp.writeFile(path.join(project, 'm.js'), 'function f() {\n    const a = 1;\n    return a;\n}\n');
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = { workspaceId: workspace.id, workspacePath: project, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
  const result = await runtime.toolRegistry.execute('fs_patch', { path: 'm.js', edits: [{ oldText: 'const a = 1;\nreturn a;', newText: 'const a = 2;\nreturn a;' }] }, context);
  assert.equal(result.applied[0].matchedBy, 'indentation');
  assert.match(result.note, /looser match/);
  assert.equal(await fsp.readFile(path.join(project, 'm.js'), 'utf8'), 'function f() {\n    const a = 2;\n    return a;\n}\n');
  await assert.rejects(
    runtime.toolRegistry.execute('fs_patch', { path: 'm.js', edits: [{ oldText: 'const a = 2;', newText: 'const a = 3;' }, { oldText: 'completely absent line here', newText: 'x' }] }, context),
    /Edit 1: oldText was not found/,
  );
  assert.match(await fsp.readFile(path.join(project, 'm.js'), 'utf8'), /const a = 2;/, 'a failed batch changes nothing');
});

test('symbol_replace re-indents flush-left text to the definition', async (t) => {
  const project = await createProject(t);
  await fsp.writeFile(path.join(project, 'c.js'), 'class A {\n  one() {\n    return 1;\n  }\n\n  two() {\n    return 2;\n  }\n}\n');
  const runtime = await runtimeForTest(t, project);
  const workspace = await runtime.workspaceManager.open(project);
  const context = { workspaceId: workspace.id, workspacePath: project, eventBus: runtime.eventBus, scope: { workspaceId: workspace.id } };
  await runtime.toolRegistry.execute('symbol_replace', { path: 'c.js', symbol: 'A.two', newText: 'two() {\n  return 22;\n}\n' }, context);
  assert.equal(await fsp.readFile(path.join(project, 'c.js'), 'utf8'), 'class A {\n  one() {\n    return 1;\n  }\n\n  two() {\n    return 22;\n  }\n}\n');
});
