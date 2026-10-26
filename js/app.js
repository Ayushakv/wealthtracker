import { Store } from './store/store.js';
import { toast } from './ui/dom.js';
import { html, setHTML } from './ui/html.js';
import { icon } from './ui/icons.js';
import { assetsView } from './views/assets.js';
import { dashboardView } from './views/dashboard.js';
import { detailView } from './views/detail.js';
import { formView } from './views/form.js';
import { errorView, lockView, welcomeView } from './views/gate.js';
import { ratesView } from './views/rates.js';
import { settingsView } from './views/settings.js';

/** Pull fresh NAVs when the app comes back after this long. */
const STALE_MS = 30 * 60 * 1000;

const ROUTES = [
  { pattern: /^\/dashboard$/, view: dashboardView, tab: 'dashboard' },
  { pattern: /^\/assets$/, view: assetsView, tab: 'assets' },
  { pattern: /^\/asset\/([^/]+)$/, params: ['id'], view: detailView, tab: 'assets' },
  { pattern: /^\/asset\/([^/]+)\/edit$/, params: ['id'], view: formView, tab: 'assets' },
  { pattern: /^\/new\/([^/]+)$/, params: ['slug'], view: formView, tab: 'assets' },
  { pattern: /^\/settings$/, view: settingsView, tab: 'settings' },
  { pattern: /^\/settings\/rates$/, view: ratesView, tab: 'settings' },
];

const GATES = { welcome: welcomeView, locked: lockView, error: errorView, loading: { render: () => '' } };

const TABS = [
  { id: 'dashboard', href: '#/dashboard', icon: 'pie', label: 'Net Worth' },
  { id: 'assets', href: '#/assets', icon: 'list', label: 'Assets' },
  { id: 'settings', href: '#/settings', icon: 'gear', label: 'Settings' },
];

/** Actions any view can use. */
const GLOBAL_ACTIONS = {
  refresh: (_, { store }) => store.refresh(),
};

const store = new Store();
const main = document.getElementById('main');
const nav = document.getElementById('tabs');

/** What's on screen: { key, view, params, state, tab, cleanup }. `state` lives as long as the route does. */
let shown = null;

// MARK: - Routing

function resolve() {
  if (store.status !== 'ready') return { key: `gate:${store.status}`, view: GATES[store.status], params: {}, tab: null };
  const path = location.hash.replace(/^#/, '') || '/dashboard';
  for (const r of ROUTES) {
    const m = path.match(r.pattern);
    if (m) return { key: path, view: r.view, tab: r.tab, params: Object.fromEntries((r.params ?? []).map((p, i) => [p, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const depth = () => history.state?.depth ?? 0;

/** Moves to `hash`. `replace` swaps the current history entry instead of adding one. */
function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState({ depth: depth() }, '', hash);
    render();
  } else {
    location.hash = hash;
  }
}

/** Steps back if we got here from inside the app, otherwise replaces this page with `fallback`. */
function goBack(fallback) {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

window.addEventListener('hashchange', () => {
  // A link click adds an entry without state; number it so goBack knows it can step back.
  if (history.state == null) history.replaceState({ depth: (shown?.depth ?? 0) + 1 }, '');
  render();
});

// MARK: - Rendering

function context() {
  return { store, params: shown.params, state: shown.state, now: Date.now(), navigate, goBack, rerender: () => render({ force: true }) };
}

function renderTabs(active) {
  setHTML(
    nav,
    html`<span class="brand">${icon('rupee')} WealthTracker</span>
      ${TABS.map((t) => html`<a href="${t.href}" ${t.id === active ? html`aria-current="page"` : ''}>${icon(t.icon)}<span>${t.label}</span></a>`)}`,
  );
}

/**
 * Draws the current route. Store changes re-render in place, except for views that hold
 * typing in progress (forms, the passcode screens), which keep their DOM until the route changes.
 */
function render({ fromStore = false, force = false } = {}) {
  const target = resolve();
  if (!target) return navigate('#/dashboard', { replace: true });
  const same = shown?.key === target.key;
  const isGate = !target.tab;
  if (same && fromStore && !force && (target.view.keepOnChange || isGate)) return;

  const openDetails = same ? [...main.querySelectorAll('details.breakdown')].map((d) => d.open) : [];
  const firstPage = !shown || shown.key.startsWith('gate:');
  shown?.cleanup?.();
  shown = { ...target, state: same ? shown.state : {}, depth: depth(), cleanup: null };
  const ctx = context();

  document.body.classList.toggle('gated', isGate);
  if (!same) renderTabs(target.tab);
  const title = target.view.titleFor?.(ctx) ?? target.view.title;
  document.title = title ? `${title} · WealthTracker` : 'WealthTracker';

  setHTML(main, target.view.render(ctx));
  main.querySelectorAll('details.breakdown').forEach((d, i) => (d.open = openDetails[i] ?? false));

  if (!same) {
    window.scrollTo(0, 0);
    // Move focus to the new page's heading so screen readers announce it.
    const h1 = main.querySelector('h1');
    if (h1 && !firstPage && !isGate) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  }
  shown.cleanup = target.view.mount?.(main, ctx) ?? null;
}

async function run(fn) {
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(e?.message ?? String(e), { kind: 'error', duration: 6000 });
  }
}

// MARK: - Event delegation (views declare actions / changes / submits; see views/*.js)

main.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || !shown) return;
  const handler = shown.view.actions?.[el.dataset.action] ?? GLOBAL_ACTIONS[el.dataset.action];
  if (!handler) return;
  e.preventDefault();
  run(() => handler(el, context()));
});

main.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  const handler = el && shown?.view.changes?.[el.dataset.change];
  if (handler) run(() => handler(el, context()));
});

main.addEventListener('submit', (e) => {
  const form = e.target;
  const handler = shown?.view.submits?.[form.dataset.form];
  if (!handler) return;
  e.preventDefault();
  run(() => handler(form, context()));
});

// MARK: - App lifecycle

let lastStatus = store.status;
store.addEventListener('change', () => {
  // Locking or unlocking always redraws, and drops anything a view kept in memory.
  if (store.status !== lastStatus) {
    lastStatus = store.status;
    shown = null;
    return render();
  }
  render({ fromStore: true });
});

document.addEventListener('visibilitychange', () => {
  store.noteVisibility(document.hidden);
  if (!document.hidden && store.status === 'ready' && Date.now() - (store.settings.lastRefresh ?? 0) > STALE_MS) store.refresh();
});

window.addEventListener('online', () => {
  render({ fromStore: true });
  store.refresh();
});
window.addEventListener('offline', () => render({ fromStore: true }));

async function registerServiceWorker() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  const reg = await sw.register('sw.js');
  const hadController = !!sw.controller;
  const offer = (worker) =>
    toast('A new version is ready.', { action: { label: 'Reload', run: () => worker.postMessage('skip-waiting') }, duration: Infinity });
  if (reg.waiting && hadController) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && sw.controller) offer(worker);
    });
  });
  // Reload once the new version takes over (but not on the very first install).
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reg.update().catch(() => {});
  });
}

if (history.state == null) history.replaceState({ depth: 0 }, '');
render();
store.open();
registerServiceWorker().catch((e) => console.warn('Service worker not registered:', e));
