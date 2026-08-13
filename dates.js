// All date arithmetic goes through UTC midnight. Doing it on a local Date is
// what produces off-by-one days west of Greenwich and breaks across a DST
// change; the rest of the codebase already follows this rule in clock.js and
// streaks.js, and this module exists so the UI does not have to reinvent it.
const MS_PER_DAY = 86_400_000;

function utcMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function toDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function shiftDate(dateStr, deltaDays) {
  return toDateStr(utcMs(dateStr) + deltaDays * MS_PER_DAY);
}

export function daysBetween(from, to) {
  return (utcMs(to) - utcMs(from)) / MS_PER_DAY;
}

export function eachDate(from, to) {
  const out = [];
  for (let ms = utcMs(from); ms <= utcMs(to); ms += MS_PER_DAY) {
    out.push(toDateStr(ms));
  }
  return out;
}
