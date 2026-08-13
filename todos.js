// Ad-hoc todos. Pure functions only: no DOM, no clock reads, no document writes.
//
// Deliberately no assertWritable anywhere in this module. Every other write in
// the app goes through the backfill lock, but a todo floats free of dates, so a
// lock keyed on a date has nothing to check. This is the one intentional
// exception, not an oversight.

// ts and rand are injected rather than generated here, exactly as newEntry does
// in src/ledger.js. That keeps the function pure, and it makes the document id
// chronologically sortable, so allWithPrefix returns todos in creation order
// with no separate sort field and no index.
export function newTodo({ text, note = '', due = null, ts, rand }) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error('todo text is required');
  return {
    _id: `todo:${ts}:${rand}`,
    type: 'todo',
    text: trimmed,
    note,
    due,
    pinned: false,
    done: false,
    doneAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

// Due today is not overdue: you still have the day to do it. String comparison
// is correct here because YYYY-MM-DD sorts lexicographically as it sorts
// chronologically, which is the whole reason the app stores dates this way.
export function isOverdue(todo, todayStr) {
  return todo.due !== null && todo.due < todayStr;
}

// A comparison key as an array, compared element by element. Writing it this way
// rather than as a chain of if-statements keeps the three tiers of the spec
// visible in one place and makes adding a tier a one-line change.
//
// Tier 1: pinned first.
// Tier 2: dated before undated.
// Tier 3: among dated, soonest first. Overdue items need no rule of their own -
//         ascending due dates float them to the top of their group already.
// Tier 4: among undated, newest first. The id is chronological, so descending
//         id is descending creation time.
function openKey(todo) {
  return [
    todo.pinned ? 0 : 1,
    todo.due === null ? 1 : 0,
    todo.due ?? '',
  ];
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export function sortOpen(todos) {
  return todos
    .filter(t => !t.done)
    .slice()
    .sort((a, b) => compareKeys(openKey(a), openKey(b)) || (a._id < b._id ? 1 : -1));
}

export function sortArchive(todos) {
  return todos
    .filter(t => t.done)
    .slice()
    .sort((a, b) => ((a.doneAt ?? '') < (b.doneAt ?? '') ? 1 : -1));
}

// Every mutation returns a new document rather than editing in place, matching
// how src/actions.js already works, and stamps updatedAt because that field is
// the whole conflict rule for todos.

export function toggleDone(todo, { done, at }) {
  return { ...todo, done, doneAt: done ? at : null, updatedAt: at };
}

export function togglePin(todo, { pinned, at }) {
  return { ...todo, pinned, updatedAt: at };
}

export function edit(todo, { text, note, due, at }) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error('todo text is required');
  return { ...todo, text: trimmed, note, due, updatedAt: at };
}

// PouchDB deletes by putting a document with _deleted, so removal travels the
// same save path as every other change and replicates as a proper tombstone.
export function remove(todo, { at }) {
  return { ...todo, _deleted: true, updatedAt: at };
}
