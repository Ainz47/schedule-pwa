// The partition algebra. Every function here takes a block list and returns a
// new block list. Nothing here knows about templates, day documents or the DOM.
//
// The invariant this module exists to protect is contiguity, not the 16.5 hour
// sum. tests/test_schedule.js asserts blocks[0].start === wake,
// blocks.at(-1).end === sleep, and blocks[i].start === blocks[i-1].end. A
// contiguous partition of a fixed interval sums to the length of that interval
// by construction, so the sum is a consequence and never needs solving for.
import { toMinutes, blocksFor, allBlockLists, listKey, withBlockList } from './schedule.js';
import { ValidationError } from './template-edit.js';

export const STEP_MINUTES = 15;
export const MIN_BLOCK_MINUTES = 15;

export function toHHMM(minutes) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(minutes / 60))}:${p(minutes % 60)}`;
}

// Times are carried as HH:MM strings and hours is a cached derivation, so every
// retime goes through here rather than setting the three fields by hand.
function retimed(block, startMin, endMin) {
  return {
    ...block,
    start: toHHMM(startMin),
    end: toHHMM(endMin),
    hours: (endMin - startMin) / 60,
  };
}

function assertGrid(hhmm) {
  if (toMinutes(hhmm) % STEP_MINUTES !== 0) {
    throw new ValidationError(`${hhmm} is not on the ${STEP_MINUTES} minute grid`);
  }
}

export function validateList(blocks, wake, sleep, template = null) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new ValidationError('a day needs at least one block');
  }

  if (blocks[0].start !== wake) {
    throw new ValidationError(`the first block starts at ${blocks[0].start}, not wake (${wake})`);
  }
  if (blocks.at(-1).end !== sleep) {
    throw new ValidationError(`the last block ends at ${blocks.at(-1).end}, not sleep (${sleep})`);
  }

  const seen = new Set();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (seen.has(b.id)) throw new ValidationError(`duplicate block id: ${b.id}`);
    seen.add(b.id);

    const startMin = toMinutes(b.start);
    const endMin = toMinutes(b.end);
    if (endMin - startMin < MIN_BLOCK_MINUTES) {
      throw new ValidationError(`${b.id} is shorter than ${MIN_BLOCK_MINUTES} minutes`);
    }
    if (b.hours !== (endMin - startMin) / 60) {
      throw new ValidationError(`${b.id} hours ${b.hours} does not match ${b.start}-${b.end}`);
    }
    if (i > 0 && b.start !== blocks[i - 1].end) {
      throw new ValidationError(`gap or overlap before ${b.id}`);
    }

    if (template) {
      if (b.taskId && !template.tasks[b.taskId]) {
        throw new ValidationError(`${b.id} names unknown task ${b.taskId}`);
      }
      if (b.streakId && !template.streaks[b.streakId]) {
        throw new ValidationError(`${b.id} names unknown streak ${b.streakId}`);
      }
      // A tombstone resolves with a null attribute on purpose and never reaches
      // a write, so only a named attribute is checked.
      if (b.attribute && !template.attributes[b.attribute]) {
        throw new ValidationError(`${b.id} names unknown attribute ${b.attribute}`);
      }
    }
  }

  const slots = blocks.filter(b => b.campaignSlot).length;
  if (slots !== 1) {
    throw new ValidationError(`a day needs exactly one campaign slot, this one has ${slots}`);
  }

  return true;
}

// Seam i sits between blocks[i] and blocks[i+1]. A list of N blocks has N-1 of
// them; the outer two edges are pinned to wake and sleep and are not seams.
// The clamp is what greys out the stepper rather than allowing a block to be
// driven to zero, so it returns a valid list for any input rather than throwing.
export function moveBoundary(blocks, i, hhmm) {
  if (!Number.isInteger(i) || i < 0 || i > blocks.length - 2) {
    throw new ValidationError(`no boundary at index ${i}`);
  }
  assertGrid(hhmm);

  const left = blocks[i];
  const right = blocks[i + 1];
  const lo = toMinutes(left.start) + MIN_BLOCK_MINUTES;
  const hi = toMinutes(right.end) - MIN_BLOCK_MINUTES;
  const target = Math.min(Math.max(toMinutes(hhmm), lo), hi);

  const out = [...blocks];
  out[i] = retimed(left, toMinutes(left.start), target);
  out[i + 1] = retimed(right, target, toMinutes(right.end));
  return out;
}

export function uniqueBlockId(taken, base) {
  const used = taken instanceof Set ? taken : new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// A new block is the non-structural half the caller supplies plus the interval
// it was placed at. The defaults match the shape every seeded block has, so a
// block created in the app is indistinguishable from one written by the seed.
function newBlock(id, fields, startMin, endMin) {
  return {
    id,
    label: fields.label,
    detail: fields.detail ?? '',
    attribute: fields.attribute,
    start: toHHMM(startMin),
    end: toHHMM(endMin),
    hours: (endMin - startMin) / 60,
    kind: fields.kind ?? 'fixed',
    taskId: fields.taskId ?? null,
    campaignSlot: fields.campaignSlot ?? false,
    streakId: fields.streakId ?? null,
    calendar: fields.calendar ?? { event: false, remindMinutes: 10 },
  };
}

// Overwrite an interval. Whatever was in [start, end) is displaced:
//   - a block entirely inside is dropped
//   - a block containing start has its end pulled back to start
//   - a block containing end has its start pushed out to end
//   - a block containing both is clipped on both sides, which is the split
//     case falling out of the same three rules rather than being its own mode
// The result is a partition because a sub-interval of a partition was
// overwritten with a single block.
export function placeBlock(blocks, { start, end, fields, id, takenIds }) {
  assertGrid(start);
  assertGrid(end);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (e - s < MIN_BLOCK_MINUTES) {
    throw new ValidationError(`end must be at least ${MIN_BLOCK_MINUTES} minutes after start`);
  }

  const dayStart = toMinutes(blocks[0].start);
  const dayEnd = toMinutes(blocks.at(-1).end);
  if (s < dayStart || e > dayEnd) {
    throw new ValidationError(`${start}-${end} is outside the day (${blocks[0].start}-${blocks.at(-1).end})`);
  }

  // Always seed with the current list's ids, then fold in any wider set the
  // caller supplied (every id in the template). A split remnant must dodge the
  // left half it was cut from, which lives in `blocks` even when takenIds omits
  // it, so a union is needed rather than an either/or.
  const used = new Set([...blocks.map(b => b.id), ...(takenIds ?? [])]);
  if (used.has(id)) throw new ValidationError(`block id ${id} is already in use`);
  used.add(id);

  const out = [];
  for (const b of blocks) {
    const a = toMinutes(b.start);
    const z = toMinutes(b.end);

    if (a >= s && z <= e) continue;            // swallowed whole
    if (a < s && z > e) {                       // split: keep both remnants
      out.push(retimed(b, a, s));
      out.push({ ...retimed(b, e, z), id: uniqueBlockId(used, b.id) });
      used.add(out.at(-1).id);
      continue;
    }
    if (a < s && z > s) { out.push(retimed(b, a, s)); continue; }
    if (a < e && z > e) { out.push(retimed(b, e, z)); continue; }
    out.push(b);
  }

  out.push(newBlock(id, fields, s, e));
  out.sort((x, y) => toMinutes(x.start) - toMinutes(y.start));
  return out;
}

const REMOVE_MODES = ['prev', 'next', 'divide'];

// The freed interval must go somewhere or the list stops being a partition.
// At the ends of the day the missing neighbour makes the choice, so the mode is
// accepted and ignored there rather than rejected: the caller is a stepper on a
// row and should not have to special-case the first and last rows.
export function removeBlock(blocks, id, mode, at) {
  if (!REMOVE_MODES.includes(mode)) {
    throw new ValidationError(`unknown mode: ${mode}`);
  }
  if (blocks.length === 1) {
    throw new ValidationError('cannot remove the last remaining block of a day');
  }

  const i = blocks.findIndex(b => b.id === id);
  if (i === -1) throw new ValidationError(`unknown block: ${id}`);

  const gone = blocks[i];
  const out = blocks.filter((_, j) => j !== i);

  if (i === 0) {
    out[0] = retimed(out[0], toMinutes(gone.start), toMinutes(out[0].end));
    return out;
  }
  if (i === blocks.length - 1) {
    out[out.length - 1] = retimed(out.at(-1), toMinutes(out.at(-1).start), toMinutes(gone.end));
    return out;
  }

  const prev = out[i - 1];
  const next = out[i];

  if (mode === 'prev') {
    out[i - 1] = retimed(prev, toMinutes(prev.start), toMinutes(gone.end));
    return out;
  }
  if (mode === 'next') {
    out[i] = retimed(next, toMinutes(gone.start), toMinutes(next.end));
    return out;
  }

  if (!at) throw new ValidationError('divide needs a seam time');
  assertGrid(at);
  const seam = toMinutes(at);
  const lo = toMinutes(prev.start) + MIN_BLOCK_MINUTES;
  const hi = toMinutes(next.end) - MIN_BLOCK_MINUTES;
  if (seam < lo || seam > hi) {
    throw new ValidationError(`the seam must be between ${toHHMM(lo)} and ${toHHMM(hi)}`);
  }
  out[i - 1] = retimed(prev, toMinutes(prev.start), seam);
  out[i] = retimed(next, seam, toMinutes(next.end));
  return out;
}

// Everything a block carries that is not part of the partition. id, start, end
// and hours are absent on purpose: they are the partition, and letting a field
// edit touch them is exactly the bug this split exists to prevent.
const EDITABLE = ['label', 'detail', 'attribute', 'taskId', 'streakId', 'calendar', 'campaignSlot'];

export function editFields(blocks, id, patch) {
  const i = blocks.findIndex(b => b.id === id);
  if (i === -1) throw new ValidationError(`unknown block: ${id}`);

  for (const key of Object.keys(patch)) {
    if (!EDITABLE.includes(key)) {
      throw new ValidationError(`${key} cannot be edited here`);
    }
  }
  if (patch.campaignSlot === false) {
    throw new ValidationError('a day needs exactly one campaign slot; move it rather than clearing it');
  }

  // A radio, not a checkbox: setting the slot clears every other one, which
  // keeps the exactly-one assertion true by construction rather than by check.
  const clearing = patch.campaignSlot === true;
  return blocks.map((b, j) => {
    if (j === i) return { ...b, ...patch };
    return clearing && b.campaignSlot ? { ...b, campaignSlot: false } : b;
  });
}

// The part of a block list that streak evaluation depends on, and nothing else.
// A string rather than a structure because comparison is its only use and a
// string compares with ===.
export function streakSignature(blocks) {
  // Pairs of blockId:streakId, not just the distinct streak ids present. A
  // streak's requirement is which blocks carry it, not merely that it exists
  // somewhere on the day: tagging a second block with an id already used
  // elsewhere on the same day adds a requirement (both blocks now have to be
  // done) without introducing a new id, and a bare id set would miss that.
  const pairs = blocks.filter(b => b.streakId).map(b => `${b.id}:${b.streakId}`).sort();
  const slot = blocks.find(b => b.campaignSlot)?.id ?? '';
  return `${pairs.join(',')}|${slot}`;
}

// The calling flow for a template-scope edit. The signature comparison lives
// here rather than inside the operations because an operation sees one list at
// a time and the question is about the pair.
export function putBlockList({ template, dow, branch, blocks, at, today }) {
  validateList(blocks, template.wake, template.sleep, template);

  const key = listKey(dow, branch);
  const before = blocksFor(template, dow, branch);

  const daysUpdatedAt = { ...(template.daysUpdatedAt ?? {}), [key]: at };
  const daysStreakEpoch = { ...(template.daysStreakEpoch ?? {}) };
  if (streakSignature(before) !== streakSignature(blocks)) {
    // A date, not a timestamp: dayStatus compares it against a date string, and
    // `today` rather than `at` because at is UTC and the device is UTC+8.
    daysStreakEpoch[key] = today;
  }

  return {
    template: {
      ...template,
      days: withBlockList(template.days, dow, branch, blocks),
      daysUpdatedAt,
      daysStreakEpoch,
    },
  };
}

// A structural snapshot: times and the block set are frozen, everything else
// keeps resolving from the template by id. Only a block the template does not
// have carries its fields inline, because it has no counterpart to resolve to.
export function toOverride(template, blocks) {
  const known = new Set();
  for (const { blocks: list } of allBlockLists(template)) {
    for (const b of list) known.add(b.id);
  }

  return blocks.map((b) => {
    const entry = { id: b.id, start: b.start, end: b.end, hours: b.hours, fields: null };
    if (known.has(b.id)) return entry;
    const { id, start, end, hours, ...fields } = b;
    return { ...entry, fields };
  });
}
