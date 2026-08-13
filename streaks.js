import { resolveBlocks, listKey } from './schedule.js';
import { dowOf } from './clock.js';
import { isRestDay } from './campaign.js';
import { checkActiveOn } from './checks.js';
import { daysBetween } from './dates.js';

const MS_PER_DAY = 86_400_000;

function utcMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function toDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function weekKeyOf(dateStr) {
  const dow = dowOf(dateStr);
  const offset = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(dow);
  return toDateStr(utcMs(dateStr) - offset * MS_PER_DAY);
}

export function isLocked(dateStr, today, backfillDays) {
  return daysBetween(dateStr, today) > backfillDays;
}

// A block-sourced streak is satisfied when every block tagged with the streak id
// in the *chosen* branch is done. An unchosen branching day has no answer yet.
//
// Returns 'skipped' when no block carries the id at all, which is what
// appliesOn already means: the streak does not apply that day. Without it,
// removing the last tagged block scores every past day as missed, burns two
// grace days a week and then resets a streak whose whole value was its length.
// It covers a template removal and a per-date override that drops the block
// identically, because both arrive here as an empty tagged set.
function blockSatisfied(template, streakId, dateStr, doc) {
  const dow = dowOf(dateStr);
  const day = template.days[dow];
  if (day.branching && !doc?.branch) return false;
  const tagged = resolveBlocks(template, dow, day.branching ? doc.branch : null, doc)
    .filter(b => b.streakId === streakId);
  if (tagged.length === 0) return 'skipped';
  return tagged.every(b => doc?.blocks?.[b.id]?.done === true);
}

function campaignSatisfied(template, dateStr, doc) {
  const dow = dowOf(dateStr);
  const day = template.days[dow];
  if (day.branching && !doc?.branch) return false;
  const slot = resolveBlocks(template, dow, day.branching ? doc.branch : null, doc)
    .find(b => b.campaignSlot);
  // An override can drop the slot entirely. Reading .id off undefined took the
  // Streaks tab down; the day simply has no campaign block to judge.
  if (!slot) return 'skipped';
  return doc?.blocks?.[slot.id]?.done === true;
}

export function dayStatus({ template, campaign, streak, streakId, dateStr, doc, today, backfillDays }) {
  if (dateStr > today) return 'skipped';
  if (!streak.appliesOn.includes(dowOf(dateStr))) return 'skipped';
  if (streak.source === 'campaign' && isRestDay(campaign, dateStr)) return 'skipped';

  // A check-sourced streak cannot be missed on a day its check did not apply on.
  // Scoring those days as failures would spend the weekly grace budget on a
  // habit that was deliberately retired, and then break the streak outright.
  // A streak whose check has vanished entirely is treated the same way rather
  // than throwing, so a half applied edit never takes the Streaks tab down.
  if (streak.source === 'check') {
    const check = template.checks[streakId];
    if (!check || !checkActiveOn(check, dateStr)) return 'skipped';
  }

  // Block and campaign streaks are evaluated against the CURRENT template, so
  // adding a block tagged with an existing streak, or moving the campaign slot,
  // would make every past day of that weekday demand something that did not
  // exist then: every one scores missed, two grace days a week are spent, and a
  // forty day streak becomes a four day streak because of an edit made this
  // morning. daysStreakEpoch records when that weekday's list last changed in a
  // way streaks can see, and days before it get no vote.
  //
  // It only moves when streakSignature changes, so a retime, a relabel, a
  // reprice and a recolour all skip nothing. A branching day with no branch
  // chosen has no list to key on and is left to the existing branch check.
  if (streak.source === 'block' || streak.source === 'campaign') {
    const dow = dowOf(dateStr);
    const day = template.days[dow];
    const branch = day.branching ? (doc?.branch ?? null) : null;
    if (!day.branching || branch) {
      const epoch = template.daysStreakEpoch?.[listKey(dow, branch)] ?? null;
      if (epoch && dateStr < epoch) return 'skipped';
    }
  }

  let satisfied;
  if (streak.source === 'check') satisfied = doc?.checks?.[streakId]?.done === true;
  else if (streak.source === 'campaign') satisfied = campaignSatisfied(template, dateStr, doc);
  else satisfied = blockSatisfied(template, streakId, dateStr, doc);

  if (satisfied === 'skipped') return 'skipped';
  if (satisfied) return 'satisfied';
  // Nothing recorded and still inside the window: unknown, not failed.
  if (!isLocked(dateStr, today, backfillDays)) return 'open';
  return 'missed';
}

export function evaluateStreak({ template, campaign, streakId, dayDocs, from, today }) {
  const streak = template.streaks[streakId];
  if (!streak) throw new Error(`unknown streak: ${streakId}`);
  const backfillDays = template.backfillDays;
  const graceBudget = template.graceDaysPerWeek;

  const byDate = new Map(dayDocs.map(d => [d.date, d]));

  let current = 0;
  let best = 0;
  let provisional = false;
  const graceUsed = new Map();

  for (let ms = utcMs(from); ms <= utcMs(today); ms += MS_PER_DAY) {
    const dateStr = toDateStr(ms);
    const status = dayStatus({
      template, campaign, streak, streakId, dateStr,
      doc: byDate.get(dateStr), today, backfillDays,
    });

    if (status === 'skipped') continue;
    if (status === 'open') { provisional = true; continue; }

    if (status === 'satisfied') {
      current += 1;
    } else {
      const wk = weekKeyOf(dateStr);
      const used = graceUsed.get(wk) ?? 0;
      if (used < graceBudget) {
        graceUsed.set(wk, used + 1);
        current += 1;
      } else {
        current = 0;
      }
    }
    best = Math.max(best, current);
  }

  const thisWeek = graceUsed.get(weekKeyOf(today)) ?? 0;
  return {
    current,
    best,
    provisional,
    graceUsedThisWeek: thisWeek,
    graceRemaining: graceBudget - thisWeek,
  };
}
