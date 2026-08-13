import { el } from './render.js';
import { evaluateStreak, dayStatus } from '../streaks.js';
import { shiftDate, eachDate } from '../dates.js';
import { checkActiveOn } from '../checks.js';

const WINDOW = 30;

// Evaluation walks forward from the first day ever recorded. With no day
// documents at all there is nothing to walk, so the window starts at today and
// every streak reads zero rather than throwing on an undefined start date.
function startDate(days, today) {
  return days.length ? days.map(d => d.date).sort()[0] : today;
}

export function render(state) {
  const { template, campaign, days, today } = state;
  const from = startDate(days, today);
  const window = eachDate(shiftDate(today, -(WINDOW - 1)), today);
  const byDate = new Map(days.map(d => [d.date, d]));

  // A retired check's streak would otherwise sit here forever showing a number
  // frozen at the day it stopped applying, which reads as a live streak.
  const tracked = Object.entries(template.streaks).filter(([streakId, streak]) => {
    if (streak.source !== 'check') return true;
    const check = template.checks[streakId];
    return Boolean(check) && checkActiveOn(check, today);
  });

  const rows = tracked.map(([streakId, streak]) => {
    const result = evaluateStreak({ template, campaign, streakId, dayDocs: days, from, today });

    const mini = el('div', { class: 'mini' }, window.map((dateStr) => {
      const status = dayStatus({
        template, campaign, streak, streakId, dateStr,
        doc: byDate.get(dateStr), today, backfillDays: template.backfillDays,
      });
      // 'skipped' days keep the default grey: a Tuesday is not a failed workout.
      const cls = status === 'satisfied' ? 'done'
        : status === 'missed' ? 'missed'
        : status === 'open' ? 'open' : '';
      return el('span', { class: cls, title: `${dateStr}: ${status}` });
    }));

    return el('div', { class: 'streak' }, [
      el('div', { class: 'streak-head' }, [
        el('span', { class: 'streak-name', text: streak.label }),
        el('span', { class: 'streak-num', text: String(result.current) }),
      ]),
      el('div', { class: 'streak-sub', text:
        `best ${result.best}, grace left this week ${result.graceRemaining} of ${template.graceDaysPerWeek}` }),
      result.provisional
        ? el('div', { class: 'provisional', text: 'provisional, an unresolved day is still open' })
        : null,
      mini,
    ]);
  });

  return el('section', {}, [
    el('p', { class: 'streak-sub', text: `Last ${WINDOW} days. Green is done, red is a miss, hatched is still open for backfill.` }),
    ...rows,
  ]);
}
