import {
  openLocal, startSync, resolveConflicts, resolveTemplateConflicts,
  loadAll, saveDay, saveTodo, saveLedger, saveTemplate, getSession, login,
} from './db.js';
import { mergeDayDocs, mergeTodoDocs } from './conflicts.js';
import { dowOf, currentBlock } from './clock.js';
import { blocksFor, resolveBlocks } from './schedule.js';
import {
  emptyDay, assertWritable, applyBlockToggle, applyCheckToggle, setBranch, spend,
  setBlocksOverride, clearBlocksOverride,
  LockedDayError, InsufficientCoinsError, CheckNotActiveError,
  nudgeSleep, nudgeWake, clearSleepOverride, clearWakeOverride,
} from './actions.js';
import {
  addCheck as addCheckTo, updateCheck as updateCheckIn,
  retireCheck as retireCheckIn, migrateDedicatedTasks, addTask as addTaskTo,
} from './template-edit.js';
import { putBlockList, toOverride } from './block-edit.js';
import { el, clear } from './ui/render.js';

import { render as renderNow } from './ui/now.js';
import { render as renderDay } from './ui/day.js';
import { render as renderCoins } from './ui/coins.js';
import { render as renderCampaign } from './ui/campaign.js';
import { render as renderStreaks } from './ui/streaks.js';
import { render as renderChecks } from './ui/checks.js';
import { render as renderBlocks } from './ui/blocks.js';
import { newTodo, toggleDone, togglePin, edit as editTodoDoc, remove as removeTodoDoc }
  from './todos.js';
import { render as renderTodos } from './ui/todos.js';

// hidden screens are routable but get no tab button. The bar is already several
// wide on a phone, and --tap is 48px; more entries would push the buttons below
// a reliable thumb target. Sub-project B reuses this for #/blocks.
const SCREENS = {
  now: { label: 'Now', render: renderNow },
  day: { label: 'Day', render: renderDay },
  todos: { label: 'Todos', render: renderTodos },
  coins: { label: 'Coins', render: renderCoins },
  campaign: { label: 'Sermon', render: renderCampaign },
  streaks: { label: 'Streaks', render: renderStreaks },
  checks: { label: 'Checks', render: renderChecks, hidden: true },
  blocks: { label: 'Blocks', render: renderBlocks, hidden: true },
};

// The single place the real clock is read. Overridable from the console so any
// screen can be inspected at any time of day: window.__schedule.freeze('14:30').
let clockOverride = null;

function realNow() {
  return clockOverride ?? new Date();
}

// Asia/Manila is the device timezone, so local parts are the right parts. This
// is deliberately not a UTC conversion: 23:30 local on the 10th must be the
// 10th, and toISOString would call it the 11th.
function dateStrOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeStrOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rand() {
  return Math.random().toString(36).slice(2, 8);
}

const state = {
  local: null,
  template: null,
  campaign: null,
  days: [],
  ledger: [],
  todos: [],
  today: null,
  hhmm: null,
  now: null,
  route: 'now',
  status: 'offline',
  error: null,
};

export function getState() { return state; }

function dayFor(dateStr) {
  return state.days.find(d => d.date === dateStr) ?? null;
}

function ensureDay(dateStr) {
  return dayFor(dateStr) ?? emptyDay(dateStr, dowOf(dateStr));
}

// Every mutation goes through here: assert the day is writable, apply the pure
// function, persist the document and any ledger entries, re-render.
async function mutateDay(dateStr, fn) {
  state.error = null;
  try {
    assertWritable(dateStr, state.today, state.template.backfillDays);
    const before = ensureDay(dateStr);
    const { doc, ledgerEntries = [] } = fn(before);
    const saved = await saveDay(state.local, doc);
    await saveLedger(state.local, ledgerEntries);
    state.days = [...state.days.filter(d => d.date !== dateStr), saved];
    state.ledger = [...state.ledger, ...ledgerEntries];
  } catch (err) {
    if (err instanceof LockedDayError) {
      state.error = `${dateStr} is locked. The backfill window is ${state.template.backfillDays} days.`;
    } else if (err instanceof CheckNotActiveError) {
      state.error = `That check did not apply on ${dateStr}.`;
    } else {
      state.error = err.message;
    }
  }
  paint();
}

// The template twin of mutateDay. There is no writability assertion because the
// template is not date scoped: nothing about it can be locked by the backfill
// window. Everything else is the same shape, so both write paths fail the same
// way and report through the same banner.
async function mutateTemplate(fn) {
  state.error = null;
  let result = null;
  try {
    const { template, ...rest } = fn(state.template);
    state.template = await saveTemplate(state.local, template);
    result = rest;
  } catch (err) {
    state.error = err.message;
  }
  paint();
  return result;
}

// The todo twin of mutateDay. Deliberately without assertWritable: todos float
// free of dates, so the backfill lock has nothing to check. See src/todos.js.
async function mutateTodo(id, fn) {
  state.error = null;
  try {
    const before = state.todos.find(t => t._id === id);
    if (!before) throw new Error(`unknown todo: ${id}`);
    const saved = await saveTodo(state.local, fn(before));
    state.todos = saved
      ? [...state.todos.filter(t => t._id !== id), saved]
      : state.todos.filter(t => t._id !== id);
  } catch (err) {
    state.error = err.message;
  }
  paint();
}

const actions = {
  toggleBlock: (dateStr, blockId, done) => mutateDay(dateStr, (doc) => applyBlockToggle({
    template: state.template,
    blocks: resolveBlocks(state.template, dowOf(dateStr), doc.branch, doc),
    doc, blockId, done,
    at: state.now.toISOString(), rand: rand(), ledger: state.ledger,
  })),

  toggleCheck: (dateStr, checkId, done) => mutateDay(dateStr, (doc) =>
    applyCheckToggle({ template: state.template, doc, checkId, done,
                       at: state.now.toISOString(), rand: rand(), ledger: state.ledger })),

  setBranch: (dateStr, branch) => mutateDay(dateStr, (doc) =>
    setBranch({ doc, branch, at: state.now.toISOString() })),

  addTodo: async ({ text, note, due }) => {
    state.error = null;
    try {
      const doc = newTodo({ text, note, due, ts: state.now.toISOString(), rand: rand() });
      const saved = await saveTodo(state.local, doc);
      state.todos = [...state.todos, saved];
    } catch (err) {
      state.error = err.message;
    }
    paint();
  },

  setTodoDone: (id, done) => mutateTodo(id, (doc) =>
    toggleDone(doc, { done, at: state.now.toISOString() })),

  setTodoPinned: (id, pinned) => mutateTodo(id, (doc) =>
    togglePin(doc, { pinned, at: state.now.toISOString() })),

  editTodo: (id, { text, note, due }) => mutateTodo(id, (doc) =>
    editTodoDoc(doc, { text, note, due, at: state.now.toISOString() })),

  deleteTodo: (id) => mutateTodo(id, (doc) =>
    removeTodoDoc(doc, { at: state.now.toISOString() })),

  nudgeSleep: (dateStr, deltaMinutes) => mutateDay(dateStr, (doc) =>
    nudgeSleep({ doc, deltaMinutes, template: state.template, at: state.now.toISOString() })),

  nudgeWake: (dateStr, deltaMinutes) => mutateDay(dateStr, (doc) =>
    nudgeWake({ doc, deltaMinutes, template: state.template, at: state.now.toISOString() })),

  clearSleep: (dateStr) => mutateDay(dateStr, (doc) =>
    clearSleepOverride({ doc, at: state.now.toISOString() })),

  clearWake: (dateStr) => mutateDay(dateStr, (doc) =>
    clearWakeOverride({ doc, at: state.now.toISOString() })),

  buy: async (shopId) => {
    state.error = null;
    try {
      const { ledgerEntries } = spend({
        template: state.template, ledger: state.ledger, shopId,
        date: state.today, at: state.now.toISOString(), rand: rand(),
      });
      await saveLedger(state.local, ledgerEntries);
      state.ledger = [...state.ledger, ...ledgerEntries];
    } catch (err) {
      state.error = err instanceof InsufficientCoinsError
        ? `Not enough coins. ${err.message}.` : err.message;
    }
    paint();
  },

  undo: async (entry) => {
    const { undoEntry } = await import('./ledger.js');
    const compensating = undoEntry(entry, { ts: state.now.toISOString(), rand: rand() });
    await saveLedger(state.local, [compensating]);
    state.ledger = [...state.ledger, compensating];
    paint();
  },

  addCheck: ({ label, attribute, coins, activeFrom, streakDays }) =>
    mutateTemplate((template) => addCheckTo({
      template, label, attribute, coins, activeFrom, streakDays,
      today: state.today, at: state.now.toISOString(),
    })),

  updateCheck: ({ checkId, label, attribute, coins }) =>
    mutateTemplate((template) => updateCheckIn({
      template, checkId, label, attribute, coins, at: state.now.toISOString(),
    })),

  retireCheck: ({ checkId, retiredOn }) =>
    mutateTemplate((template) => retireCheckIn({
      template, checkId, retiredOn, at: state.now.toISOString(),
    })),

  // Template scope: this changes every Tuesday, not one of them.
  saveBlockList: ({ dow, branch, blocks }) =>
    mutateTemplate((template) => putBlockList({
      template, dow, branch, blocks,
      at: state.now.toISOString(), today: state.today,
    })),

  // Date scope. Routing through mutateDay is what gives an override
  // assertWritable for free: a day past the backfill window cannot be
  // overridden, and a future day can be, because daysBetween is signed.
  saveBlockOverride: ({ dateStr, blocks }) => mutateDay(dateStr, (doc) => setBlocksOverride({
    doc, blocksOverride: toOverride(state.template, blocks), at: state.now.toISOString(),
  })),

  clearBlockOverride: ({ dateStr }) => mutateDay(dateStr, (doc) =>
    clearBlocksOverride({ doc, at: state.now.toISOString() })),

  addTask: async ({ label, attribute, coins }) => {
    const out = await mutateTemplate((template) => addTaskTo({
      template, label, attribute, coins, at: state.now.toISOString(),
    }));
    return out?.taskId ?? null;
  },

  go: (route) => { window.location.hash = `#/${route}`; },
  repaint: () => paint(),
  dayFor,
};

function chrome(body) {
  const nav = el('nav', { class: 'tabs' }, Object.entries(SCREENS)
    .filter(([, screen]) => !screen.hidden)
    .map(([key, screen]) =>
      el('button', {
        class: key === state.route ? 'tab active' : 'tab',
        text: screen.label,
        onclick: () => actions.go(key),
      })));

  const bar = el('header', { class: 'bar' }, [
    el('span', { class: `status ${state.status}`, text: state.status }),
    el('span', { class: 'clock', text: state.hhmm }),
  ]);

  const err = state.error ? el('p', { class: 'error', text: state.error }) : null;
  // Element.append() stringifies any non-Node argument, so a bare null here
  // would render as the literal text "null" rather than being skipped. Filter
  // before returning rather than relying on every call site to remember.
  return [bar, err, body, nav].filter(Boolean);
}

// The branch prompt is a hard gate, not a banner: a branching day with no branch
// chosen cannot render a schedule, because there are two different schedules.
function branchPrompt(dateStr) {
  return el('section', { class: 'prompt' }, [
    el('h1', { text: 'Class today?' }),
    el('p', { text: 'Monday and Wednesday run two different days. Pick one.' }),
    el('div', { class: 'row' }, [
      el('button', { class: 'big', text: 'Yes, going to campus',
                     onclick: () => actions.setBranch(dateStr, 'A') }),
      el('button', { class: 'big secondary', text: 'No, working from home',
                     onclick: () => actions.setBranch(dateStr, 'B') }),
    ]),
  ]);
}

function paint() {
  const root = clear(document.getElementById('app'));

  if (!state.template) {
    root.append(el('section', { class: 'prompt' }, [
      el('h1', { text: 'No schedule template' }),
      el('p', { text: 'Run scripts/seed.py to write schedule:v1, then reload.' }),
    ]));
    return;
  }

  const today = ensureDay(state.today);
  const branching = state.template.days[dowOf(state.today)].branching;
  if (branching && !today.branch) {
    root.append(...chrome(branchPrompt(state.today)));
    return;
  }

  const screen = SCREENS[state.route] ?? SCREENS.now;
  root.append(...chrome(screen.render(state, actions)));
}

function tick() {
  state.now = realNow();
  state.today = dateStrOf(state.now);
  state.hhmm = timeStrOf(state.now);
}

async function reload() {
  const data = await loadAll(state.local);
  state.template = data.template;
  state.campaign = data.campaign;
  state.days = data.days;
  state.ledger = data.ledger;
  state.todos = data.todos;
}

async function boot() {
  const session = await getSession();
  if (!session.ok) {
    renderLogin();
    return;
  }

  state.local = openLocal();
  tick();
  await reload();
  paint();

  await resolveConflicts(state.local, 'day:', mergeDayDocs);
  await resolveConflicts(state.local, 'todo:', mergeTodoDocs);
  await resolveTemplateConflicts(state.local);

  // One shot and idempotent: after the split no check shares a task with a
  // block, so every later boot finds nothing and writes nothing. Skipped while
  // the template is still null: on a fresh install the local database has not
  // synced schedule:v1 yet, and dereferencing it here would abort boot before
  // startSync() below runs, leaving the app stuck on the empty state forever.
  if (state.template) {
    const migrated = migrateDedicatedTasks(state.template, state.now.toISOString());
    if (migrated.changed) {
      state.template = await saveTemplate(state.local, migrated.template);
      paint();
    }
  }

  startSync(state.local, async (status) => {
    state.status = status;
    if (status === 'synced') {
      await resolveConflicts(state.local, 'day:', mergeDayDocs);
      await resolveConflicts(state.local, 'todo:', mergeTodoDocs);
      await resolveTemplateConflicts(state.local);
      await reload();
    }
    paint();
  });

  window.addEventListener('hashchange', () => {
    state.route = window.location.hash.replace('#/', '') || 'now';
    paint();
  });
  state.route = window.location.hash.replace('#/', '') || 'now';

  // A minute is the finest granularity anything on screen displays.
  //
  // paint() rebuilds the screen from scratch, which is harmless for a screen made
  // of text and buttons but destroys a half-typed todo and drops focus mid-word.
  // Module-level draft state in ui/todos.js survives the rebuild; the caret does
  // not. So skip the periodic repaint entirely while a field is focused. Nothing
  // on the Todos screen is time-sensitive, and every real state change calls
  // paint() directly anyway.
  setInterval(() => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    tick(); paint();
  }, 30_000);

  window.__schedule = {
    state,
    actions,
    freeze: (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      const d = new Date(state.now);
      d.setHours(h, m, 0, 0);
      clockOverride = d;
      tick(); paint();
    },
    unfreeze: () => { clockOverride = null; tick(); paint(); },
  };
}

// Caches the app shell so a reload works even with no network - without this
// the SPA's data (PouchDB/IndexedDB) survives offline fine, but the HTML/JS/CSS
// themselves are fetched fresh from CouchDB on every navigation, which fails
// offline. Registration failures (unsupported browser, non-secure context on a
// plain http:// LAN origin some browsers restrict SW to) are non-fatal - the
// app still works online, it just won't survive an offline reload.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.error('service worker registration failed:', err);
  });
}

function renderLogin() {
  const root = clear(document.getElementById('app'));
  const user = el('input', { type: 'text', placeholder: 'user', autocomplete: 'username' });
  const pass = el('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const msg = el('p', { class: 'error' });
  root.append(el('section', { class: 'prompt' }, [
    el('h1', { text: 'Sign in' }),
    user, pass, msg,
    el('button', {
      class: 'big', text: 'Sign in',
      onclick: async () => {
        if (await login(user.value, pass.value)) boot();
        else msg.textContent = 'Wrong username or password.';
      },
    }),
  ]));
}

boot();
registerServiceWorker();
