const MS_PER_DAY = 86_400_000;

function utcDays(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

export function dayFor(campaign, dateStr) {
  return campaign.days.find(d => d.date === dateStr) ?? null;
}

export function daysRemaining(campaign, dateStr) {
  const diff = utcDays(campaign.endDate) - utcDays(dateStr);
  return Math.max(0, diff);
}

export function isRestDay(campaign, dateStr) {
  return dayFor(campaign, dateStr)?.kind === 'rest';
}
