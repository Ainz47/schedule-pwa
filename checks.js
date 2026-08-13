// The read side of a check's lifetime. Checks are never deleted, because
// coinEffect throws on a missing taskId and past day documents keep referencing
// the ones they were ticked with. Instead a check carries a half open date
// window, and every surface that renders or scores a check asks this module
// whether it applied on the day in question.
//
// Both bounds are nullable and null means "no bound", so the four checks that
// predate this feature need no migration: they simply have neither.
//
// Date strings are YYYY-MM-DD, which compares correctly as plain strings. No
// date arithmetic is needed here and none is done.

export function checkActiveOn(check, dateStr) {
  if (check.activeFrom && dateStr < check.activeFrom) return false;
  if (check.retiredOn && dateStr >= check.retiredOn) return false;
  return true;
}

export function activeChecks(template, dateStr) {
  return Object.entries(template.checks)
    .filter(([, check]) => checkActiveOn(check, dateStr));
}
