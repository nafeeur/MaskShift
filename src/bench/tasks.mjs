// A small, dependency-free task suite for measuring a harness+model pair.
//
// Each task is a tiny project, a plain-language request, and a shell `check` whose exit code is the
// verdict (never the model's opinion). `reference` is a hand-written solution as tool calls: it
// proves the task is solvable and the check is honest — `bench verify` fails the build if a check
// passes on the untouched project or fails after the reference — and it is what the scripted
// model in the tests plays back.

const tab = (text) => text.replace(/^ {2}/gm, '\t');

export const TASKS = [
  {
    id: 'fix-off-by-one', tags: ['bugfix', 'small'],
    title: 'Fix an off-by-one in a loop',
    prompt: 'sumTo(n) in sum.mjs should return 1 + 2 + … + n, but sumTo(4) is wrong. Fix the bug. `node test.mjs` should pass.',
    files: {
      'sum.mjs': 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i += 1) total += i;\n  return total;\n}\n',
      'test.mjs': "import assert from 'node:assert/strict';\nimport { sumTo } from './sum.mjs';\nassert.equal(sumTo(4), 10);\nassert.equal(sumTo(1), 1);\nassert.equal(sumTo(0), 0);\nconsole.log('ok');\n",
    },
    check: 'node test.mjs',
    reference: [{ name: 'fs_patch', args: { path: 'sum.mjs', edits: [{ oldText: 'i < n', newText: 'i <= n' }] } }],
  },
  {
    id: 'rename-function', tags: ['refactor', 'multi-file'],
    title: 'Rename a function across three files',
    prompt: 'Rename the function getUser to fetchUser everywhere (definition and every use). `node test.mjs` should pass and the name getUser must not appear in any .mjs file.',
    files: {
      'users.mjs': 'export function getUser(id) {\n  return { id, name: `user-${id}` };\n}\n',
      'report.mjs': "import { getUser } from './users.mjs';\nexport function label(id) {\n  return getUser(id).name.toUpperCase();\n}\n",
      'audit.mjs': "import { getUser } from './users.mjs';\nexport const audit = (ids) => ids.map((id) => getUser(id).id);\n",
      'test.mjs': "import assert from 'node:assert/strict';\nimport { fetchUser } from './users.mjs';\nimport { label } from './report.mjs';\nimport { audit } from './audit.mjs';\nassert.equal(fetchUser(2).name, 'user-2');\nassert.equal(label(3), 'USER-3');\nassert.deepEqual(audit([1, 2]), [1, 2]);\nconsole.log('ok');\n",
    },
    check: 'node test.mjs && ! grep -rn getUser --include=*.mjs .',
    reference: [
      { name: 'fs_patch', args: { path: 'users.mjs', edits: [{ oldText: 'getUser', newText: 'fetchUser' }] } },
      { name: 'fs_patch', args: { path: 'report.mjs', edits: [{ oldText: 'getUser', newText: 'fetchUser', replaceAll: true }] } },
      { name: 'fs_patch', args: { path: 'audit.mjs', edits: [{ oldText: 'getUser', newText: 'fetchUser', replaceAll: true }] } },
    ],
  },
  {
    id: 'add-function', tags: ['feature', 'small'],
    title: 'Add a function to satisfy a spec',
    prompt: 'Add an exported function slugify(text) to strings.mjs: lower-case it, replace each run of non-alphanumeric characters with a single "-", and trim leading/trailing "-". `node test.mjs` should pass.',
    files: {
      'strings.mjs': 'export function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1);\n}\n',
      'test.mjs': "import assert from 'node:assert/strict';\nimport { slugify, capitalize } from './strings.mjs';\nassert.equal(slugify('Hello, World!'), 'hello-world');\nassert.equal(slugify('  A  B  '), 'a-b');\nassert.equal(slugify('---x---'), 'x');\nassert.equal(capitalize('ok'), 'Ok');\nconsole.log('ok');\n",
    },
    check: 'node test.mjs',
    reference: [{ name: 'fs_patch', args: { path: 'strings.mjs', edits: [{ oldText: 'export function capitalize', newText: "export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n\nexport function capitalize" }] } }],
  },
  {
    id: 'config-value', tags: ['config', 'small'],
    title: 'Change two values in a JSON file',
    prompt: 'In settings.json set retries to 5 and verbose to true. Leave every other setting unchanged.',
    files: { 'settings.json': '{\n  "retries": 3,\n  "timeoutMs": 3000,\n  "verbose": false,\n  "region": "eu-west-1"\n}\n' },
    check: `node -e "const s=JSON.parse(require('fs').readFileSync('settings.json','utf8'));process.exit(s.retries===5&&s.verbose===true&&s.timeoutMs===3000&&s.region==='eu-west-1'?0:1)"`,
    reference: [{ name: 'fs_patch', args: { path: 'settings.json', edits: [{ oldText: '"retries": 3', newText: '"retries": 5' }, { oldText: '"verbose": false', newText: '"verbose": true' }] } }],
  },
  {
    id: 'fix-null-check', tags: ['bugfix'],
    title: 'Handle missing input',
    prompt: 'initials(user) in users.mjs throws when the user or its name is missing. It should return an empty string in those cases and keep working otherwise. `node test.mjs` should pass.',
    files: {
      'users.mjs': "export function initials(user) {\n  return user.name.split(' ').map((part) => part[0]).join('');\n}\n",
      'test.mjs': "import assert from 'node:assert/strict';\nimport { initials } from './users.mjs';\nassert.equal(initials({ name: 'Ada Lovelace' }), 'AL');\nassert.equal(initials({}), '');\nassert.equal(initials(null), '');\nassert.equal(initials({ name: '' }), '');\nconsole.log('ok');\n",
    },
    check: 'node test.mjs',
    reference: [{ name: 'fs_patch', args: { path: 'users.mjs', edits: [{ oldText: "  return user.name.split(' ').map((part) => part[0]).join('');", newText: "  if (!user || !user.name) return '';\n  return user.name.split(' ').filter(Boolean).map((part) => part[0]).join('');" }] } }],
  },
  {
    id: 'implement-from-test', tags: ['feature'],
    title: 'Implement a stub so its tests pass',
    prompt: 'fizz.mjs exports a stub fizzbuzz(n). Implement it: return an array of n entries for 1..n, using "Fizz" for multiples of 3, "Buzz" for multiples of 5, "FizzBuzz" for both, otherwise the number. `node test.mjs` should pass.',
    files: {
      'fizz.mjs': "export function fizzbuzz(n) {\n  throw new Error('not implemented');\n}\n",
      'test.mjs': "import assert from 'node:assert/strict';\nimport { fizzbuzz } from './fizz.mjs';\nassert.deepEqual(fizzbuzz(15).slice(-5), [11, 'Fizz', 13, 14, 'FizzBuzz']);\nassert.deepEqual(fizzbuzz(5), [1, 2, 'Fizz', 4, 'Buzz']);\nassert.deepEqual(fizzbuzz(0), []);\nconsole.log('ok');\n",
    },
    check: 'node test.mjs',
    reference: [{ name: 'fs_write', args: { path: 'fizz.mjs', content: "export function fizzbuzz(n) {\n  const out = [];\n  for (let i = 1; i <= n; i += 1) out.push(i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : i);\n  return out;\n}\n" } }],
  },
  {
    id: 'fix-syntax-error', tags: ['bugfix', 'syntax'],
    title: 'Repair a file that does not parse',
    prompt: 'broken.mjs has a syntax error so main.mjs cannot run. Fix the syntax so `node main.mjs` prints "total: 7". Do not change what the code computes.',
    files: {
      'broken.mjs': 'export function total(items) {\n  let sum = 0;\n  for (const item of items {\n    sum += item;\n  }\n  return sum;\n}\n',
      'main.mjs': "import { total } from './broken.mjs';\nconsole.log(`total: ${total([1, 2, 4])}`);\n",
    },
    check: 'node main.mjs | grep -q "total: 7"',
    reference: [{ name: 'fs_patch', args: { path: 'broken.mjs', edits: [{ oldText: 'for (const item of items {', newText: 'for (const item of items) {' }] } }],
  },
  {
    id: 'update-import-path', tags: ['refactor', 'imports'],
    title: 'Fix an import after a file was moved',
    prompt: 'format.mjs was moved into the util/ directory and now main.mjs fails to start. Fix main.mjs so `node main.mjs` prints "Total: 12". Do not move the file back.',
    files: {
      'util/format.mjs': 'export const money = (n) => `Total: ${n}`;\n',
      'main.mjs': "import { money } from './format.mjs';\nconsole.log(money(5 + 7));\n",
    },
    check: 'node main.mjs | grep -q "Total: 12"',
    reference: [{ name: 'fs_patch', args: { path: 'main.mjs', edits: [{ oldText: "'./format.mjs'", newText: "'./util/format.mjs'" }] } }],
  },
  {
    id: 'tab-indented-edit', tags: ['edit', 'whitespace'],
    title: 'Edit a block in a tab-indented file',
    prompt: 'In pricing.mjs, large orders get a discount. Change the threshold from 100 to 150 and the discount from 10% to 15%. `node test.mjs` should pass.',
    files: {
      'pricing.mjs': tab("export function price(subtotal) {\n  if (subtotal > 100) {\n    const discount = subtotal * 0.10;\n    return subtotal - discount;\n  }\n  return subtotal;\n}\n"),
      'test.mjs': "import assert from 'node:assert/strict';\nimport { price } from './pricing.mjs';\nassert.equal(price(100), 100);\nassert.equal(price(150), 150);\nassert.equal(price(200), 170);\nconsole.log('ok');\n",
    },
    check: 'node test.mjs',
    // Written with spaces, as a model reproducing the file from memory would: a harness that
    // needs byte-exact matches fails this task.
    reference: [{ name: 'fs_patch', args: { path: 'pricing.mjs', edits: [{ oldText: '  if (subtotal > 100) {\n    const discount = subtotal * 0.10;', newText: '  if (subtotal > 150) {\n    const discount = subtotal * 0.15;' }] } }],
  },
  {
    id: 'noisy-failure', tags: ['debug', 'long-output'],
    title: 'Find the cause in a very noisy test log',
    prompt: '`node test.mjs` fails somewhere in a huge amount of output. Find the bug in parse.mjs and fix it so `node test.mjs` passes.',
    files: {
      'parse.mjs': "export function parseAmount(text) {\n  return Number(text.replace(',', ''));\n}\n",
      'test.mjs': "import assert from 'node:assert/strict';\nimport { parseAmount } from './parse.mjs';\nfor (let i = 0; i < 1500; i += 1) console.log(`case ${i}: ok`);\nconsole.log('case big: checking 1,234,567');\nassert.equal(parseAmount('1,234,567'), 1234567);\nfor (let i = 0; i < 1500; i += 1) console.log(`case tail ${i}: ok`);\nconsole.log('done');\n",
    },
    check: 'node test.mjs > /dev/null',
    reference: [{ name: 'fs_patch', args: { path: 'parse.mjs', edits: [{ oldText: "text.replace(',', '')", newText: "text.replaceAll(',', '')" }] } }],
  },
  {
    id: 'remove-dead-code', tags: ['refactor'],
    title: 'Remove an unused function',
    prompt: 'legacyFormat in format.mjs is unused. Remove the function and nothing else; `node main.mjs` must keep printing "7 items".',
    files: {
      'format.mjs': "export function plural(count, word) {\n  return `${count} ${word}${count === 1 ? '' : 's'}`;\n}\n\nexport function legacyFormat(count, word) {\n  return count + ' ' + word + '(s)';\n}\n",
      'main.mjs': "import { plural } from './format.mjs';\nconsole.log(plural(7, 'item'));\n",
    },
    check: 'node main.mjs | grep -q "^7 items$" && ! grep -q legacyFormat format.mjs && grep -q "export function plural" format.mjs',
    reference: [{ name: 'symbol_replace', args: { path: 'format.mjs', symbol: 'legacyFormat', newText: '' } }],
  },
  {
    id: 'class-method-bug', tags: ['bugfix', 'class'],
    title: 'Fix a bug inside a class method',
    prompt: 'Counter.decrement in counter.mjs increases the value instead of decreasing it, and must never go below zero. Fix it. `node test.mjs` should pass.',
    files: {
      'counter.mjs': 'export class Counter {\n  constructor() {\n    this.value = 0;\n  }\n\n  increment() {\n    this.value += 1;\n    return this.value;\n  }\n\n  decrement() {\n    this.value += 1;\n    return this.value;\n  }\n}\n',
      'test.mjs': "import assert from 'node:assert/strict';\nimport { Counter } from './counter.mjs';\nconst c = new Counter();\nc.increment();\nc.increment();\nassert.equal(c.decrement(), 1);\nassert.equal(c.decrement(), 0);\nassert.equal(c.decrement(), 0);\nconsole.log('ok');\n",
    },
    check: 'node test.mjs',
    reference: [{ name: 'symbol_replace', args: { path: 'counter.mjs', symbol: 'Counter.decrement', newText: 'decrement() {\n  this.value = Math.max(0, this.value - 1);\n  return this.value;\n}' } }],
  },
];

export function taskById(id) {
  return TASKS.find((task) => task.id === id) || null;
}
