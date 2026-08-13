import { el, fmtMins } from './render.js';
import { dowOf } from '../clock.js';
import { shiftDate } from '../dates.js';
import { blocksFor, resolveBlocks, toMinutes } from '../schedule.js';
import {
  STEP_MINUTES, toHHMM, moveBoundary, placeBlock, removeBlock, editFields, validateList,
} from '../block-edit.js';

const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const LABEL = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

// Module scope, deliberately: app.js rebuilds this screen from scratch every
// thirty seconds, so a draft held inside render() would erase itself mid-edit.
let dow = 'mon';
let branch = 'A';
let scope = 'template';
let draft = null;
let note = null;
let sheet = null;          // block id whose field sheet is open, or 'new'
let form = {};             // the open sheet's field values
let error = null;

export function openFor(dateStr, dayBranch) {
  dow = dowOf(dateStr);
  branch = dayBranch ?? 'A';
  scope = 'template';
  draft = null;
  note = null;
  sheet = null;
  form = {};
  error = null;
}

const branching = (template) => template.days[dow].branching;
const branchOf = (template) => (branching(template) ? branch : null);
const mins = (b) => toMinutes(b.end) - toMinutes(b.start);

// Date scope targets the next occurrence of the chosen weekday, including
// today. "Just Tue 18 Aug" has to name one actual date, and the next one is
// the only one an edit can still be acted on.
function targetDate(today) {
  for (let i = 0; i < 7; i++) {
    const d = shiftDate(today, i);
    if (dowOf(d) === dow) return d;
  }
  return today;
}

function source(state, actions) {
  const b = branchOf(state.template);
  if (scope === 'date') {
    const dateStr = targetDate(state.today);
    return resolveBlocks(state.template, dow, b, actions.dayFor(dateStr));
  }
  return blocksFor(state.template, dow, b);
}

// The effect line. Computed by diffing the pure function's own result, so the
// text can never disagree with what was actually applied.
function effect(before, after) {
  const was = new Map(before.map(b => [b.id, b]));
  const now = new Set(after.map(b => b.id));
  const parts = [];
  for (const b of after) {
    const old = was.get(b.id);
    if (!old) parts.push(`${b.label} added, ${fmtMins(mins(b))}`);
    else if (old.start !== b.start || old.end !== b.end) {
      parts.push(`${b.label} ${fmtMins(mins(old))} -> ${fmtMins(mins(b))}`);
    }
  }
  for (const b of before) if (!now.has(b.id)) parts.push(`${b.label} removed`);
  return parts.join(', ');
}

function apply(state, actions, op) {
  const before = draft ?? source(state, actions);
  try {
    const after = op(before);
    note = effect(before, after);
    draft = after;
    error = null;
  } catch (err) {
    error = err.message;
  }
  actions.repaint();
}

function slotMissing(blocks) {
  return blocks.filter(b => b.campaignSlot).length !== 1;
}

function field(labelText, node) {
  return el('label', { class: 'field' }, [el('span', { text: labelText }), node]);
}

function textInput(key, value, placeholder = '') {
  form[key] = form[key] ?? value ?? '';
  return el('input', {
    type: 'text', value: form[key], placeholder,
    oninput: (e) => { form[key] = e.target.value; },
  });
}

function select(key, value, options) {
  form[key] = form[key] ?? value ?? '';
  const node = el('select', { onchange: (e) => { form[key] = e.target.value; } },
    options.map(([v, text]) => el('option', { value: v, text, selected: v === form[key] ? '' : null })));
  return node;
}

function fieldSheet(state, actions, blocks) {
  const template = state.template;
  const block = blocks.find(b => b.id === sheet);
  if (!block) { sheet = null; return null; }

  const attrs = Object.entries(template.attributes).map(([id, a]) => [id, a.label ?? id]);
  const tasks = [['', 'No coins'], ...Object.entries(template.tasks).map(([id, t]) => [id, `${t.label} (${t.coins})`]), ['__new', 'New task...']];
  const streaks = [['', 'No streak'], ...Object.entries(template.streaks).map(([id, s]) => [id, s.label])];

  const rows = [
    field('Label', textInput('label', block.label)),
    field('Detail', textInput('detail', block.detail)),
    field('Attribute', select('attribute', block.attribute, attrs)),
    field('Task', select('taskId', block.taskId ?? '', tasks)),
    field('Streak', select('streakId', block.streakId ?? '', streaks)),
  ];

  if (form.taskId === '__new') {
    rows.push(field('New task label', textInput('newTaskLabel', block.label)));
    rows.push(field('New task coins', textInput('newTaskCoins', '10')));
  }

  rows.push(el('div', { class: 'row' }, [
    el('button', {
      class: block.campaignSlot ? 'big' : 'big secondary',
      text: block.campaignSlot ? 'Sermon slot' : 'Make this the sermon slot',
      disabled: block.campaignSlot ? '' : null,
      onclick: () => apply(state, actions, (bs) => editFields(bs, block.id, { campaignSlot: true })),
    }),
  ]));

  rows.push(el('div', { class: 'row' }, [
    el('button', {
      class: 'big', text: 'Save fields',
      onclick: async () => {
        let taskId = form.taskId === '' ? null : form.taskId;
        if (form.taskId === '__new') {
          taskId = await actions.addTask({
            label: form.newTaskLabel, attribute: form.attribute,
            coins: Number(form.newTaskCoins),
          });
          if (!taskId) return;   // the error banner already says why
        }
        apply(state, actions, (bs) => editFields(bs, block.id, {
          label: form.label, detail: form.detail, attribute: form.attribute,
          taskId, streakId: form.streakId === '' ? null : form.streakId,
        }));
        sheet = null; form = {};
        actions.repaint();
      },
    }),
    el('button', {
      class: 'big secondary', text: 'Remove block',
      onclick: () => {
        apply(state, actions, (bs) => removeBlock(bs, block.id, 'prev'));
        sheet = null; form = {};
        actions.repaint();
      },
    }),
    el('button', {
      class: 'secondary', text: 'Cancel',
      onclick: () => { sheet = null; form = {}; actions.repaint(); },
    }),
  ]));

  return el('section', { class: 'sheet' }, [el('h2', { text: block.label }), ...rows]);
}

function addSheet(state, actions, blocks) {
  const attrs = Object.entries(state.template.attributes).map(([id, a]) => [id, a.label ?? id]);
  const prefix = scope === 'date' ? targetDate(state.today) : dow;
  return el('section', { class: 'sheet' }, [
    el('h2', { text: 'Add a block' }),
    field('Label', textInput('label', '')),
    field('Attribute', select('attribute', 'lifeskills', attrs)),
    field('Start', textInput('start', blocks[0].start)),
    field('End', textInput('end', blocks[0].end)),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'big', text: 'Place it',
        onclick: () => {
          const slug = String(form.label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          apply(state, actions, (bs) => placeBlock(bs, {
            start: form.start, end: form.end, id: `${prefix}-${slug || 'block'}`,
            takenIds: allIds(state.template, bs),
            fields: { label: form.label, attribute: form.attribute },
          }));
          if (!error) { sheet = null; form = {}; }
          actions.repaint();
        },
      }),
      el('button', {
        class: 'secondary', text: 'Cancel',
        onclick: () => { sheet = null; form = {}; actions.repaint(); },
      }),
    ]),
  ]);
}

// Block ids are globally unique, so a new id must dodge every list, not just
// the one on screen. The draft's own ids are included because a block added
// and not yet saved is not in the template either.
function allIds(template, blocks) {
  const ids = new Set(blocks.map(b => b.id));
  for (const day of Object.values(template.days)) {
    const lists = day.branching ? Object.values(day.branches) : [day.blocks];
    for (const list of lists) for (const b of list) ids.add(b.id);
  }
  return ids;
}

export function render(state, actions) {
  const { template, today } = state;
  const b = branchOf(template);
  const blocks = draft ?? source(state, actions);
  const dateStr = targetDate(today);

  const dayPicker = el('div', { class: 'row wrap' }, DOWS.map(d => el('button', {
    class: d === dow ? 'tab active' : 'tab',
    text: LABEL[d],
    onclick: () => { dow = d; branch = 'A'; draft = null; note = null; actions.repaint(); },
  })));

  const branchRow = branching(template)
    ? el('div', { class: 'row' }, ['A', 'B'].map(x => el('button', {
        class: x === branch ? 'big' : 'big secondary',
        text: x === 'A' ? 'A: campus' : 'B: home',
        onclick: () => { branch = x; draft = null; note = null; actions.repaint(); },
      })))
    : null;

  const scopeRow = el('div', { class: 'row' }, [
    el('button', {
      class: scope === 'template' ? 'big' : 'big secondary',
      text: `Every ${LABEL[dow]}`,
      onclick: () => { scope = 'template'; draft = null; note = null; actions.repaint(); },
    }),
    el('button', {
      class: scope === 'date' ? 'big' : 'big secondary',
      text: `Just ${LABEL[dow]} ${dateStr.slice(8)} ${dateStr.slice(5, 7)}`,
      onclick: () => { scope = 'date'; draft = null; note = null; actions.repaint(); },
    }),
  ]);

  const rows = el('ul', { class: 'blocks editing' }, blocks.map((blk, i) => {
    const attr = blk.attribute ? template.attributes[blk.attribute] : null;
    const last = i === blocks.length - 1;
    return el('li', { class: blk.campaignSlot ? 'block slot' : 'block' }, [
      el('span', { class: 'block-time', text: `${blk.start}-${blk.end}` }),
      attr ? el('span', { class: 'block-attr', style: `background: ${attr.color}` }) : null,
      el('button', {
        class: 'block-label linky', text: blk.label,
        onclick: () => { sheet = blk.id; form = {}; actions.repaint(); },
      }),
      last ? null : el('button', {
        class: 'step', text: '-', 'aria-label': `Shorten ${blk.label}`,
        onclick: () => apply(state, actions,
          (bs) => moveBoundary(bs, i, toHHMM(toMinutes(bs[i].end) - STEP_MINUTES))),
      }),
      last ? null : el('button', {
        class: 'step', text: '+', 'aria-label': `Lengthen ${blk.label}`,
        onclick: () => apply(state, actions,
          (bs) => moveBoundary(bs, i, toHHMM(toMinutes(bs[i].end) + STEP_MINUTES))),
      }),
    ]);
  }));

  const missing = slotMissing(blocks);
  const banner = missing
    ? el('p', { class: 'error', text: 'This day has no sermon slot. Open a block and make it the slot before saving.' })
    : null;

  const controls = el('div', { class: 'row' }, [
    el('button', {
      class: 'big', text: scope === 'template' ? 'Save the weekly pattern' : `Save just ${dateStr}`,
      disabled: (!draft || missing) ? '' : null,
      onclick: async () => {
        if (scope === 'template') await actions.saveBlockList({ dow, branch: b, blocks });
        else await actions.saveBlockOverride({ dateStr, blocks });
        draft = null; note = null;
        actions.repaint();
      },
    }),
    el('button', {
      class: 'secondary', text: 'Discard',
      disabled: draft ? null : '',
      onclick: () => { draft = null; note = null; error = null; actions.repaint(); },
    }),
    el('button', { class: 'secondary', text: 'Add block',
                   onclick: () => { sheet = 'new'; form = {}; actions.repaint(); } }),
  ]);

  const backToUsual = (scope === 'date' && actions.dayFor(dateStr)?.blocksOverride)
    ? el('button', {
        class: 'secondary', text: `Back to the usual ${LABEL[dow]}`,
        onclick: async () => {
          await actions.clearBlockOverride({ dateStr });
          draft = null; note = null;
          actions.repaint();
        },
      })
    : null;

  const openSheet = sheet === 'new'
    ? addSheet(state, actions, blocks)
    : sheet ? fieldSheet(state, actions, blocks) : null;

  return el('section', {}, [
    el('div', { class: 'daynav' }, [
      el('b', { text: 'Blocks' }),
      el('button', { text: 'Done', onclick: () => actions.go('day') }),
    ]),
    dayPicker,
    branchRow,
    scopeRow,
    error ? el('p', { class: 'error', text: error }) : null,
    banner,
    note ? el('p', { class: 'budget', text: note }) : null,
    rows,
    controls,
    backToUsual,
    openSheet,
  ]);
}
