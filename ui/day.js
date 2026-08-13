import { el } from './render.js';
import { currentBlock, dowOf } from '../clock.js';
import { resolveBlocks, sumHours } from '../schedule.js';
import { isLocked } from '../streaks.js';
import { shiftDate } from '../dates.js';
import { resolveLabel, effectiveTimes } from '../bedtime.js';
import { activeChecks } from '../checks.js';
import { openFor } from './blocks.js';

// Module scope, deliberately. app.js rebuilds this screen from scratch on every
// paint, including the 30-second tick, so an offset held inside render() would
// reset itself while you were reading the day you navigated to.
let offset = 0;

// Navigation reaches further back than the backfill window on purpose: the spec
// requires older days to render read-only and locked, which is only visible if
// you can get to them. Editing is what the window restricts, not looking.
const MAX_BACK = 30;

function tickButton(label, isDone, locked, onclick) {
  return el('button', {
    class: isDone ? 'tick on' : 'tick',
    text: isDone ? 'Y' : '',
    'aria-label': `${isDone ? 'Untick' : 'Tick'} ${label}`,
    disabled: locked ? '' : null,
    onclick,
  });
}

function dayLabel(dateStr, dow, offsetDays) {
  if (offsetDays === 0) return `Today, ${dow} ${dateStr}`;
  if (offsetDays === -1) return `Yesterday, ${dow} ${dateStr}`;
  return `${-offsetDays} days ago, ${dow} ${dateStr}`;
}

export function render(state, actions) {
  const { template, today, hhmm } = state;
  const backfill = template.backfillDays;

  if (offset > 0) offset = 0;
  if (offset < -MAX_BACK) offset = -MAX_BACK;

  const dateStr = shiftDate(today, offset);
  const dow = dowOf(dateStr);
  const locked = isLocked(dateStr, today, backfill);
  const doc = actions.dayFor(dateStr);
  const branching = template.days[dow].branching;
  const branch = branching ? (doc?.branch ?? null) : null;

  const nav = el('div', { class: 'daynav' }, [
    el('button', {
      text: '<',
      'aria-label': 'Previous day',
      disabled: offset <= -MAX_BACK ? '' : null,
      onclick: () => { offset -= 1; actions.repaint(); },
    }),
    el('b', { text: dayLabel(dateStr, dow, offset) }),
    el('button', {
      text: '>',
      'aria-label': 'Next day',
      disabled: offset >= 0 ? '' : null,
      onclick: () => { offset += 1; actions.repaint(); },
    }),
  ]);

  const note = locked
    ? el('p', { class: 'locked-note', text: `Locked. Days more than ${backfill} days old are read-only.` })
    : null;

  // A branching day whose branch was never chosen has two possible schedules and
  // therefore no list to draw. Offer the choice instead of guessing one.
  const branchRow = branching
    ? el('div', { class: 'row' }, ['A', 'B'].map(b => el('button', {
        class: b === branch ? 'big' : 'big secondary',
        text: b === 'A' ? 'A: went to campus' : 'B: worked from home',
        disabled: locked ? '' : null,
        onclick: () => actions.setBranch(dateStr, b),
      })))
    : null;

  if (branching && !branch) {
    return el('section', {}, [
      nav,
      note,
      el('p', { class: 'budget', text: 'Pick the branch this day ran on to see its blocks.' }),
      branchRow,
    ]);
  }

  const blocks = resolveBlocks(template, dow, branch, doc);
  const currentId = dateStr === today
    ? (currentBlock(template, dow, branch, hhmm, doc).block?.id ?? null)
    : null;

  const doneHours = blocks
    .filter(b => doc?.blocks?.[b.id]?.done === true)
    .reduce((acc, b) => acc + b.hours, 0);

  const budget = el('p', {
    class: 'budget',
    text: `${doneHours.toFixed(1)}h logged of ${sumHours(blocks).toFixed(1)}h`,
  });

  const list = el('ul', { class: 'blocks' }, blocks.map((b) => {
    const isDone = doc?.blocks?.[b.id]?.done === true;
    // A tombstone is a block this date was overridden to include that the
    // template no longer has. It keeps its interval so the day still adds up,
    // and it resolves with a null attribute, so there is no colour to look up.
    const attr = b.attribute ? template.attributes[b.attribute] : null;
    const classes = ['block'];
    if (b.id === currentId) classes.push('current');
    if (locked) classes.push('locked');
    if (b.tombstone) classes.push('tombstone');
    return el('li', { class: classes.join(' ') }, [
      el('span', { class: 'block-time', text: `${b.start}-${b.end}` }),
      attr ? el('span', { class: 'block-attr', style: `background: ${attr.color}` }) : null,
      el('span', { class: 'block-label', text: b.label }),
      b.tombstone ? null : tickButton(b.label, isDone, locked,
        () => actions.toggleBlock(dateStr, b.id, !isDone)),
    ]);
  }));

  // Checks are not blocks: they consume no hours, which is why they sit outside
  // the budget count above rather than being folded into it. The list is also
  // date-scoped, so navigating to a past day shows the checks that applied then
  // and not the ones added since.
  const checks = el('ul', { class: 'blocks' },
    activeChecks(template, dateStr).map(([id, check]) => {
      const isDone = doc?.checks?.[id]?.done === true;
      const attr = template.attributes[check.attribute];
      const label = resolveLabel(check.label, { wake: template.wake, sleep: template.sleep });
      const eff = effectiveTimes(template, doc);
      const moved = id === 'sleep-cap' && (doc?.sleepOverride || doc?.wakeOverride)
        ? el('small', { class: 'drift', text: `tonight ${eff.sleep} -> ${eff.wake}` })
        : null;
      return el('li', { class: locked ? 'block locked' : 'block' }, [
        el('span', { class: 'block-attr', style: `background: ${attr.color}` }),
        el('span', { class: 'block-label' }, [el('span', { text: label }), moved]),
        tickButton(label, isDone, locked,
          () => actions.toggleCheck(dateStr, id, !isDone)),
      ]);
    }));

  return el('section', {}, [
    nav,
    note,
    budget,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'secondary', text: 'Edit blocks',
        onclick: () => { openFor(dateStr, branch); actions.go('blocks'); },
      }),
    ]),
    list,
    branchRow ? el('h2', { text: 'Branch' }) : null,
    branchRow,
    el('div', { class: 'section-head' }, [
      el('h2', { text: 'Checks' }),
      el('button', {
        class: 'link',
        text: 'Edit',
        'aria-label': 'Edit checks',
        onclick: () => actions.go('checks'),
      }),
    ]),
    checks,
  ]);
}
