/* Browser-side smoke test for dsh-client-paste-image client.js (v0.3.0 wiring).
 * Loads the factory through a mocked __ModuleLoader__, runs apply(ctx) with a
 * mocked cordis ctx (slots + inputTriggers + sessions + modelDirectories) and a
 * mocked fetch that serves the host config bridge, seats the session probe the
 * way the real slots system would, then fires synthetic paste events through
 * the captured document listener and asserts behavior. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let captured = null;
const listeners = [];
const fakeDoc = {
  createElement: (tag) => ({ tag, textContent: '', remove() {}, style: {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  body: { appendChild() {} },
  addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
  removeEventListener: () => {},
  defaultView: {
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: (f) => f(),
    FileReader: class { readAsArrayBuffer() { /* gate tests never reach onload */ } },
  },
};
const fakeWin = { __ModuleLoader__: { load(m) { captured = m; } } };

const CONFIG = { textOnlyRoutes: ['zai-coding-cn/glm-5.3', 'opencode-go/deepseek-*'] };

const sandbox = {
  window: fakeWin,
  document: fakeDoc,
  fetch: async (url) => {
    if (String(url).startsWith('/plugin-paste-image-config')) {
      return { ok: true, json: async () => CONFIG };
    }
    return { ok: true, json: async () => ({ path: '/tmp/x/a1b2c3-pasted-img.png' }) };
  },
  AbortSignal: { timeout: () => null },
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

/* --- mocked cordis ctx: capture the slot registration --- */
const slotRegistrations = [];
function makeCtx(route) {
  const effects = [];
  return {
    effect(fn) { effects.push(fn); return fn(); },
    get(name) {
      if (name === 'modelDirectories') {
        return { directoryFor: () => ({ store: { getSnapshot: () => ({ current: route }) } }) };
      }
      return undefined;
    },
    sessions: {
      scope: (id) => ({ id, emit() {}, get: () => undefined }),
    },
    inputTriggers: { registerSource() { return () => {}; } },
    slots: {
      inject: (seat, registrar) => {
        if (seat !== 'conversation.input.left') throw new Error('unexpected seat: ' + seat);
        registrar(); // runs ctx.slots.register inside
        return () => {};
      },
      register: (info, component) => {
        slotRegistrations.push({ info, component });
        return { info, component };
      },
    },
  };
}

function seatSession(sessionId) {
  if (slotRegistrations.length === 0) throw new Error('probe never registered');
  const { info, component } = slotRegistrations[slotRegistrations.length - 1];
  const props = info.inject(sessionId); // what the slots system hands the component
  component(props); // function component: records sessionId, returns null
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

const settle = () => new Promise((r) => setTimeout(r, 0));

let pass = 0, fail = 0;
function check(name, cond) { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.error('  ✗ ' + name)); }

/* 0a. boot race: no session seated yet (home screen state) — must run
 *     FIRST because module state (currentSessionId/routesCache) persists
 *     across apply() in one factory instance, as in a real single activation. */
console.log('T0a no session seated (probe never ran):');
exports_.apply(makeCtx({ provider: 'zai-coding-cn', model: 'glm-5.3' }));
check('NOT prevented', !firePaste().prevented);

/* 0b. boot race: config fetch still in flight (paste before it resolves) */
console.log('T0b config fetch still in flight (no settle):');
seatSession('sess-1'); // seat BEFORE the config resolves
check('NOT prevented', !firePaste().prevented);
await settle(); await settle(); // now the bridge resolves for the cases below

/* 1. full chain: config fetched + session seated + text-only route */
console.log('T1 text-only route (zai-coding-cn/glm-5.3), config bridged, session seated:');
listeners.length = 0; slotRegistrations.length = 0;
exports_.apply(makeCtx({ provider: 'zai-coding-cn', model: 'glm-5.3' }));
await settle(); await settle(); // let loadRoutes resolve
seatSession('sess-1');
{
  const r = firePaste();
  check('prevented', r.prevented);
  check('stopped', r.stopped);
}

/* 2. glob route matches */
console.log('T2 glob route (opencode-go/deepseek-v4-pro):');
listeners.length = 0; slotRegistrations.length = 0;
exports_.apply(makeCtx({ provider: 'opencode-go', model: 'deepseek-v4-pro' }));
await settle(); await settle();
seatSession('sess-1');
check('prevented', firePaste().prevented);

/* 3. vision-capable / unlisted route: zero side effects */
console.log('T3 unlisted vision route (opencode-go/minimax-m3):');
listeners.length = 0; slotRegistrations.length = 0;
exports_.apply(makeCtx({ provider: 'opencode-go', model: 'minimax-m3' }));
await settle(); await settle();
seatSession('sess-1');
check('NOT prevented', !firePaste().prevented);

/* 6. directory not yet loaded (current === null): fail-safe */
console.log('T6 directory current === null:');
listeners.length = 0; slotRegistrations.length = 0;
exports_.apply(makeCtx(null));
await settle(); await settle();
seatSession('sess-1');
check('NOT prevented', !firePaste().prevented);

/* 7. modelDirectories service missing: fail-safe */
console.log('T7 modelDirectories service missing:');
listeners.length = 0; slotRegistrations.length = 0;
{
  const ctx = makeCtx({ provider: 'zai-coding-cn', model: 'glm-5.3' });
  ctx.get = () => undefined;
  exports_.apply(ctx);
  await settle(); await settle();
  seatSession('sess-1');
  check('NOT prevented', !firePaste().prevented);
}

/* 8. Alt+paste bypasses */
console.log('T8 Alt+paste bypass:');
check('NOT prevented', !firePaste({ alt: true }).prevented);

/* 9. plain-text paste untouched */
console.log('T9 plain-text paste:');
check('NOT prevented', !firePaste({ image: false }).prevented);

/* 10. paste outside composer untouched */
console.log('T10 paste outside composer:');
check('NOT prevented', !firePaste({ composer: false }).prevented);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
