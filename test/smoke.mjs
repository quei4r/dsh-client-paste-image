/* Browser-side smoke test for dsh-client-paste-image client.js.
 * Loads the factory through a mocked __ModuleLoader__, runs apply(ctx, config)
 * with a mocked cordis ctx + modelDirectories service, then fires synthetic
 * paste events through the captured document listener and asserts behavior. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let captured = null;
const listeners = [];
const removed = [];
const fakeDoc = {
  createElement: (tag) => ({ tag, textContent: '', remove() {}, style: {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  body: { appendChild() {} },
  addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
  removeEventListener: (type, fn, capture) => removed.push({ type, fn, capture }),
  defaultView: {
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: (f) => f(),
    FileReader: class {
      readAsArrayBuffer() { /* gate tests never reach onload */ }
    },
  },
};
const fakeWin = { __ModuleLoader__: { load(m) { captured = m; } } };

const sandbox = {
  window: fakeWin,
  document: fakeDoc,
  fetch: async () => ({ ok: true, json: async () => ({ path: '/tmp/x/a1b2c3-pasted-img.png' }) }),
  AbortSignal: { timeout: () => null },
  FileReader: class { readAsArrayBuffer() { /* not needed for gate tests */ } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

if (!captured || captured.id !== 'dsh-client-paste-image') throw new Error('module not captured');
const exports_ = captured.factory((id) => {
  if (id === 'react') return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) };
  throw new Error('unexpected require: ' + id);
});
if (typeof exports_.apply !== 'function') throw new Error('no apply');
console.log('inject:', JSON.stringify(exports_.inject));

/* --- mocked cordis ctx --- */
function makeCtx(route) {
  const effects = [];
  const sessions = {
    selected: 'sess-1',
    scope: (id) => ({ id, emit() {}, get: () => undefined }),
  };
  const directories = {
    directoryFor: (id) => ({
      store: { getSnapshot: () => ({ current: route }) },
    }),
  };
  return {
    effect(fn) { effects.push(fn); return fn(); },
    get(name) { if (name === 'modelDirectories') return directories; return undefined; },
    sessions,
    inputTriggers: { registerSource() { return () => {}; } },
  };
}

function firePaste({ image = true, composer = true, alt = false } = {}) {
  let prevented = false;
  let stopped = false;
  const file = image ? { type: 'image/png' } : null;
  const ev = {
    altKey: alt,
    target: composer ? { closest: (sel) => (sel.includes('textarea') ? { isComposer: true } : null) } : { closest: () => null },
    clipboardData: { items: file ? [{ kind: 'file', type: 'image/png', getAsFile: () => file }] : [{ kind: 'string', type: 'text/plain' }] },
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
    stopImmediatePropagation() { stopped = true; },
  };
  for (const { fn } of listeners) fn(ev);
  return { prevented, stopped };
}

const cfg = { textOnlyRoutes: ['zai-coding-cn/glm-5.3', 'opencode-go/deepseek-*'] };
let pass = 0, fail = 0;
function check(name, cond) { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.error('  ✗ ' + name)); }

/* 1. config arrives via the SECOND apply argument — the original bug */
console.log('T1 text-only route (zai-coding-cn/glm-5.3) + composer image paste:');
listeners.length = 0;
exports_.apply(makeCtx({ provider: 'zai-coding-cn', model: 'glm-5.3' }), cfg);
{
  const r = firePaste();
  check('prevented', r.prevented);
  check('stopped', r.stopped);
}

/* 2. glob route matches */
console.log('T2 glob route (opencode-go/deepseek-v4-pro):');
listeners.length = 0;
exports_.apply(makeCtx({ provider: 'opencode-go', model: 'deepseek-v4-pro' }), cfg);
check('prevented', firePaste().prevented);

/* 3. vision-capable / unlisted route: zero side effects */
console.log('T3 unlisted vision route (opencode-go/minimax-m3):');
listeners.length = 0;
exports_.apply(makeCtx({ provider: 'opencode-go', model: 'minimax-m3' }), cfg);
check('NOT prevented', !firePaste().prevented);

/* 4. empty/missing config: fail-safe, never intercepts (the old broken behavior) */
console.log('T4 missing config ({}):');
listeners.length = 0;
exports_.apply(makeCtx({ provider: 'zai-coding-cn', model: 'glm-5.3' }), {});
check('NOT prevented', !firePaste().prevented);

/* 5. directory not yet loaded (current === null): fail-safe */
console.log('T5 directory current === null:');
listeners.length = 0;
exports_.apply(makeCtx(null), cfg);
check('NOT prevented', !firePaste().prevented);

/* 6. service absent: fail-safe */
console.log('T6 modelDirectories service missing:');
listeners.length = 0;
{
  const ctx = makeCtx({ provider: 'zai-coding-cn', model: 'glm-5.3' });
  ctx.get = () => undefined;
  exports_.apply(ctx, cfg);
  check('NOT prevented', !firePaste().prevented);
}

/* 7. Alt+paste bypasses */
console.log('T7 Alt+paste bypass:');
listeners.length = 0;
exports_.apply(makeCtx({ provider: 'zai-coding-cn', model: 'glm-5.3' }), cfg);
check('NOT prevented', !firePaste({ alt: true }).prevented);

/* 8. plain-text paste untouched */
console.log('T8 plain-text paste:');
check('NOT prevented', !firePaste({ image: false }).prevented);

/* 9. paste outside composer untouched */
console.log('T9 paste outside composer:');
check('NOT prevented', !firePaste({ composer: false }).prevented);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
