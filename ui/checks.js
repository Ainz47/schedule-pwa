import { el } from './render.js';
import { checkActiveOn } from '../checks.js';
import { defaultRetireDate } from '../template-edit.js';

// Module scope for the same reason day.js holds its offset there: paint() runs
// every 30 seconds and rebuilds this screen, so an editor open inside render()
// would close itself under the user's hands.
//
// null means the list; 'new' means the create form; any other string is the id
// of the check being edited.
let editing = null;

// The form's live values, so a repaint mid-edit does not lose typing.
let draft = null;

function newDraft(today) {
  return { label: '', attribute: 'vitality', coins: 0, activeFrom: today, streakDays: [] };
}

function draftFrom(check, template) {
  const task = check.taskId ? template.tasks[check.taskId] : null;
  return {
    label: check.label,
    attribute: check.attribute,
    coins: task ? task.coins : 0,
    activeFrom: check.activeFrom,
    streakDays: [],
  };
}

function field(labelText, control) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label', text: labelText }),
    control,
  ]);
}

function attributeSelect(template, value) {
  const select = el('select', { class: 'field-input' },
    Object.entries(template.attributes).map(([id, attr]) =>
      el('option', { value: id, text: attr.label, selected: id === value ? '' : null })));
  select.addEventListener('change', () => { draft.attribute = select.value; });
  return select;
}

const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function dayPicker() {
  return el('div', { class: 'day-picker' }, DOWS.map((dow) => {
    const on = draft.streakDays.includes(dow);
    return el('button', {
      type: 'button',
      class: on ? 'day-pick on' : 'day-pick',
      text: dow[0].toUpperCase(),
      'aria-label': dow,
      'aria-pressed': on ? 'true' : 'false',
      onclick: (ev) => {
        draft.streakDays = on
          ? draft.streakDays.filter(d => d !== dow)
          : [...draft.streakDays, dow];
        // Repaint just this control rather than the screen, so focus and any
        // half typed label survive.
        const btn = ev.currentTarget;
        const nowOn = draft.streakDays.includes(dow);
        btn.className = nowOn ? 'day-pick on' : 'day-pick';
        btn.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
      },
    });
  }));
}

function form(state, actions, checkId) {
  const { template, today } = state;
  const isNew = checkId === 'new';
  const check = isNew ? null : template.checks[checkId];

  const labelInput = el('input', {
    class: 'field-input', type: 'text', maxlength: '60', value: draft.label,
    placeholder: 'Read scripture',
  });
  labelInput.addEventListener('input', () => { draft.label = labelInput.value; });

  const coinsInput = el('input', {
    class: 'field-input', type: 'number', min: '0', max: '999', step: '1',
    value: String(draft.coins),
  });
  coinsInput.addEventListener('input', () => { draft.coins = Number(coinsInput.value); });

  const fromInput = el('input', {
    class: 'field-input', type: 'date', value: draft.activeFrom,
  });
  fromInput.addEventListener('input', () => { draft.activeFrom = fromInput.value; });

  const streakToggle = el('input', { type: 'checkbox', class: 'field-check' });
  const picker = dayPicker();
  picker.hidden = true;
  streakToggle.addEventListener('change', () => {
    picker.hidden = !streakToggle.checked;
    if (!streakToggle.checked) draft.streakDays = [];
  });

  const save = el('button', {
    class: 'big', text: isNew ? 'Create check' : 'Save changes',
    onclick: async () => {
      if (isNew) {
        await actions.addCheck({
          label: draft.label, attribute: draft.attribute, coins: draft.coins,
          activeFrom: draft.activeFrom,
          streakDays: streakToggle.checked ? draft.streakDays : null,
        });
      } else {
        await actions.updateCheck({
          checkId, label: draft.label, attribute: draft.attribute, coins: draft.coins,
        });
      }
      // A validation failure leaves state.error set and the form open, so the
      // message is visible next to the field that caused it.
      if (!state.error) { editing = null; draft = null; }
      actions.repaint();
    },
  });

  const cancel = el('button', {
    class: 'big secondary', text: 'Cancel',
    onclick: () => { editing = null; draft = null; actions.repaint(); },
  });

  const retire = (!isNew && !check.retiredOn)
    ? el('button', {
        class: 'big secondary danger',
        text: `Retire from ${defaultRetireDate(today)}`,
        onclick: async () => {
          await actions.retireCheck({ checkId, retiredOn: defaultRetireDate(today) });
          if (!state.error) { editing = null; draft = null; }
          actions.repaint();
        },
      })
    : null;

  const unretire = (!isNew && check.retiredOn)
    ? el('button', {
        class: 'big secondary',
        text: 'Bring this check back',
        onclick: async () => {
          await actions.retireCheck({ checkId, retiredOn: null });
          if (!state.error) { editing = null; draft = null; }
          actions.repaint();
        },
      })
    : null;

  return el('div', { class: 'check-form' }, [
    el('h2', { text: isNew ? 'New check' : check.label }),
    field('Label', labelInput),
    field('Attribute', attributeSelect(template, draft.attribute)),
    field('Coins when ticked', coinsInput),
    isNew ? field('Applies from', fromInput) : null,
    isNew ? el('label', { class: 'field field-row' }, [
      streakToggle,
      el('span', { class: 'field-label', text: 'Track a streak for this' }),
    ]) : null,
    isNew ? picker : null,
    !isNew && check.retiredOn
      ? el('p', { class: 'locked-note', text: `Retired from ${check.retiredOn}.` })
      : null,
    el('div', { class: 'row' }, [save, cancel]),
    retire,
    unretire,
  ]);
}

function listRow(state, actions, checkId, check) {
  const { template } = state;
  const task = check.taskId ? template.tasks[check.taskId] : null;
  const attr = template.attributes[check.attribute];
  return el('li', { class: 'block' }, [
    el('span', { class: 'block-attr', style: `background: ${attr.color}` }),
    el('span', { class: 'block-label', text: check.label }),
    el('span', { class: 'block-time', text: task && task.coins > 0 ? `+${task.coins}` : '--' }),
    el('button', {
      class: 'tick',
      text: '>',
      'aria-label': `Edit ${check.label}`,
      onclick: () => {
        editing = checkId;
        draft = draftFrom(check, template);
        actions.repaint();
      },
    }),
  ]);
}

export function render(state, actions) {
  const { template, today } = state;

  const back = el('div', { class: 'daynav' }, [
    el('button', { text: '<', 'aria-label': 'Back to the day', onclick: () => actions.go('day') }),
    el('b', { text: 'Checks' }),
    el('span', {}),
  ]);

  if (editing) {
    if (!draft) draft = editing === 'new' ? newDraft(today) : draftFrom(template.checks[editing], template);
    return el('section', {}, [back, form(state, actions, editing)]);
  }

  const entries = Object.entries(template.checks);
  const active = entries.filter(([, c]) => checkActiveOn(c, today));
  const inactive = entries.filter(([, c]) => !checkActiveOn(c, today));

  return el('section', {}, [
    back,
    el('ul', { class: 'blocks' }, active.map(([id, c]) => listRow(state, actions, id, c))),
    el('button', {
      class: 'big',
      text: 'Add a check',
      onclick: () => { editing = 'new'; draft = newDraft(today); actions.repaint(); },
    }),
    inactive.length ? el('h2', { text: `Not currently active (${inactive.length})` }) : null,
    inactive.length
      ? el('ul', { class: 'blocks' }, inactive.map(([id, c]) => listRow(state, actions, id, c)))
      : null,
  ]);
}
