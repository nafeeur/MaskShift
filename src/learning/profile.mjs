// What kind of task is this? One shared answer for the router, the ledger, lesson retrieval and context feedback, so
// "similar task" means the same thing everywhere.

import { STOPWORDS } from '../core/utils.mjs';

const TAGS = [
  ['frontend', /\b(react|vue|svelte|css|frontend|ui|browser|component|html|tailwind)\b/],
  ['systems', /\b(c\+\+|cpp|rust|deadlock|thread|memory|performance|kernel|concurren\w*)\b/],
  ['verification', /\b(test|tests|verify|review|audit|regression|security|lint)\b/],
  ['large-change', /\b(refactor\w*|migrat\w*|architecture|multi-file|across the repo|rewrite)\b/],
  ['research', /\b(research|compare|investigate|explain|summari[sz]e|find out)\b/],
  ['debugging', /\b(fix|bug|error|crash|exception|broken|fails?|failing|stack ?trace|regress\w*)\b/],
  ['docs', /\b(readme|docs?|documentation|changelog|write ?up|tutorial)\b/],
  ['data', /\b(csv|spreadsheet|xlsx|sql|query|dataset|etl|dataframe|pandas)\b/],
  ['devops', /\b(docker|deploy\w*|ci|kubernetes|terraform|pipeline|helm|ansible)\b/],
  ['web', /\b(browse|website|scrape|url|webpage|crawl)\b/],
];

// Contractions split at the apostrophe ("don't" → "don"), which leaves fragments that are not words anyone means.
const FRAGMENTS = new Set(['don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'won', 'can', 'shouldn', 'couldn', 'wouldn', 'please', 'also', 'just']);

const meaningful = (text) => [...new Set((String(text || '').toLowerCase().match(/[a-z0-9_.$/-]{3,}/g) || [])
  .map((token) => token.replace(/^[.$/-]+|[.$/-]+$/g, '')))]
  .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !FRAGMENTS.has(token));

export function classifyTask(prompt = '') {
  const text = String(prompt).toLowerCase();
  const tags = TAGS.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  if (!tags.length) tags.push('general-coding');
  const complexity = text.length > 1200 || tags.includes('large-change') ? 'high' : text.length < 160 ? 'low' : 'medium';
  const tokens = meaningful(text).slice(0, 40);
  return { tags, complexity, tokens };
}

const jaccard = (a, b) => {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
};

/** 0..1: how alike two tasks are, weighting the kind of work more than the exact words. */
export function similarity(a, b) {
  return 0.6 * jaccard(a.tags || [], b.tags || []) + 0.4 * jaccard(a.tokens || [], b.tokens || []);
}

/** Share of the smaller set that the other also holds: high when one text is a rephrasing or an extension of the other. */
const overlap = (a, b) => {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / Math.min(left.size, right.size);
};

export { jaccard, meaningful, overlap };
