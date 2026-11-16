import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
// @ts-expect-error Shared native ESM worker builder.
import { workerUpdateProtocolSource } from '../scripts/app-update-protocol.mjs';

const html = readFileSync('public/offline.html', 'utf8');
const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1],
);
const [seedSource, coreSource, uiSource] = scripts;
const core = vm.runInNewContext(`${coreSource}\nStormKitCore`);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const now = Date.now();
const plan = (contact = 'A trusted person') => ({
  version: 1,
  savedAt: now - 1000,
  plan: {
    contact,
    phone: '+91 90000 00000',
    meeting: 'The agreed place',
    authority: '',
    notes: 'Check in\nதமிழ்',
  },
  checked: ['radio', 'copy'],
});

test('offline kit stays small, self-contained and free of automatic network APIs', () => {
  assert.ok(Buffer.byteLength(html) < 35000, 'Keep the standalone kit under 35 KB');
  assert.equal(scripts.length, 3);
  // The only link is the inline icon, which travels with a downloaded copy.
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,[^"]+">/);
  assert.doesNotMatch(
    html,
    /<script[^>]+src=|<link(?! rel="icon" href="data:image\/svg\+xml,)|<(?:img|iframe|video|audio)[\s>]|@import/i,
  );
  assert.doesNotMatch(html.match(/<style>([\s\S]*?)<\/style>/)![1], /url\s*\(/i);
  assert.doesNotMatch(
    coreSource + uiSource,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/,
  );
  // The service-worker container is used only to answer the app-update safety check.
  assert.doesNotMatch(coreSource + uiSource, /serviceWorker(?!\.addEventListener\('message',)/);
  assert.doesNotThrow(() => new vm.Script(coreSource));
  assert.doesNotThrow(() => new vm.Script(uiSource));
  assert.deepEqual(plain(core.parse(seedSource)), plain(core.empty()));
});

test('action cards, sources and limitations remain available without JavaScript', () => {
  assert.equal((html.match(/<article class="card">/g) || []).length, 6);
  for (const phrase of [
    'Flooding',
    'Thunder &amp; lightning',
    'Earthquake shaking',
    'Wildfire nearby',
    'Cyclone &amp; severe wind',
    'Little signal or battery',
    'cannot send a distress signal',
    'no live data',
    'nothing is uploaded',
  ]) {
    assert.ok(html.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
  for (const source of [
    'https://www.weather.gov/safety/flood-during',
    'https://www.weather.gov/safety/lightning-tips',
    'https://www.cdc.gov/earthquakes/safety/stay-safe-during-an-earthquake.html',
    'https://www.usfa.fema.gov/wui/outreach/wildfire-evacuation.html',
    'https://www.weather.gov/safety/hurricane-action',
    'https://www.readync.gov/stay-informed/tips-communicating',
  ]) {
    assert.ok(html.includes(source), source);
  }
  assert.match(html, /@media print/);
  assert.match(html, /<noscript>/);
});

test('valid backups preserve multilingual notes and strip unknown properties', () => {
  const input = { ...plan(), injected: 'ignored', plan: { ...plan().plan, secret: 'ignored' } };
  const result = core.parse(JSON.stringify(input));
  assert.deepEqual(plain(result), plan());
  result.plan.contact = 'changed';
  assert.equal(input.plan.contact, 'A trusted person');
});

test('backup validation rejects malformed, excessive and unsupported data atomically', () => {
  // Each case must be refused for its own reason, not by an earlier check or an unrelated error.
  const backup = /Choose a valid StormSignal field-kit backup/;
  const field = /A plan field is missing or too long/;
  const checklist = /The checklist in this backup is invalid/;
  const saveTime = /The backup has an invalid save time/;
  for (const [value, reason] of [
    [null, backup],
    [[], backup],
    [{}, backup],
    [{ ...plan(), version: 2 }, backup],
    [{ ...plan(), plan: [] }, backup],
    [{ ...plan(), plan: { ...plan().plan, notes: 'x'.repeat(1201) } }, field],
    [{ ...plan(), plan: { ...plan().plan, contact: '\u0000' } }, field],
    [{ ...plan(), plan: { ...plan().plan, phone: 123 } }, field],
    [{ ...plan(), checked: ['radio', 'radio'] }, checklist],
    [{ ...plan(), checked: ['unknown'] }, checklist],
    [{ ...plan(), savedAt: now + 600000 }, saveTime],
    [{ ...plan(), savedAt: 1 }, saveTime],
  ] as const) {
    assert.throws(() => core.normalize(value, now), reason, JSON.stringify(value).slice(0, 100));
  }
  assert.throws(() => core.parse(' '.repeat(12001)), /smaller than 12 KB/);
  assert.throws(() => core.parse('{incomplete'), /^SyntaxError:/);
});

test('downloaded plan payload cannot escape its JSON script element', () => {
  const input = plan('</script><script>evil()</script>');
  input.plan.notes = '<img src=x onerror=evil()>&\u2028\u2029';
  const encoded = core.embed(input);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(encoded), input);
  const crafted = JSON.parse(
    JSON.stringify(input).replace('"version":1', '"__proto__":{"polluted":true},"version":1'),
  );
  assert.equal(Object.hasOwn(core.normalize(crafted), '__proto__'), false);
  assert.equal(({} as any).polluted, undefined);
});

test('telephone links accept only intentional dialable numbers', () => {
  assert.equal(core.phoneHref('+91 (90000) 00000'), 'tel:+919000000000');
  assert.equal(core.phoneHref('020-123-4567'), 'tel:0201234567');
  for (const phone of [
    '',
    '12',
    'javascript:alert(1)',
    'tel:+1234',
    '+1234;123',
    '*123#',
    '1'.repeat(21),
    '<script>',
  ]) {
    assert.equal(core.phoneHref(phone), null, phone);
  }
});

class Node {
  value = '';
  textContent = '';
  checked = false;
  hidden = false;
  href = '';
  children: Node[] = [];
  listeners: Record<string, (event: any) => unknown> = {};
  classList = { toggle: () => {} };
  addEventListener(type: string, callback: (event: any) => unknown) {
    this.listeners[type] = callback;
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  removeAttribute(name: string) {
    if (name === 'href') this.href = '';
  }
  dispatch(type: string, event: any = {}) {
    return this.listeners[type]?.({ preventDefault() {}, ...event });
  }
}

function harness(
  options: {
    stored?: unknown;
    embedded?: unknown;
    blocked?: boolean;
    clock?: number;
    // Device storage shared with other open copies of the kit.
    shared?: { value: string | null };
  } = {},
) {
  const elements = new Map<string, Node>();
  for (const id of [
    'kit-seed',
    'contact',
    'phone',
    'meeting',
    'authority',
    'notes',
    'print-plan',
    'call-contact',
    'plan-status',
    'plan-form',
    'check-count',
    'check-status',
    'download-kit',
    'export-plan',
    'print-kit',
    'import-plan',
    'file-status',
  ])
    elements.set(id, new Node());
  elements.get('kit-seed')!.textContent = JSON.stringify(options.embedded ?? core.empty());
  const boxes = ['radio', 'charge', 'supplies', 'contacts', 'route', 'copy'].map((value) => {
    const node = new Node();
    node.value = value;
    return node;
  });
  const store = options.shared ?? {
    value:
      options.stored === undefined
        ? null
        : typeof options.stored === 'string'
          ? options.stored
          : JSON.stringify(options.stored),
  };
  const document = {
    getElementById: (id: string) => elements.get(id),
    querySelectorAll: () => boxes,
    querySelector: (selector: string) => ({ textContent: selector }),
    createElement: () => new Node(),
  };
  const localStorage = {
    getItem: () => {
      if (options.blocked) throw Error('Storage blocked');
      return store.value;
    },
    setItem: (_key: string, value: string) => {
      if (options.blocked) throw Error('Storage blocked');
      store.value = value;
    },
  };
  vm.runInNewContext(coreSource + '\n' + uiSource, {
    document,
    localStorage,
    window: { addEventListener() {}, print() {} },
    // An optional fixed device clock, as after a correction or a reset.
    Date:
      options.clock === undefined
        ? Date
        : class extends Date {
            static now() {
              return options.clock!;
            }
          },
    Error,
  });
  return {
    elements,
    boxes,
    raw: () => store.value,
    saved: () => (store.value === null ? null : JSON.parse(store.value)),
    element: (id: string) => elements.get(id)!,
  };
}

test('device storage failure leaves the editable offline kit usable', () => {
  const h = harness({ blocked: true, embedded: plan('Downloaded contact') });
  assert.equal(h.element('contact').value, 'Downloaded contact');
  assert.match(h.element('plan-status').textContent, /storage could not be read/);
  h.element('contact').value = 'Still editable';
  h.element('plan-form').dispatch('submit');
  assert.match(h.element('plan-status').textContent, /could not save/);
  assert.equal(h.element('contact').value, 'Still editable');
  h.boxes[1].checked = true;
  h.boxes[1].dispatch('change');
  assert.match(h.element('check-status').textContent, /could not be saved/);
  // Nothing was read from blocked storage, and Save fails too: the message claims neither.
  assert.equal(
    h.element('check-status').textContent,
    'Checklist changed here but could not be saved. Download a copy to keep it.',
  );
  assert.equal(h.raw(), null);
});

test('downloaded file reload uses newer explicitly saved edits over its embedded snapshot', () => {
  const old = plan('Original download');
  const updated = { ...plan('Newer saved plan'), savedAt: now };
  const h = harness({ embedded: old, stored: updated });
  assert.equal(h.element('contact').value, 'Newer saved plan');
  const other = harness({ embedded: updated, stored: old });
  assert.equal(other.element('contact').value, 'Newer saved plan');
});

test('draft edits and restored backup fields require explicit Save, even when checklist changes', async () => {
  const h = harness({ stored: plan('Saved contact') });
  h.element('contact').value = 'Unsaved contact';
  h.boxes[1].checked = true;
  h.boxes[1].dispatch('change');
  assert.equal(h.saved().plan.contact, 'Saved contact');
  assert.ok(h.saved().checked.includes('charge'));
  const incoming = plan('Restored contact');
  const json = JSON.stringify(incoming);
  await h.element('import-plan').dispatch('change', {
    target: { files: [{ size: json.length, text: async () => json }], value: 'backup.json' },
  });
  assert.equal(h.element('contact').value, 'Restored contact');
  assert.equal(h.saved().plan.contact, 'Saved contact');
  h.boxes[1].checked = true;
  h.boxes[1].dispatch('change');
  assert.equal(h.saved().plan.contact, 'Saved contact');
  h.element('plan-form').dispatch('submit');
  assert.equal(h.saved().plan.contact, 'Restored contact');
  assert.equal(h.element('call-contact').href, 'tel:+919000000000');
});

test('invalid backups leave current plan and checklist untouched', async () => {
  const h = harness({ stored: plan('Keep this') });
  const before = h.saved();
  await h.element('import-plan').dispatch('change', {
    target: { files: [{ size: 13000, text: async () => '{}' }], value: 'bad.json' },
  });
  assert.equal(h.element('contact').value, 'Keep this');
  assert.deepEqual(h.saved(), before);
  assert.match(h.element('file-status').textContent, /smaller than 12 KB/);
  const corrupt = harness({ stored: '{' });
  assert.equal(corrupt.element('contact').value, '');
  assert.match(corrupt.element('plan-status').textContent, /could not be read/);
});

test('the kit reads its own saved plan after the device clock is set back; imported backups keep the time check', () => {
  // Saved, then the clock was corrected to read 10 minutes earlier.
  const ahead = { ...plan('Saved contact'), savedAt: now + 600000 };
  assert.equal(core.restore(JSON.stringify(ahead)).plan.contact, 'Saved contact');
  assert.throws(() => core.parse(JSON.stringify(ahead)), /invalid save time/);
  const h = harness({ stored: ahead });
  assert.equal(h.element('contact').value, 'Saved contact');
  assert.match(h.element('plan-status').textContent, /Loaded your latest saved plan/);
  h.boxes[2].checked = true;
  h.boxes[2].dispatch('change');
  assert.match(h.element('check-status').textContent, /Checklist saved on this device/);
  assert.equal(h.saved().plan.contact, 'Saved contact');
  assert.deepEqual(h.saved().checked, ['radio', 'supplies', 'copy']);
  const download = harness({ embedded: { ...plan('Downloaded contact'), savedAt: now + 600000 } });
  assert.equal(download.element('contact').value, 'Downloaded contact');
  assert.match(download.element('plan-status').textContent, /included in this offline copy/);
  // A record an earlier kit stored while the clock read 1970 is readable too.
  const legacy = harness({ stored: { ...plan('Legacy contact'), savedAt: 1800000 } });
  assert.equal(legacy.element('contact').value, 'Legacy contact');
});

test('a stored plan that cannot be read is never replaced by a checklist change, only by Save', () => {
  for (const stored of ['{', JSON.stringify({ ...plan('Newer format'), version: 2 })]) {
    const h = harness({ stored });
    assert.match(h.element('plan-status').textContent, /could not be read/);
    h.boxes[0].checked = true;
    h.boxes[0].dispatch('change');
    assert.match(h.element('check-status').textContent, /could not be saved.*left unchanged/);
    assert.equal(h.raw(), stored);
    h.element('contact').value = 'New contact';
    h.element('plan-form').dispatch('submit');
    assert.equal(h.saved().plan.contact, 'New contact');
    h.boxes[1].checked = true;
    h.boxes[1].dispatch('change');
    assert.match(h.element('check-status').textContent, /Checklist saved on this device/);
    assert.equal(h.saved().plan.contact, 'New contact');
  }
  // An unreadable embedded copy skips the device read; that record must survive a tick as well.
  const seed = harness({ embedded: { ...plan('Seed'), version: 2 }, stored: plan('Device plan') });
  assert.match(seed.element('plan-status').textContent, /saved copy could not be read/);
  seed.boxes[0].checked = true;
  seed.boxes[0].dispatch('change');
  assert.equal(seed.saved().plan.contact, 'Device plan');
  // The device record was never read there, so the message does not say that it was unreadable.
  assert.equal(
    seed.element('check-status').textContent,
    'Checklist changed here but could not be saved. Download a copy to keep it.',
  );
});

test('a checklist change never stores a save time the kit would later reject', () => {
  const h = harness({ stored: plan('Saved contact'), clock: Date.UTC(1970, 0, 1, 0, 30) });
  assert.equal(h.element('contact').value, 'Saved contact');
  const before = h.raw();
  h.boxes[3].checked = true;
  h.boxes[3].dispatch('change');
  assert.match(h.element('check-status').textContent, /could not be saved/);
  assert.equal(h.raw(), before);
});

test('a checklist tick in one open copy keeps the plan and ticks saved in another copy', () => {
  const shared = { value: null as string | null };
  const first = harness({ shared }); // opened earlier, before anything was saved
  const second = harness({ shared });
  second.element('contact').value = 'Asha';
  second.element('phone').value = '+91 90000 00000';
  second.element('meeting').value = 'School gate';
  second.boxes[0].checked = true;
  second.element('plan-form').dispatch('submit');
  first.boxes[1].checked = true;
  first.boxes[1].dispatch('change');
  const saved = JSON.parse(shared.value!);
  assert.equal(saved.plan.contact, 'Asha', 'the plan saved in the other copy is kept');
  assert.equal(saved.plan.meeting, 'School gate');
  assert.deepEqual(saved.checked, ['radio', 'charge'], 'ticks from both copies are kept');
  assert.equal(
    first.element('check-status').textContent,
    'Checklist saved on this device. Plan edits still need Save.',
  );
  // That copy had no unsaved edits, so it now shows the plan it saved with the tick.
  assert.equal(first.element('contact').value, 'Asha');
  assert.equal(first.boxes[0].checked, true);
  assert.equal(first.element('check-count').textContent, '2 of 6 preparations checked');
  assert.match(first.element('plan-status').textContent, /Loaded your latest saved plan/);
  assert.equal(first.element('call-contact').href, 'tel:+919000000000');
  // Unsaved edits are never replaced by another copy's plan, and a tick does not save them.
  first.element('notes').value = 'Unsaved note';
  second.element('contact').value = 'Ravi';
  second.element('plan-form').dispatch('submit');
  first.boxes[2].checked = true;
  first.boxes[2].dispatch('change');
  assert.equal(JSON.parse(shared.value!).plan.contact, 'Ravi');
  assert.equal(JSON.parse(shared.value!).plan.notes, '');
  assert.equal(first.element('notes').value, 'Unsaved note');
  assert.equal(first.element('contact').value, 'Asha');
  assert.match(first.element('plan-status').textContent, /Another window saved a different plan/);
  first.element('plan-form').dispatch('submit');
  assert.equal(JSON.parse(shared.value!).plan.notes, 'Unsaved note', 'Save still decides');
});

test('a downloaded copy with a newer plan than device storage keeps saving its own plan with a tick', () => {
  const h = harness({
    embedded: { ...plan('Downloaded contact'), savedAt: now },
    stored: plan('Older device plan'),
  });
  assert.equal(h.element('contact').value, 'Downloaded contact');
  h.boxes[3].checked = true;
  h.boxes[3].dispatch('change');
  assert.equal(h.saved().plan.contact, 'Downloaded contact');
  assert.deepEqual(h.saved().checked, ['radio', 'contacts', 'copy']);
});

// The preparedness guide, a static page beside the kit, keeps its checklist in device storage too.
const preparednessHtml = readFileSync('public/preparedness.html', 'utf8');
const preparednessSource = preparednessHtml.match(/<script>([\s\S]*?)<\/script>/)![1];
const preparednessIds = [
  'official',
  'radio',
  'charge',
  'contact',
  'transport',
  'needs',
  'water',
  'medicine',
  'documents',
  'printout',
  'outside',
  'recheck',
];

// One open copy of the preparedness guide; copies opened with the same `shared` share device
// storage. While `shared.full` is set every write fails, as with a full quota; reads still work.
function openPreparedness(
  shared: { value: string | null; full?: boolean },
  { blocked = false } = {},
) {
  const boxes = preparednessIds.map((id) => ({ id, checked: false }));
  const listeners: Record<string, (event: unknown) => void> = {};
  const on = (name: string) => ({
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[`${name}:${type}`] = listener;
    },
  });
  const nodes: Record<string, any> = {
    count: { textContent: '' },
    progress: { style: {} },
    'storage-note': { textContent: '' },
    checklist: on('checklist'),
    print: on('print'),
    reset: on('reset'),
  };
  const guard = () => {
    if (blocked) throw Error('Storage blocked');
  };
  const write = () => {
    guard();
    if (shared.full) throw Error('QuotaExceededError');
  };
  vm.runInNewContext(preparednessSource, {
    document: { querySelectorAll: () => boxes, getElementById: (id: string) => nodes[id] },
    localStorage: {
      getItem: () => (guard(), shared.value),
      setItem: (_key: string, value: string) => (write(), (shared.value = value)),
      removeItem: () => (guard(), (shared.value = null)),
    },
    window: { print() {}, confirm: () => true },
    navigator: {},
  });
  return {
    boxes,
    nodes,
    ticked: () => boxes.filter((box) => box.checked).map((box) => box.id),
    tick(index: number, checked = true) {
      boxes[index].checked = checked;
      listeners['checklist:change']({ target: boxes[index] });
    },
    reset: () => listeners['reset:click']({}),
  };
}

test('a preparedness tick in one open copy keeps the ticks saved in another copy', () => {
  const shared = { value: null as string | null };
  const first = openPreparedness(shared);
  const second = openPreparedness(shared);
  second.tick(0);
  first.tick(1);
  assert.deepEqual(JSON.parse(shared.value!), ['official', 'radio']);
  assert.equal(first.boxes[0].checked, true, "the other copy's tick now shows here too");
  assert.equal(first.nodes.count.textContent, '2 of 12 preparations checked');
  second.tick(0, false);
  first.tick(2);
  assert.deepEqual(JSON.parse(shared.value!), ['radio', 'charge'], 'an untick there is kept');
  second.reset();
  first.tick(3);
  assert.deepEqual(JSON.parse(shared.value!), ['contact'], 'a reset there is respected');
});

test('preparedness ticks that could not be saved stay on the page, so a print still shows them', () => {
  for (const saved of [null, JSON.stringify(['water'])]) {
    const shared = { value: saved, full: true };
    const page = openPreparedness(shared);
    page.tick(0);
    page.tick(1);
    const water = saved ? ['water'] : [];
    assert.deepEqual(page.ticked(), ['official', 'radio', ...water], `saved: ${saved}`);
    assert.equal(page.nodes.count.textContent, `${2 + water.length} of 12 preparations checked`);
    assert.match(page.nodes['storage-note'].textContent, /selections are not saved/);
    assert.equal(shared.value, saved, 'nothing was written');
    // Once a write succeeds again, every tick on the page is saved.
    shared.full = false;
    page.tick(2);
    assert.deepEqual(JSON.parse(shared.value!), ['official', 'radio', 'charge', ...water]);
  }
});

test('unreadable saved preparedness ticks are replaced, and blocked storage is reported', () => {
  const corrupt = { value: '{' };
  openPreparedness(corrupt).tick(4);
  assert.deepEqual(JSON.parse(corrupt.value!), ['transport']);
  const blocked = openPreparedness({ value: null }, { blocked: true });
  blocked.tick(5);
  assert.match(blocked.nodes['storage-note'].textContent, /storage is unavailable/);
  assert.equal(blocked.boxes[5].checked, true, 'the tick stays on the page');
});

// A waiting worker activates only when every open same-origin window answers its safety check.
// These static pages never load the app updater, and an update never reloads them, so they answer
// themselves instead of holding back every update while they are open.
const staticPages = ['public/offline.html', 'public/preparedness.html', 'public/404.html'];
const version = 'a'.repeat(64);
const nonce = 'b'.repeat(32);
const origin = 'https://app.example';
type Port = { postMessage(value: unknown): void };

// Any element a page script asks for: enough for its start-up code to run.
function anyElement(): any {
  const node: Record<string, unknown> = {
    value: '',
    textContent: '',
    checked: false,
    hidden: false,
    style: {},
    classList: { toggle() {} },
  };
  return new Proxy(node, {
    get: (target, key) => (key in target ? target[key as string] : () => anyElement()),
  });
}

function openStaticPage(file: string) {
  const page = readFileSync(file, 'utf8');
  const listeners: ((event: unknown) => void)[] = [];
  const source = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => !/application\/json/.test(attributes))
    .map(([, , body]) => body)
    .join('\n');
  vm.runInNewContext(source, {
    document: {
      getElementById: anyElement,
      querySelector: anyElement,
      querySelectorAll: () => [],
      createElement: anyElement,
    },
    window: { addEventListener() {}, print() {}, confirm: () => false },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {
      serviceWorker: {
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          if (type === 'message') listeners.push(listener);
        },
      },
    },
    location: { origin },
  });
  return {
    deliver(data: unknown, port: Port) {
      for (const listener of listeners) listener({ data, origin, ports: [port] });
    },
    ask(data: unknown) {
      const replies: unknown[] = [];
      this.deliver(data, { postMessage: (value) => replies.push(value) });
      return plain(replies);
    },
  };
}

test('static pages answer the app-update safety check, because an update never reloads them', () => {
  for (const file of staticPages) {
    const page = openStaticPage(file);
    assert.deepEqual(
      page.ask({ type: 'APP_UPDATE_CAN_ACTIVATE', nonce, version }),
      [{ type: 'APP_UPDATE_SAFETY', nonce, safe: true }],
      file,
    );
    for (const data of [
      { type: 'APP_UPDATE_CAN_ACTIVATE', nonce: 'not-a-nonce', version },
      { type: 'GET_APP_UPDATE_STATUS', nonce },
      null,
    ])
      assert.deepEqual(page.ask(data), [], `${file}: ${JSON.stringify(data)}`);
  }
});

test('an open kit, preparedness or 404 page no longer holds back worker activation', async () => {
  for (const file of staticPages) {
    const page = openStaticPage(file);
    let skips = 0;
    let handler: ((event: unknown) => void) | undefined;
    const dashboard = {
      id: 'dashboard',
      url: `${origin}/`,
      postMessage: (message: { nonce: string }, ports: Port[]) =>
        ports[0].postMessage({ type: 'APP_UPDATE_SAFETY', nonce: message.nonce, safe: true }),
    };
    const staticPage = {
      id: 'static',
      url: `${origin}/${file.replace('public/', '')}`,
      postMessage: (message: unknown, ports: Port[]) => page.deliver(message, ports[0]),
    };
    vm.runInNewContext(workerUpdateProtocolSource({ readyExpression: 'complete()' }), {
      URL,
      MessageChannel,
      clearTimeout,
      setTimeout: (run: () => void) => setTimeout(run, 15),
      APP_VERSION: version,
      complete: () => true,
      self: {
        registration: { scope: `${origin}/` },
        addEventListener: (_type: string, listener: (event: unknown) => void) =>
          (handler = listener),
        skipWaiting: async () => {
          skips++;
        },
        clients: { matchAll: async () => [dashboard, staticPage] },
      },
    });
    let waiting: Promise<unknown> | undefined;
    let result: { accepted?: boolean } = {};
    handler!({
      source: { id: 'dashboard', url: `${origin}/` },
      data: { type: 'ACTIVATE_APP_UPDATE', version, nonce },
      ports: [{ postMessage: (value: { accepted?: boolean }) => (result = value) }],
      waitUntil: (value: Promise<unknown>) => (waiting = value),
    });
    await waiting;
    assert.equal(result.accepted, true, file);
    assert.equal(skips, 1, file);
  }
});

// A page that declares no icon makes the browser request /favicon.ico, which is not shipped:
// a 404 in the console online, and a failed request offline.
test('every shipped page declares an icon that exists', () => {
  for (const file of [
    'index.html',
    'resources/index.html',
    'public/preparedness.html',
    'public/404.html',
    'public/offline.html',
  ]) {
    const link = readFileSync(file, 'utf8').match(/<link\b[^>]*\brel="icon"[^>]*>/i)?.[0];
    assert.ok(link, `${file} declares no icon, so browsers request the unshipped /favicon.ico`);
    const href = link.match(/\bhref="([^"]+)"/)![1];
    if (href.startsWith('data:'))
      assert.match(href, /^data:image\/svg\+xml,%3Csvg\S+%3C%2Fsvg%3E$/, file);
    else {
      assert.match(href, /^\/[\w-]+\.svg$/, file);
      assert.ok(existsSync(`public${href}`), `${file}: public${href} is not shipped`);
    }
  }
});

test('the kit carries the site icon inline, so a downloaded copy needs no other file', () => {
  const href = html.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)">/)?.[1];
  assert.ok(href);
  assert.equal(
    decodeURIComponent(href.slice('data:image/svg+xml,'.length)),
    readFileSync('public/favicon.svg', 'utf8').trim(),
  );
});
