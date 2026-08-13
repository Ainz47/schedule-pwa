import { isLocked } from './streaks.js';
import { newEntry, undoEntry, balance } from './ledger.js';
import { effectiveTimes, shiftTime } from './bedtime.js';
import { checkActiveOn } from './checks.js';

export class LockedDayError extends Error {
  constructor(dateStr) {
    super(`${dateStr} is outside the backfill window and can no longer be edited`);
    this.name = 'LockedDayError';
    this.date = dateStr;
  }
}

// Same reasoning as LockedDayError: a check that does not apply on this day must
// refuse the write out loud, so the UI can explain itself rather than accepting
// a tap that quietly does nothing.
export class CheckNotActiveError extends Error {
  constructor(checkId, dateStr) {
    super(`${checkId} did not apply on ${dateStr}`);
    this.name = 'CheckNotActiveError';
    this.checkId = checkId;
    this.date = dateStr;
  }
}

export class InsufficientCoinsError extends Error {
  constructor(cost, have) {
    super(`costs ${cost} coins, balance is ${have}`);
    this.name = 'InsufficientCoinsError';
    this.cost = cost;
    this.have = have;
  }
}

export function emptyDay(dateStr, dow) {
  return {
    _id: `day:${dateStr}`,
    type: 'day',
    date: dateStr,
    dow,
    branch: null,
    branchSetAt: null,
    // A structural snapshot of this date's blocks, or null to follow the
    // weekly template. Both default to null so no existing day document in
    // CouchDB needs migrating: an absent field reads the same as a null one.
    blocksOverride: null,
    blocksOverrideAt: null,
    blocks: {},
    checks: {},
    sleepOverride: null,
    sleepOverrideAt: null,
    wakeOverride: null,
    wakeOverrideAt: null,
    updatedAt: null,
  };
}

// Loud, not silent: the spec requires a locked day to reject a write so the UI
// can say why, instead of accepting a tap that quietly does nothing.
export function assertWritable(dateStr, today, backfillDays) {
  if (isLocked(dateStr, today, backfillDays)) throw new LockedDayError(dateStr);
}

// The list handed in is already resolved for the date, which is what lets a
// one-off block added to a single day be ticked. Scanning the template instead
// cannot see one, and threw `unknown block` on the first tick.
function findBlock(blocks, blockId) {
  return blocks.find(b => b.id === blockId) ?? null;
}

// The most recent earn for this task on this date that has not already been
// undone. Without the undone filter, unticking twice would refund twice.
function findLiveEarn(ledger, date, refId) {
  const undone = new Set(ledger.filter(e => e.undoOf).map(e => e.undoOf));
  return ledger
    .filter(e => e.kind === 'earn' && e.date === date && e.refId === refId && !undone.has(e._id))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))[0] ?? null;
}

function coinEffect({ template, taskId, date, done, at, rand, ledger }) {
  if (!taskId) return [];
  const task = template.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);

  if (done) {
    return [newEntry({
      kind: 'earn', amount: task.coins, attribute: task.attribute,
      refId: taskId, label: task.label, date, ts: at, rand,
    })];
  }
  const live = findLiveEarn(ledger, date, taskId);
  return live ? [undoEntry(live, { ts: at, rand })] : [];
}

function touch(doc, key, id, done, at) {
  return {
    ...doc,
    [key]: { ...doc[key], [id]: { done, at } },
    updatedAt: at,
  };
}

export function applyBlockToggle({ template, blocks, doc, blockId, done, at, rand, ledger }) {
  const block = findBlock(blocks, blockId);
  if (!block) throw new Error(`unknown block: ${blockId}`);
  return {
    doc: touch(doc, 'blocks', blockId, done, at),
    ledgerEntries: coinEffect({ template, taskId: block.taskId, date: doc.date, done, at, rand, ledger }),
  };
}

export function applyCheckToggle({ template, doc, checkId, done, at, rand, ledger }) {
  const check = template.checks[checkId];
  if (!check) throw new Error(`unknown check: ${checkId}`);
  if (!checkActiveOn(check, doc.date)) throw new CheckNotActiveError(checkId, doc.date);
  return {
    doc: touch(doc, 'checks', checkId, done, at),
    ledgerEntries: coinEffect({ template, taskId: check.taskId, date: doc.date, done, at, rand, ledger }),
  };
}

export function setBranch({ doc, branch, at }) {
  if (branch !== 'A' && branch !== 'B') throw new Error(`branch must be "A" or "B", got ${branch}`);
  return { doc: { ...doc, branch, branchSetAt: at, updatedAt: at } };
}

// The same shape as setBranch, and for the same reason: a per-date structural
// choice belongs on the day document with the moment it was made, so the
// conflict merge can rank two devices' versions of it.
export function setBlocksOverride({ doc, blocksOverride, at }) {
  return { doc: { ...doc, blocksOverride, blocksOverrideAt: at, updatedAt: at } };
}

// The stamp survives the clear on purpose. An unstamped revision cannot outrank
// a stamped one, so a clear that dropped its stamp could never beat the
// override it was undoing on the other device.
export function clearBlocksOverride({ doc, at }) {
  return { doc: { ...doc, blocksOverride: null, blocksOverrideAt: at, updatedAt: at } };
}

export function spend({ template, ledger, shopId, date, at, rand }) {
  const item = template.shop.find(s => s.id === shopId);
  if (!item) throw new Error(`unknown shop item: ${shopId}`);
  const have = balance(ledger);
  if (have < item.cost) throw new InsufficientCoinsError(item.cost, have);
  return {
    ledgerEntries: [newEntry({
      kind: 'spend', amount: item.cost, attribute: 'lifeskills',
      refId: shopId, label: item.label, date, ts: at, rand,
    })],
  };
}

export function nudgeSleep({ doc, deltaMinutes, template, at }) {
  const { sleep } = effectiveTimes(template, doc);
  return { doc: { ...doc, sleepOverride: shiftTime(sleep, deltaMinutes), sleepOverrideAt: at, updatedAt: at } };
}

export function nudgeWake({ doc, deltaMinutes, template, at }) {
  const { wake } = effectiveTimes(template, doc);
  return { doc: { ...doc, wakeOverride: shiftTime(wake, deltaMinutes), wakeOverrideAt: at, updatedAt: at } };
}

// The clear carries a timestamp of its own so that a merge sees it as the
// newest statement about this field. Setting the stamp to null instead would
// let a stale nudge from another device win and silently reinstate itself.
export function clearSleepOverride({ doc, at }) {
  return { doc: { ...doc, sleepOverride: null, sleepOverrideAt: at, updatedAt: at } };
}

export function clearWakeOverride({ doc, at }) {
  return { doc: { ...doc, wakeOverride: null, wakeOverrideAt: at, updatedAt: at } };
}
