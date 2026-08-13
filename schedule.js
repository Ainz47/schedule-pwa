const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function blocksFor(template, dow, branch) {
  const day = template.days[dow];
  if (!day) throw new Error(`unknown day of week: ${dow}`);
  if (!day.branching) return day.blocks;
  if (branch !== 'A' && branch !== 'B') {
    throw new Error(`${dow} is a branching day; branch must be "A" or "B", got ${branch}`);
  }
  return day.branches[branch];
}

export function allBlockLists(template) {
  const out = [];
  for (const dow of DOWS) {
    const day = template.days[dow];
    if (day.branching) {
      for (const branch of ['A', 'B']) {
        out.push({ dow, branch, blocks: day.branches[branch] });
      }
    } else {
      out.push({ dow, branch: null, blocks: day.blocks });
    }
  }
  return out;
}

export function sumHours(blocks) {
  // Sum in minutes and convert back; adding 0.5 and 1.5 repeatedly in floating
  // point drifts enough to fail an equality assertion against 16.5.
  const minutes = blocks.reduce((acc, b) => acc + Math.round(b.hours * 60), 0);
  return minutes / 60;
}

export function clientHours(template, { monBranch, wedBranch }) {
  let core = 0;
  let surge = 0;
  for (const dow of DOWS) {
    const day = template.days[dow];
    const branch = dow === 'mon' ? monBranch : dow === 'wed' ? wedBranch : null;
    const blocks = day.branching ? day.branches[branch] : day.blocks;
    for (const b of blocks) {
      if (b.kind === 'core') core += Math.round(b.hours * 60);
      if (b.kind === 'surge') surge += Math.round(b.hours * 60);
    }
  }
  return { core: core / 60, surge: surge / 60, total: (core + surge) / 60 };
}

// The identity allBlockLists already produces, as one string. It keys
// daysUpdatedAt and daysStreakEpoch, so it has to be stable and collision-free
// across all nine lists: seven weekdays, two of which branch.
export function listKey(dow, branch) {
  return branch ? `${dow}/${branch}` : dow;
}

// Returns a new days map with one block list replaced. It takes the days map
// rather than a whole template because the conflict merge works on revisions
// that carry days without necessarily carrying anything else.
export function withBlockList(days, dow, branch, blocks) {
  const day = days[dow];
  if (!day) throw new Error(`unknown day of week: ${dow}`);
  if (!day.branching) return { ...days, [dow]: { ...day, blocks } };
  if (branch !== 'A' && branch !== 'B') {
    throw new Error(`${dow} is a branching day; branch must be "A" or "B", got ${branch}`);
  }
  return { ...days, [dow]: { ...day, branches: { ...day.branches, [branch]: blocks } } };
}

// A tombstone: a snapshot entry whose id the template no longer has. It keeps
// its interval so the day is still a partition, and it resolves to something
// deliberately inert so nothing downstream has to special-case it. attribute is
// null rather than absent because src/ui/day.js looks the colour up by it.
function tombstone(entry) {
  return {
    id: entry.id,
    label: 'Removed',
    detail: '',
    attribute: null,
    start: entry.start,
    end: entry.end,
    hours: entry.hours,
    kind: 'fixed',
    taskId: null,
    campaignSlot: false,
    streakId: null,
    calendar: { event: false, remindMinutes: 10 },
    tombstone: true,
  };
}

// The single read path for "what did this day actually run". blocksFor stays
// pure template because the vault export's Template section wants exactly that.
//
// The override is a structural snapshot: times and the block set are frozen on
// the day document, while label, detail, attribute, taskId, streakId,
// campaignSlot and calendar keep resolving live from the template by block id.
// That is what lets a block renamed or repriced today reach a date overridden
// last week, and it is why the id lookup spans every list rather than just this
// weekday's: block ids are globally unique, and flipping the branch after an
// override was taken must not turn the whole day into tombstones.
export function resolveBlocks(template, dow, branch, dayDoc) {
  const entries = dayDoc?.blocksOverride;
  if (!entries) return blocksFor(template, dow, branch);

  const byId = new Map();
  for (const { blocks } of allBlockLists(template)) {
    for (const b of blocks) byId.set(b.id, b);
  }

  return entries.map((entry) => {
    const { id, start, end, hours } = entry;
    if (entry.fields) return { ...entry.fields, id, start, end, hours };
    const source = byId.get(id);
    if (!source) return tombstone(entry);
    return { ...source, id, start, end, hours };
  });
}
