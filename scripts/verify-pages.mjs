import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import worker from '../pages-dist/_worker.js';

const entries = await readdir('pages-dist');
for (const forbidden of ['server', '.vite', '.openai', '.git', '.env'])
  assert.ok(!entries.includes(forbidden), `Private build material in Pages output: ${forbidden}`);
for (const asset of ['index.html', 'offline.html', 'preparedness.html', 'sw.js', '404.html'])
  assert.deepEqual(await readFile(`pages-dist/${asset}`), await readFile(`dist/${asset}`));
assert.deepEqual(JSON.parse(await readFile('pages-dist/_routes.json', 'utf8')), {
  version: 1,
  include: ['/api/*'],
  exclude: [],
});
const env = {
  ASSETS: {
    async fetch() {
      throw new Error('An API request must not fall back to a static HTML page');
    },
  },
};
const check = (path, options) =>
  worker.fetch(new Request(`https://stormsignal.invalid${path}`, options), env);
const invalid = await check('/api/alerts?lat=bad&lon=0&country=US');
assert.equal(invalid.status, 400);
assert.match(invalid.headers.get('Content-Type'), /application\/json/);
assert.equal(invalid.headers.get('Cache-Control'), 'no-store');
assert.equal((await invalid.json()).error, true);
assert.equal((await check('/api/alerts', { method: 'POST' })).status, 405);
assert.equal((await check('/api/unknown')).status, 404);
// On Workers a warning check, and the shared reads still running when it ends, must be kept alive
// past a client disconnect with waitUntil (server/pages.ts).
const kept = [];
await worker.fetch(
  new Request('https://stormsignal.invalid/api/alerts?lat=bad&lon=0&country=US'),
  env,
  { waitUntil: (promise) => kept.push(promise) },
);
assert.equal(kept.length, 1, 'A warning check must be handed to waitUntil');
await Promise.all(kept);
const headers = await readFile('pages-dist/_headers', 'utf8');
assert.match(headers, /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/);
// Read _headers as Pages does (Cloudflare's parseHeaders and constructHeaders): a trimmed line that
// starts with "/" or "scheme://" opens a rule, however it is indented; a header name ends at the
// first ":" and ignores case; "! Name" detaches a header. A page gets every rule whose path matches
// it, but a later rule for the same path replaces the earlier one instead of adding to it.
const rules = [];
for (const text of headers.split('\n')) {
  const line = text.trim();
  if (!line || line.startsWith('#')) continue;
  if (/^([^\s]+:\/\/|\/)/.test(line)) {
    // Pages keys a rule by its normalised path, so "/./*" or "/*?v=1" is the "/*" rule too.
    const path = line.startsWith('/') ? new URL(`//${line}`, 'relative://').pathname : line;
    rules.push({ line, path, headers: [] });
  } else {
    const [name, ...value] = line.split(':');
    rules.at(-1)?.headers.push({
      name: name.replace(/^!/, '').trim().toLowerCase(),
      value: line.startsWith('!') ? null : value.join(':').trim(),
    });
  }
}
assert.ok(rules.length <= 100, 'Pages reads at most 100 _headers rules');
for (const [index, { line, path }] of rules.entries())
  assert.equal(
    rules.findIndex((rule) => rule.path === path),
    index,
    `Pages reads "${line}" as a second rule for ${path} and keeps only the last: merge the two`,
  );
// Each page gets these from the "/*" rule, once each; no other rule may set or detach them.
const allPages = rules.find((rule) => rule.path === '/*');
for (const [name, value] of Object.entries({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), payment=()',
  'X-Frame-Options': 'DENY',
})) {
  const named = (rule) => rule.headers.filter((header) => header.name === name.toLowerCase());
  assert.deepEqual(
    allPages ? named(allPages).map((header) => header.value) : [],
    [value],
    `Pages "/*" rule must send ${name}: ${value} once`,
  );
  for (const rule of rules)
    assert.ok(
      rule === allPages || !named(rule).length,
      `Pages rule ${rule.line} changes ${name}, which only the "/*" rule may send`,
    );
}
// The resource library is the only page with its own Content-Security-Policy. A change to it must
// be deliberate: update this copy too.
const resourcePolicy =
  "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self' https://raw.githubusercontent.com; img-src 'self'; base-uri 'none'; form-action 'none'";
// A browser ignores comments, applies a policy <meta> only as a child of <head>, and applies it
// only to what loads after it. So the page is read from its first character, as the HTML tokenizer
// reads it: a doctype, <html> and <head>, then nothing but spaces, comments and other <meta> tags
// up to the policy. Only that plain markup is accepted; anything else fails the check, so no text
// can be read one way here and another way by a browser.
const space = String.raw`[\t\n\f\r ]`;
// A comment ends at its first "-->" or "--!>", at once if written "<!-->" or "<!--->", and
// otherwise at the end of the page.
const comment = String.raw`<!--(?:-?>|(?!-?>)(?:(?!--!?>)[^])*(?:--!?>|$))`;
const gap = `(?:${space}|${comment})*`;
// The rest of a start tag: attributes, then ">" or "/>". A quote opens a value only after "=", and
// an unquoted value runs to the next space or ">", so each tag can be read only one way.
const rest = String.raw`(?:${space}+[^\t\n\f\r />=]+(?:=(?:"[^"]*"|'[^']*'|[^\t\n\f\r >"'][^\t\n\f\r >]*(?=[\t\n\f\r >])))?)*${space}*/?>`;
const opening = new RegExp(
  String.raw`^\uFEFF?${gap}(?:<!doctype html>${gap})?(?:<html${rest}${gap})?(?<head><head${rest})(?:${space}|${comment}|<meta${rest})*?(?<policy><meta${space}+http-equiv="Content-Security-Policy"${space}+content="(?<content>[^"]*)"${rest})`,
  'di',
);
const checkResourcePolicy = (page) => {
  const policies = [
    ...page
      .replace(new RegExp(comment, 'g'), '')
      .matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi),
  ].map((match) => match[1]);
  assert.deepEqual(
    policies,
    [resourcePolicy],
    'The resource page must keep its one Content-Security-Policy',
  );
  const found = opening.exec(page);
  assert.equal(
    found?.groups.content,
    resourcePolicy,
    'The resource page must declare its policy in <head>, after nothing but other <meta> tags',
  );
  return found.indices.groups;
};
const resourcePage = await readFile('pages-dist/resources/index.html', 'utf8');
const { head, policy } = checkResourcePolicy(resourcePage);
// Each of these keeps the policy's text, but a browser would not apply it, or would apply it only
// after something else had loaded. The check must reject every one.
const [before, tag, after] = [
  resourcePage.slice(0, policy[0]),
  resourcePage.slice(...policy),
  resourcePage.slice(policy[1]),
];
const script = '<script type="module" src="./explorer.mjs"></script>';
for (const [label, edited] of [
  ['the policy in a comment', `${before}<!--${tag}-->${after}`],
  ['the policy in <noscript>', `${before}<noscript>${tag}</noscript>${after}`],
  ['the policy in <template>', `${before}<template>${tag}</template>${after}`],
  ['the policy in <template><head>', `${before}<template><head>${tag}</head></template>${after}`],
  [
    'a script between <html> and <head>',
    resourcePage.slice(0, head[0]) + script + resourcePage.slice(head[0]),
  ],
  ['a script after "<!-->", which ends a comment', `${before}<!-->${script}<!-- -->${tag}${after}`],
  [
    'a script after "--!>", which ends a comment',
    `${before}<!-- --!>${script}<!-- -->${tag}${after}`,
  ],
  [
    'a script between metas holding "<!--" and "-->"',
    `${before}<meta name="a" content="<!--">${script}<meta name="b" content="-->">${tag}${after}`,
  ],
  [
    'another policy in <head>, and this one in <body>',
    `${before}<meta http-equiv="Content-Security-Policy" id="draft" content="default-src *">${after.replace('</body>', () => `${tag}</body>`)}`,
  ],
  [
    // The count reads the weaker policy as part of a comment; only the content comparison sees it.
    'a weaker policy in <head> between metas holding "<!--" and "-->", and this one in <body>',
    `${before}<meta name="a" content="<!--"><meta http-equiv="Content-Security-Policy" content="default-src *"><meta name="b" content="-->">${after.replace('</body>', () => `${tag}</body>`)}`,
  ],
])
  assert.throws(
    () => checkResourcePolicy(edited),
    assert.AssertionError,
    `The resource page check must reject ${label}`,
  );

const notices = await readFile('pages-dist/third-party-licenses.md', 'utf8');
for (const name of [
  'react',
  'leaflet',
  'three',
  'lucide-react',
  'fast-xml-parser',
  '@nodable/entities',
  'xml-naming',
  'anynum',
  'strnum',
  'path-expression-matcher',
  'is-unsafe',
]) {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  assert.match(
    notices,
    new RegExp(`^## ${esc}(?: - |@)`, 'm'),
    `Missing shipped dependency notice: ${name}`,
  );
}
assert.match(notices, /Copyright \(c\) 2026 Nodable/);
assert.match(notices, /Permission is hereby granted, free of charge/);
console.log(
  'Pages artifact: API validation, static parity, routing, notices and output isolation passed.',
);
