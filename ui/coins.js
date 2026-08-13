import { el } from './render.js';
import { balance, byAttribute } from '../ledger.js';

const RECENT = 15;

export function render(state, actions) {
  const { template, ledger, today } = state;
  const have = balance(ledger);

  const todaysEarns = ledger.filter(e => e.date === today && e.kind === 'earn');
  const perAttribute = byAttribute(todaysEarns);

  const attributeRows = Object.entries(template.attributes)
    .filter(([key]) => perAttribute[key])
    .map(([key, attr]) => el('div', { class: 'shop-item' }, [
      el('span', {}, [
        el('span', { class: 'block-attr', style: `background: ${attr.color}` }),
        el('span', { text: ` ${attr.label}` }),
      ]),
      el('b', { text: `+${perAttribute[key]}` }),
    ]));

  const shop = template.shop.map(item => el('div', { class: 'shop-item' }, [
    el('span', { class: 'block-label', text: item.label }),
    el('button', {
      text: `${item.cost}`,
      // Affordability is enforced again in actions.spend, which throws
      // InsufficientCoinsError. Disabling here is the courtesy; the throw is
      // the guarantee, because the balance can change under a sync mid-tap.
      disabled: have < item.cost ? '' : null,
      onclick: () => actions.buy(item.id),
    }),
  ]));

  // An entry that has already been undone must not offer undo again, or the
  // compensating entries stack and the balance drifts.
  const undone = new Set(ledger.filter(e => e.undoOf).map(e => e.undoOf));
  const recent = [...ledger]
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, RECENT)
    .map(entry => el('div', { class: `ledger-item ${entry.kind}` }, [
      el('span', { class: 'block-label', text: entry.label }),
      el('b', { text: `${entry.kind === 'earn' ? '+' : '-'}${entry.amount}` }),
      (entry.undoOf || undone.has(entry._id))
        ? el('span', { class: 'streak-sub', text: entry.undoOf ? 'undo' : 'undone' })
        : el('button', { text: 'Undo', onclick: () => actions.undo(entry) }),
    ]));

  return el('section', {}, [
    el('p', { class: 'balance', text: String(have) }),
    el('p', { class: 'streak-sub', text: 'coins' }),
    el('h2', { text: 'Earned today' }),
    attributeRows.length
      ? el('div', {}, attributeRows)
      : el('p', { class: 'budget', text: 'Nothing yet today.' }),
    el('h2', { text: 'Shop' }),
    el('div', {}, shop),
    el('h2', { text: 'Recent' }),
    recent.length
      ? el('div', {}, recent)
      : el('p', { class: 'budget', text: 'No transactions yet.' }),
  ]);
}
