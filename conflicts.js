import { listKey, withBlockList } from './schedule.js';

// Merge conflicting revisions of one day: document.
//
// CouchDB always picks a deterministic winner among conflicting revisions and
// keeps the others as _conflicts. Left alone that silently discards whichever
// device happened to lose, so every offline tick on the losing side vanishes.
// This module folds all revisions into one and reports the losers for deletion.

// Later `at` wins. On an exact tie prefer done:true, because the two devices
// disagree about the same instant and the completion is the more informative
// claim; a tie is otherwise unresolvable and must still be deterministic.
function pickEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.at === b.at) return a.done ? a : b;
  return a.at > b.at ? a : b;
}

function mergeMaps(revisions, key) {
  const out = {};
  for (const r of revisions) {
    for (const [id, entry] of Object.entries(r[key] ?? {})) {
      out[id] = pickEntry(out[id], entry);
    }
  }
  // Clone so the caller's revisions are never aliased into the result.
  return Object.fromEntries(Object.entries(out).map(([id, e]) => [id, { ...e }]));
}

// Same shape as the branch rule: a revision that never set this override
// carries no timestamp and must not outrank one that did. Without this the
// spread of ...winner would hand the field to whichever revision CouchDB
// happened to pick, silently discarding a nudge made on the other device.
function mergeStamped(merged, revisions, field, stampField) {
  const stamped = revisions.filter(r => r[stampField]);
  if (!stamped.length) return;
  const best = stamped.reduce((a, b) => (b[stampField] > a[stampField] ? b : a));
  merged[field] = best[field];
  merged[stampField] = best[stampField];
}

export function mergeDayDocs(revisions) {
  if (!revisions?.length) throw new Error('mergeDayDocs needs at least one revision');

  const [winner, ...rest] = revisions;
  const merged = {
    ...winner,
    blocks: mergeMaps(revisions, 'blocks'),
    checks: mergeMaps(revisions, 'checks'),
  };

  // A revision that never set a branch carries no branchSetAt and must not
  // outrank one that did.
  const branched = revisions.filter(r => r.branchSetAt);
  if (branched.length) {
    const best = branched.reduce((a, b) => (b.branchSetAt > a.branchSetAt ? b : a));
    merged.branch = best.branch;
    merged.branchSetAt = best.branchSetAt;
  }

  // The merge unit is the whole block list, not the block. Two valid partitions
  // do not merge per block into a valid partition: taking tue-lunch from one
  // device and tue-sermon from the other reopens a gap between them, and the
  // day the calendar sync then writes has overlapping events. So the list
  // travels whole and the newest stamp takes all of it.
  //
  // Clearing an override writes a null list with a fresh stamp, which is why
  // this tests the stamp rather than the list: a clear must be able to win.
  const overridden = revisions.filter(r => r.blocksOverrideAt);
  if (overridden.length) {
    const best = overridden.reduce((a, b) => (b.blocksOverrideAt > a.blocksOverrideAt ? b : a));
    merged.blocksOverride = best.blocksOverride;
    merged.blocksOverrideAt = best.blocksOverrideAt;
  }

  mergeStamped(merged, revisions, 'sleepOverride', 'sleepOverrideAt');
  mergeStamped(merged, revisions, 'wakeOverride', 'wakeOverrideAt');

  merged.updatedAt = revisions
    .map(r => r.updatedAt)
    .filter(Boolean)
    .reduce((a, b) => (b > a ? b : a), '');

  return {
    merged,
    losers: rest.map(r => ({ _id: r._id, _rev: r._rev })),
  };
}

// Todos merge whole-document, unlike day documents.
//
// A day document aggregates dozens of independent block and check ticks into two
// maps, so picking an arbitrary whole-document winner would discard real work,
// which is why mergeDayDocs merges per entry. A todo is one small thing edited by
// one person; the only collision is editing the same todo on two devices while
// offline, and per-field timestamps would not pay for themselves there.
export function mergeTodoDocs(revisions) {
  if (!revisions?.length) throw new Error('mergeTodoDocs needs at least one revision');

  const [winner, ...rest] = revisions;

  // Content comes from the newest revision, but _rev must stay the CouchDB
  // winner's: that is the revision the subsequent put has to supersede.
  const newest = revisions.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));

  return {
    merged: { ...newest, _rev: winner._rev },
    losers: rest.map(r => ({ _id: r._id, _rev: r._rev })),
  };
}

// The template twin of mergeDayDocs. The template was read-only until checks
// became editable, so a conflict on it could only ever have been a seed running
// twice. Now the phone can add a check while the desktop renames another, and a
// whole document winner would throw one of those away.
//
// Entries are stamped with updatedAt rather than the day documents' at, and an
// unstamped entry is treated as the oldest possible: the four original checks
// carry no stamp, and an edited copy of one must always beat the untouched one.
function pickStamped(a, b) {
  if (!a) return b;
  if (!b) return a;
  const at = a.updatedAt ?? '';
  const bt = b.updatedAt ?? '';
  return at >= bt ? a : b;
}

function mergeStampedMaps(revisions, key) {
  const out = {};
  for (const r of revisions) {
    for (const [id, entry] of Object.entries(r[key] ?? {})) {
      out[id] = pickStamped(out[id], entry);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([id, e]) => [id, { ...e }]));
}

// allBlockLists needs a complete template; a conflicting revision is whatever
// CouchDB stored, so this walks whatever days it actually has.
function* listsOf(doc) {
  for (const [dow, day] of Object.entries(doc.days ?? {})) {
    if (day.branching) {
      for (const branch of ['A', 'B']) yield { dow, branch, blocks: day.branches[branch] };
    } else {
      yield { dow, branch: null, blocks: day.blocks };
    }
  }
}

// For each list key the revision with the newest daysUpdatedAt supplies that
// entire list, and its daysStreakEpoch value for the same key travels with it.
// The epoch is a property of the list that won, not a value to merge on its
// own: an epoch from a losing revision would skip streak days for a change
// that is no longer in the template.
function mergeDayLists(revisions) {
  const withDays = revisions.filter(r => r.days);
  if (!withDays.length) return null;

  const [first, ...rest] = withDays;
  let days = first.days;
  const daysUpdatedAt = { ...(first.daysUpdatedAt ?? {}) };
  const daysStreakEpoch = { ...(first.daysStreakEpoch ?? {}) };

  for (const r of rest) {
    for (const { dow, branch, blocks } of listsOf(r)) {
      const key = listKey(dow, branch);
      const mine = r.daysUpdatedAt?.[key] ?? '';
      const held = daysUpdatedAt[key] ?? '';
      if (mine && mine > held) {
        days = withBlockList(days, dow, branch, blocks);
        daysUpdatedAt[key] = mine;
        daysStreakEpoch[key] = r.daysStreakEpoch?.[key] ?? null;
      }
    }
  }

  return { days, daysUpdatedAt, daysStreakEpoch };
}

export function mergeTemplateDocs(revisions) {
  if (!revisions?.length) throw new Error('mergeTemplateDocs needs at least one revision');

  const [winner, ...rest] = revisions;
  const merged = {
    ...winner,
    checks: mergeStampedMaps(revisions, 'checks'),
    tasks: mergeStampedMaps(revisions, 'tasks'),
    streaks: mergeStampedMaps(revisions, 'streaks'),
  };

  // Only when at least one revision carries days, so a revision that predates
  // block editing merges exactly as it did before.
  const lists = mergeDayLists(revisions);
  if (lists) Object.assign(merged, lists);

  return {
    merged,
    losers: rest.map(r => ({ _id: r._id, _rev: r._rev })),
  };
}
