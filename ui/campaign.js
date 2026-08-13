import { el } from './render.js';
import { dayFor, daysRemaining } from '../campaign.js';
import { dowOf } from '../clock.js';
import { blocksFor } from '../schedule.js';

// The spec names Aug 31 and Sep 2, 4, 7 and 9 as the heavy days. Those are
// exactly the days of 35 minutes or more, so this derives the mark from the plan
// instead of hardcoding five dates that would silently rot if the plan changed.
const HEAVY_MINUTES = 35;

// Completion is not stored on the campaign document. It lives on the day
// document against that day's campaignSlot block, so there is only ever one
// mutable record of "did I do it".
function slotDone(state, actions, dateStr) {
  const doc = actions.dayFor(dateStr);
  if (!doc) return false;
  const dow = dowOf(dateStr);
  const branching = state.template.days[dow].branching;
  if (branching && !doc.branch) return false;
  const slot = blocksFor(state.template, dow, branching ? doc.branch : null)
    .find(b => b.campaignSlot);
  return doc.blocks?.[slot.id]?.done === true;
}

export function render(state, actions) {
  const { campaign, today } = state;
  const todayEntry = dayFor(campaign, today);

  const grid = el('div', { class: 'grid' }, campaign.days.map((d) => {
    const classes = ['cell'];
    if (d.kind === 'rest') classes.push('rest');
    else if (d.minutes >= HEAVY_MINUTES) classes.push('heavy');
    if (d.date === today) classes.push('today');
    if (d.kind !== 'rest' && slotDone(state, actions, d.date)) classes.push('done');
    return el('div', {
      class: classes.join(' '),
      title: `Day ${d.n}, ${d.date}, ${d.kind}, ${d.minutes} min`,
      text: String(d.n),
    });
  }));

  const todayCard = todayEntry
    ? el('section', { class: 'now-card' }, [
        el('p', { class: 'now-label', text: `Day ${todayEntry.n} of 28` }),
        el('p', { class: 'now-time', text: `${todayEntry.kind}, ${todayEntry.minutes} min` }),
        el('p', { class: 'now-detail', text: todayEntry.task }),
      ])
    : el('section', { class: 'now-card' }, [
        el('p', { class: 'now-label', text: 'Outside the campaign' }),
        el('p', { class: 'now-time', text: `Runs ${campaign.startDate} to ${campaign.endDate}.` }),
      ]);

  return el('section', {}, [
    el('div', { class: 'strip' }, [
      el('span', {}, [el('span', { text: 'Days to 13 Sep ' }), el('b', { text: String(daysRemaining(campaign, today)) })]),
      el('span', {}, [el('span', { text: 'Title ' }), el('b', { text: campaign.title })]),
    ]),
    todayCard,
    el('h2', { text: 'The 28 days' }),
    grid,
    el('p', { class: 'streak-sub', text: 'Outlined days are the heavy ones. Filled days are done. Shaded days are prescribed rest.' }),
  ]);
}
