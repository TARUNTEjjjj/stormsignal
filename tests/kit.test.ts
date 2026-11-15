import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('public/offline.html', 'utf8');
const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
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
  assert.doesNotMatch(html, /<script[^>]+src=|<link|<(?:img|iframe|video|audio)[\s>]|@import/i);
  assert.doesNotMatch(html.match(/<style>([\s\S]*?)<\/style>/)![1], /url\s*\(/i);
  assert.doesNotMatch(
    coreSource + uiSource,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|serviceWorker)\b/,
  );
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
  for (const value of [
    null,
    [],
    {},
    { ...plan(), version: 2 },
    { ...plan(), plan: [] },
    { ...plan(), plan: { ...plan().plan, notes: 'x'.repeat(1201) } },
    { ...plan(), plan: { ...plan().plan, contact: '\u0000' } },
    { ...plan(), plan: { ...plan().plan, phone: 123 } },
    { ...plan(), checked: ['radio', 'radio'] },
    { ...plan(), checked: ['unknown'] },
    { ...plan(), savedAt: now + 600000 },
    { ...plan(), savedAt: 1 },
  ]) {
    assert.throws(() => core.normalize(value, now), JSON.stringify(value).slice(0, 100));
  }
  assert.throws(() => core.parse(' '.repeat(12001)));
  assert.throws(() => core.parse('{incomplete'));
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
  options: { stored?: unknown; embedded?: unknown; blocked?: boolean; clock?: number } = {},
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
  let stored =
    options.stored === undefined
      ? null
      : typeof options.stored === 'string'
        ? options.stored
        : JSON.stringify(options.stored);
  const document = {
    getElementById: (id: string) => elements.get(id),
    querySelectorAll: () => boxes,
    querySelector: (selector: string) => ({ textContent: selector }),
    createElement: () => new Node(),
  };
  const localStorage = {
    getItem: () => {
      if (options.blocked) throw Error('Storage blocked');
      return stored;
    },
    setItem: (_key: string, value: string) => {
      if (options.blocked) throw Error('Storage blocked');
      stored = value;
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
    raw: () => stored,
    saved: () => (stored === null ? null : JSON.parse(stored)),
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
  await h
    .element('import-plan')
    .dispatch('change', {
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
  await h
    .element('import-plan')
    .dispatch('change', { target: { files: [{ size: 13000, text: async () => '{}' }], value: 'bad.json' } });
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
