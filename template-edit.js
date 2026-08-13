// The write side of the template. Every function here is pure: it takes a
// template and returns a new one, so app.js can persist the result and the
// tests can assert on it without a database.
//
// Two rules run through all of it. Nothing is ever deleted, because past day
// documents and ledger rows reference these ids and coinEffect throws when a
// taskId goes missing. And every entry that changes gets an updatedAt, because
// the conflict merge resolves the template entry by entry and cannot tell which
// side is newer without one.
import { shiftDate } from './dates.js';
import { allBlockLists } from './schedule.js';

const MAX_LABEL = 60;
const MAX_COINS = 999;
const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function slugify(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Retired checks stay in template.checks forever, so this collision test covers
// active and retired alike and an id is never reused for a different habit.
export function uniqueCheckId(template, label) {
  const base = slugify(label) || 'check';
  if (!template.checks[base]) return base;
  let n = 2;
  while (template.checks[`${base}-${n}`]) n += 1;
  return `${base}-${n}`;
}

function validateLabel(label) {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) throw new ValidationError('label cannot be empty');
  if (trimmed.length > MAX_LABEL) {
    throw new ValidationError(`label cannot be longer than ${MAX_LABEL} characters`);
  }
  return trimmed;
}

function validateAttribute(template, attribute) {
  if (!template.attributes[attribute]) {
    throw new ValidationError(`unknown attribute: ${attribute}`);
  }
  return attribute;
}

function validateCoins(coins) {
  if (!Number.isInteger(coins) || coins < 0 || coins > MAX_COINS) {
    throw new ValidationError(`coins must be a whole number from 0 to ${MAX_COINS}`);
  }
  return coins;
}

function validateStreakDays(streakDays) {
  if (!streakDays || streakDays.length === 0) return null;
  for (const dow of streakDays) {
    if (!DOWS.includes(dow)) throw new ValidationError(`unknown day: ${dow}`);
  }
  return [...streakDays];
}

// An activeFrom earlier than the backfill window would put rows inside locked
// days that can never be ticked, so they would read as missed forever.
function validateActiveFrom(template, activeFrom, today) {
  const earliest = shiftDate(today, -template.backfillDays);
  if (activeFrom < earliest) {
    throw new ValidationError(`activeFrom cannot be earlier than ${earliest}, the backfill window`);
  }
  return activeFrom;
}

export function addCheck({ template, label, attribute, coins, activeFrom, streakDays, today, at }) {
  const cleanLabel = validateLabel(label);
  validateAttribute(template, attribute);
  validateCoins(coins);
  const days = validateStreakDays(streakDays);
  validateActiveFrom(template, activeFrom, today);

  const checkId = uniqueCheckId(template, cleanLabel);
  const taskId = coins > 0 ? `check-${checkId}` : null;

  const tasks = { ...template.tasks };
  if (taskId) {
    tasks[taskId] = { label: cleanLabel, attribute, coins, updatedAt: at };
  }

  const checks = {
    ...template.checks,
    [checkId]: {
      label: cleanLabel,
      attribute,
      taskId,
      activeFrom,
      retiredOn: null,
      updatedAt: at,
    },
  };

  const streaks = { ...template.streaks };
  if (days) {
    streaks[checkId] = { label: cleanLabel, attribute, source: 'check', appliesOn: days };
  }

  return { template: { ...template, tasks, checks, streaks }, checkId };
}

export function updateCheck({ template, checkId, label, attribute, coins, at }) {
  const existing = template.checks[checkId];
  if (!existing) throw new ValidationError(`unknown check: ${checkId}`);

  const cleanLabel = validateLabel(label);
  validateAttribute(template, attribute);
  validateCoins(coins);

  // Copy on write: a check that never had coins has no task until it needs one,
  // so no dead tasks accumulate. Once it exists the id never changes, which is
  // what keeps a refund reachable after an edit.
  const taskId = coins > 0 ? (existing.taskId ?? `check-${checkId}`) : null;

  const tasks = { ...template.tasks };
  if (taskId) {
    tasks[taskId] = { label: cleanLabel, attribute, coins, updatedAt: at };
  }
  // When coins drop to zero the check stops pointing at its task, but the task
  // stays. A day inside the backfill window may still hold a tick whose untick
  // has to find it, and coinEffect throws when it cannot.

  return {
    template: {
      ...template,
      tasks,
      checks: {
        ...template.checks,
        [checkId]: { ...existing, label: cleanLabel, attribute, taskId, updatedAt: at },
      },
    },
  };
}

// Tomorrow, not today: retiring a habit at 21:00 must leave today's row in
// place, ticked and counted, rather than making the day you are looking at
// change under you.
export function defaultRetireDate(today) {
  return shiftDate(today, 1);
}

export function retireCheck({ template, checkId, retiredOn, at }) {
  const existing = template.checks[checkId];
  if (!existing) throw new ValidationError(`unknown check: ${checkId}`);

  return {
    template: {
      ...template,
      checks: {
        ...template.checks,
        [checkId]: { ...existing, retiredOn, updatedAt: at },
      },
    },
  };
}

function blockTaskIds(template) {
  const ids = new Set();
  for (const { blocks } of allBlockLists(template)) {
    for (const block of blocks) {
      if (block.taskId) ids.add(block.taskId);
    }
  }
  return ids;
}

// A check whose task is also a block's task cannot be repriced without repricing
// the block, which is a change the editor never shows and the user never asked
// for. Give the check its own copy instead, and leave the blocks pointing where
// they always did.
//
// Idempotent by construction: after the split the check's taskId is no longer in
// the block set, so a second run finds nothing to do.
export function migrateDedicatedTasks(template, at) {
  const blockIds = blockTaskIds(template);
  const tasks = { ...template.tasks };
  const checks = { ...template.checks };
  let changed = false;

  for (const [checkId, check] of Object.entries(template.checks)) {
    if (!check.taskId) continue;
    if (!blockIds.has(check.taskId)) continue;

    const source = template.tasks[check.taskId];
    if (!source) continue;

    const taskId = `check-${checkId}`;
    tasks[taskId] = {
      label: source.label,
      attribute: source.attribute,
      coins: source.coins,
      updatedAt: at,
    };
    checks[checkId] = { ...check, taskId, updatedAt: at };
    changed = true;
  }

  if (!changed) return { template, changed: false };
  return { template: { ...template, tasks, checks }, changed: true };
}

// A task created for a block, rather than owned by a check. The task- prefix
// keeps it out of the check-<checkId> space C writes into, and it is
// deliberately shareable: deep-block is already named by six blocks, and a new
// "Client work" block should be able to point at an existing reward rather than
// minting a near-duplicate of it.
export function uniqueTaskId(template, label) {
  const base = `task-${slugify(label) || 'task'}`;
  if (!template.tasks[base]) return base;
  let n = 2;
  while (template.tasks[`${base}-${n}`]) n += 1;
  return `${base}-${n}`;
}

export function addTask({ template, label, attribute, coins, at }) {
  const cleanLabel = validateLabel(label);
  validateAttribute(template, attribute);
  validateCoins(coins);

  const taskId = uniqueTaskId(template, cleanLabel);
  return {
    template: {
      ...template,
      tasks: { ...template.tasks, [taskId]: { label: cleanLabel, attribute, coins, updatedAt: at } },
    },
    taskId,
  };
}
