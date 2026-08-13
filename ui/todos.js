import { el } from './render.js';
import { sortOpen, sortArchive, isOverdue } from '../todos.js';

// Module scope, deliberately, for the same reason src/ui/day.js holds its offset
// there: app.js rebuilds this screen from scratch on every paint, so anything
// held inside render() would reset itself while being used. Here that means a
// half-typed todo would vanish. app.js also skips the periodic repaint while an
// input is focused, which is what protects the caret; this protects the content.
let draft = { text: '', note: '', due: '' };
let draftOpen = false;
let editingId = null;
let editDraft = { text: '', note: '', due: '' };
let archiveOpen = false;

function field(label, value, onchange, type = 'text') {
  return el('label', { class: 'field' }, [
    el('span', { text: label }),
    el('input', { type, value, oninput: (e) => onchange(e.target.value) }),
  ]);
}

function noteField(value, onchange) {
  return el('label', { class: 'field' }, [
    el('span', { text: 'Note' }),
    el('textarea', { rows: '3', text: value, oninput: (e) => onchange(e.target.value) }),
  ]);
}

function addRow(actions) {
  const submit = () => {
    if (!draft.text.trim()) return;
    actions.addTodo({
      text: draft.text,
      note: draft.note,
      due: draft.due || null,
    });
    draft = { text: '', note: '', due: '' };
    draftOpen = false;
  };

  const main = el('div', { class: 'todo-add' }, [
    el('input', {
      type: 'text', class: 'todo-input', value: draft.text,
      placeholder: 'Add a todo', 'aria-label': 'New todo text',
      oninput: (e) => { draft.text = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') submit(); },
    }),
    el('button', {
      class: 'todo-more', text: draftOpen ? '-' : '...',
      'aria-label': draftOpen ? 'Hide note and due date' : 'Add a note or due date',
      onclick: () => { draftOpen = !draftOpen; actions.repaint(); },
    }),
    el('button', { class: 'todo-go', text: 'Add', onclick: submit }),
  ]);

  // The disclosure keeps the common case - one field, one tap - uncluttered while
  // leaving the richer case one tap away.
  const extra = draftOpen
    ? el('div', { class: 'todo-extra' }, [
        noteField(draft.note, (v) => { draft.note = v; }),
        field('Due', draft.due, (v) => { draft.due = v; }, 'date'),
      ])
    : null;

  return el('div', {}, [main, extra]);
}

function editor(todo, actions) {
  const save = () => {
    if (!editDraft.text.trim()) return;
    actions.editTodo(todo._id, {
      text: editDraft.text,
      note: editDraft.note,
      due: editDraft.due || null,
    });
    editingId = null;
  };

  return el('div', { class: 'todo-editor' }, [
    field('Text', editDraft.text, (v) => { editDraft.text = v; }),
    noteField(editDraft.note, (v) => { editDraft.note = v; }),
    field('Due', editDraft.due, (v) => { editDraft.due = v; }, 'date'),
    el('div', { class: 'row' }, [
      el('button', { class: 'big', text: 'Save', onclick: save }),
      el('button', {
        class: 'big secondary', text: 'Cancel',
        onclick: () => { editingId = null; actions.repaint(); },
      }),
    ]),
    // Delete is the only irreversible action in the feature, so it is separated
    // from Save and Cancel and takes a confirm step.
    el('button', {
      class: 'big danger', text: 'Delete',
      onclick: () => {
        if (window.confirm(`Delete "${todo.text}"? This cannot be undone.`)) {
          editingId = null;
          actions.deleteTodo(todo._id);
        }
      },
    }),
  ]);
}

function todoRow(todo, todayStr, actions) {
  const overdue = isOverdue(todo, todayStr);

  const due = todo.due
    ? el('span', { class: overdue ? 'todo-due bad' : 'todo-due', text: todo.due })
    : null;

  const noteMark = todo.note ? el('span', { class: 'todo-note-mark', text: 'note' }) : null;

  return el('li', { class: todo.done ? 'block todo done' : 'block todo' }, [
    el('button', {
      class: todo.done ? 'tick on' : 'tick',
      text: todo.done ? 'Y' : '',
      'aria-label': `${todo.done ? 'Untick' : 'Tick'} ${todo.text}`,
      onclick: () => actions.setTodoDone(todo._id, !todo.done),
    }),
    el('button', {
      class: 'todo-body',
      'aria-label': `Edit ${todo.text}`,
      onclick: () => {
        editingId = todo._id;
        editDraft = { text: todo.text, note: todo.note, due: todo.due ?? '' };
        actions.repaint();
      },
    }, [
      el('span', { class: 'todo-text', text: todo.text }),
      due,
      noteMark,
    ]),
    el('button', {
      class: todo.pinned ? 'todo-pin on' : 'todo-pin',
      text: 'P',
      'aria-label': `${todo.pinned ? 'Unpin' : 'Pin'} ${todo.text}`,
      onclick: () => actions.setTodoPinned(todo._id, !todo.pinned),
    }),
  ]);
}

export function render(state, actions) {
  const { todos, today } = state;

  const open = sortOpen(todos);
  const archive = sortArchive(todos);

  const openList = open.length
    ? el('ul', { class: 'blocks' }, open.flatMap(t => [
        todoRow(t, today, actions),
        editingId === t._id ? el('li', { class: 'todo-editor-row' }, [editor(t, actions)]) : null,
      ].filter(Boolean)))
    : el('p', { class: 'budget', text: 'Nothing on the list.' });

  // Collapsed by default because the archive is kept forever and would otherwise
  // bury the open list.
  const archiveHead = el('button', {
    class: 'todo-archive-head',
    text: `${archiveOpen ? '-' : '+'} Done (${archive.length})`,
    onclick: () => { archiveOpen = !archiveOpen; actions.repaint(); },
  });

  const archiveList = archiveOpen && archive.length
    ? el('ul', { class: 'blocks' }, archive.flatMap(t => [
        todoRow(t, today, actions),
        editingId === t._id ? el('li', { class: 'todo-editor-row' }, [editor(t, actions)]) : null,
      ].filter(Boolean)))
    : null;

  return el('section', {}, [
    addRow(actions),
    openList,
    archiveHead,
    archiveList,
  ]);
}
