import { toMinutes, resolveBlocks } from './schedule.js';

const DOWS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Date.UTC avoids the local-timezone shift that makes this off by one day
  // west of Greenwich.
  return DOWS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function currentBlock(template, dow, branch, hhmm, dayDoc = null) {
  const blocks = resolveBlocks(template, dow, branch, dayDoc);
  const now = toMinutes(hhmm);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (now >= toMinutes(b.start) && now < toMinutes(b.end)) {
      return {
        status: 'in-block',
        block: b,
        next: blocks[i + 1] ?? null,
        minutesLeft: toMinutes(b.end) - now,
      };
    }
  }

  const first = blocks[0];
  const beforeWake = now < toMinutes(first.start);
  return {
    status: 'off-hours',
    block: null,
    next: beforeWake ? first : null,
    minutesLeft: beforeWake ? toMinutes(first.start) - now : 0,
  };
}
