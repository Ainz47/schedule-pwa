const SIGN = { earn: 1, spend: -1, penalty: -1 };
const OPPOSITE = { earn: 'spend', spend: 'earn', penalty: 'earn' };

export function newEntry({ kind, amount, attribute, refId, label, date, ts, rand, undoOf = null }) {
  if (!(kind in SIGN)) throw new Error(`unknown ledger kind: ${kind}`);
  if (!(amount > 0)) throw new Error('amount must be positive; kind carries the sign');
  return {
    _id: `ledger:${ts}:${rand}`,
    type: 'ledger',
    ts, date, kind, amount, attribute, refId, label, undoOf,
  };
}

// Entries arrive from replication and may repeat; dedupe by _id so a replayed
// document cannot double-count.
function unique(entries) {
  return [...new Map(entries.map(e => [e._id, e])).values()];
}

export function balance(entries) {
  return unique(entries).reduce((acc, e) => acc + SIGN[e.kind] * e.amount, 0);
}

export function earnedOn(entries, date) {
  return unique(entries)
    .filter(e => e.date === date && e.kind === 'earn')
    .reduce((acc, e) => acc + e.amount, 0);
}

export function byAttribute(entries) {
  const out = {};
  for (const e of unique(entries)) {
    out[e.attribute] = (out[e.attribute] ?? 0) + SIGN[e.kind] * e.amount;
  }
  return out;
}

export function undoEntry(entry, { ts, rand }) {
  return newEntry({
    kind: OPPOSITE[entry.kind],
    amount: entry.amount,
    attribute: entry.attribute,
    refId: entry.refId,
    label: `Undo: ${entry.label}`,
    date: entry.date,
    ts, rand,
    undoOf: entry._id,
  });
}

export function canAfford(entries, cost) {
  return balance(entries) >= cost;
}
