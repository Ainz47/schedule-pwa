import { el, svgEl, fmtMins } from './render.js';
import { currentBlock, dowOf } from '../clock.js';
import { earnedOn } from '../ledger.js';
import { daysRemaining } from '../campaign.js';
import { toMinutes } from '../schedule.js';
import { bedtimeCountdown, effectiveTimes, wakeTargetDate } from '../bedtime.js';
import { shiftDate } from '../dates.js';

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// The ring drains as the block runs out: a full ring means the block just
// started. dashoffset is measured from the start of the stroke, so the fraction
// still to run is 1 - offset/circumference.
function ring(fractionLeft, color, label) {
  const common = { cx: 66, cy: 66, r: RADIUS, fill: 'none', 'stroke-width': 10 };
  return svgEl('svg', { class: 'ring', width: 132, height: 132, viewBox: '0 0 132 132' }, [
    svgEl('circle', { ...common, class: 'ring-track' }),
    svgEl('circle', {
      ...common,
      class: 'ring-fill',
      stroke: color,
      'stroke-linecap': 'round',
      transform: 'rotate(-90 66 66)',
      'stroke-dasharray': CIRCUMFERENCE.toFixed(1),
      'stroke-dashoffset': (CIRCUMFERENCE * (1 - fractionLeft)).toFixed(1),
    }),
    svgEl('text', { class: 'ring-text', x: 66, y: 66, text: label }),
  ]);
}

function stat(label, value) {
  return el('span', {}, [
    el('span', { text: `${label} ` }),
    el('b', { text: String(value) }),
  ]);
}

function nudgeRow(label, time, onMinus, onPlus, onReset) {
  return el('div', { class: 'nudge' }, [
    el('span', { text: `${label} ${time}` }),
    el('button', { text: '-15', 'aria-label': `${label} 15 minutes earlier`, onclick: onMinus }),
    el('button', { text: '+15', 'aria-label': `${label} 15 minutes later`, onclick: onPlus }),
    onReset ? el('button', { text: 'Reset', 'aria-label': `Reset ${label}`, onclick: onReset }) : null,
  ]);
}

function bedtimeSection(state, actions) {
  const { template, today, hhmm } = state;
  const day = actions.dayFor(today);
  const nextDay = actions.dayFor(shiftDate(today, 1));
  const cd = bedtimeCountdown({ template, day, nextDay, dateStr: today, hhmm });
  const { sleep } = effectiveTimes(template, day);

  const line = el('div', { class: `countdown ${cd.level}` }, [
    el('b', { text: fmtMins(cd.minutes) }),
    el('span', { text: cd.phase === 'until-sleep' ? 'until sleep' : 'until wake' }),
  ]);

  const sleepRow = nudgeRow(
    'Bedtime', sleep,
    () => actions.nudgeSleep(today, -15),
    () => actions.nudgeSleep(today, 15),
    day?.sleepOverride ? () => actions.clearSleep(today) : null,
  );

  // The wake control appears only past bedtime, so each control sits beside
  // the countdown it changes. During the day a wake control would adjust a
  // number not on screen, and would read as editing the morning that already
  // happened.
  let wakeRow = null;
  if (cd.phase === 'until-wake') {
    const target = wakeTargetDate({ template, day, dateStr: today, hhmm });
    const targetDay = target === today ? day : nextDay;
    const { wake } = effectiveTimes(template, targetDay);
    wakeRow = nudgeRow(
      target === today ? 'Wake' : 'Wake tomorrow', wake,
      () => actions.nudgeWake(target, -15),
      () => actions.nudgeWake(target, 15),
      targetDay?.wakeOverride ? () => actions.clearWake(target) : null,
    );
  }

  return el('section', {}, [line, sleepRow, wakeRow]);
}

export function render(state, actions) {
  const { template, campaign, ledger, today, hhmm } = state;
  const doc = actions.dayFor(today);
  const dow = dowOf(today);
  const branch = template.days[dow].branching ? doc.branch : null;
  const cur = currentBlock(template, dow, branch, hhmm);

  // Deliberately the only week-scale numbers on this screen. Everything else
  // here is about the next thirty minutes.
  const strip = el('div', { class: 'strip' }, [
    stat('Coins today', earnedOn(ledger, today)),
    stat('To 13 Sep', `${daysRemaining(campaign, today)}d`),
  ]);

  if (cur.status === 'off-hours') {
    const card = el('section', { class: 'now-card' }, [
      el('p', { class: 'now-label', text: 'Off hours' }),
      el('p', {
        class: 'now-time',
        text: cur.next ? `Next ${cur.next.start} ${cur.next.label}` : 'Day is done.',
      }),
      cur.next
        ? el('p', { class: 'now-detail', text: `Starts in ${fmtMins(cur.minutesLeft)}.` })
        : null,
    ]);
    return el('section', {}, [card, bedtimeSection(state, actions), strip]);
  }

  const block = cur.block;
  const attr = template.attributes[block.attribute];
  const length = toMinutes(block.end) - toMinutes(block.start);
  const done = doc?.blocks?.[block.id]?.done === true;

  const card = el('section', {
    class: 'now-card',
    style: `border-left-color: ${attr.color}`,
  }, [
    ring(cur.minutesLeft / length, attr.color, fmtMins(cur.minutesLeft)),
    el('p', { class: 'now-label', text: block.label }),
    el('p', { class: 'now-time', text: `${block.start} to ${block.end}, ${attr.label}` }),
    block.detail ? el('p', { class: 'now-detail', text: block.detail }) : null,
    cur.next
      ? el('p', { class: 'now-next', text: `Next ${cur.next.start} ${cur.next.label}` })
      : null,
  ]);

  const button = el('button', {
    class: done ? 'big done' : 'big',
    text: done ? 'Done, tap to undo' : 'Mark done',
    onclick: () => actions.toggleBlock(today, block.id, !done),
  });

  return el('section', {}, [card, button, bedtimeSection(state, actions), strip]);
}
