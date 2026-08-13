// Owns everything about where the night starts and ends: resolving the
// template defaults against a day's overrides, counting down to whichever end
// comes next, and deciding how loudly to say so. Pure, like clock.js: time
// arrives as an hhmm string so every state is testable and inspectable through
// window.__schedule.freeze().

import { toMinutes } from './schedule.js';
import { shiftDate } from './dates.js';

export function effectiveTimes(template, day) {
  return {
    wake: day?.wakeOverride ?? template.wake,
    sleep: day?.sleepOverride ?? template.sleep,
  };
}

const TOKEN = /\{(wake|sleep)\}/g;

// Check labels carry {wake}/{sleep} rather than literal times, because a
// literal drifts: sleep-cap said "awake by 06:30" while template.wake was
// "06:00". These resolve against the TEMPLATE values, never the overridden
// ones, or the check would be satisfiable just by nudging.
export function resolveLabel(label, times) {
  return label.replace(TOKEN, (_, key) => times[key]);
}

const DAY_MINUTES = 24 * 60;

function levelFor(minutes) {
  if (minutes <= 15) return 'urgent';
  if (minutes <= 60) return 'warn';
  return 'normal';
}

// The wake a nudge should move is the next one that has not happened yet:
// today's if we are still pre-dawn, otherwise tomorrow's. This is the same
// date bedtimeCountdown targets, so the control and the number it changes
// never disagree.
export function wakeTargetDate({ template, day, dateStr, hhmm }) {
  const { wake } = effectiveTimes(template, day);
  return toMinutes(hhmm) < toMinutes(wake) ? dateStr : shiftDate(dateStr, 1);
}

// Unbounded in both directions, per the design. Wrapping rather than clamping
// keeps repeated taps meaningful at the extremes instead of dead-ending.
export function shiftTime(hhmm, deltaMinutes) {
  const total = ((toMinutes(hhmm) + deltaMinutes) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES;
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}

export function bedtimeCountdown({ template, day, nextDay, dateStr, hhmm }) {
  const now = toMinutes(hhmm);
  const { wake, sleep } = effectiveTimes(template, day);

  // Pre-dawn. Still counting to this morning, not forward to tonight.
  if (now < toMinutes(wake)) {
    return {
      phase: 'until-wake', minutes: toMinutes(wake) - now,
      level: 'normal', targetDate: dateStr,
    };
  }

  if (now < toMinutes(sleep)) {
    const minutes = toMinutes(sleep) - now;
    return { phase: 'until-sleep', minutes, level: levelFor(minutes), targetDate: dateStr };
  }

  // Past bedtime. Urgency is deliberately dropped here: it exists to prompt
  // winding down, and that moment has gone.
  const targetDate = shiftDate(dateStr, 1);
  const { wake: nextWake } = effectiveTimes(template, nextDay);
  return {
    phase: 'until-wake', minutes: (DAY_MINUTES - now) + toMinutes(nextWake),
    level: 'normal', targetDate,
  };
}
