// The only module that touches PouchDB or the network.
//
// PouchDB is loaded as a classic script in index.html and attaches itself to
// window, because the vendored bundle is UMD and not an ES module. Importing it
// here would need a build step, which the spec rules out.

import { mergeTemplateDocs } from './conflicts.js';

const LOCAL_NAME = 'schedule-local';
const REMOTE_NAME = 'schedule';

// The app shell can now be served from a second, static origin (a GitHub
// Pages copy, so it still loads with the CouchDB host powered off) as well
// as from CouchDB itself. Both copies talk to the same database, so the
// origin is fixed here rather than derived from window.location.origin -
// otherwise the Pages copy would try to sync with itself. When served from
// CouchDB directly, this happens to equal window.location.origin anyway, so
// nothing changes for that case.
const COUCH_ORIGIN = 'https://msi.tail4481d7.ts.net';

// U+FFF0 as an escape rather than the literal character, so every source file
// stays pure ASCII. It is the standard CouchDB "highest key" sentinel: any
// string starting with the prefix sorts before prefix + this character.
const HIGH = '\uFFF0';

export function openLocal() {
  return new window.PouchDB(LOCAL_NAME);
}

export function remoteUrl() {
  return `${COUCH_ORIGIN}/${REMOTE_NAME}`;
}

// 'include' rather than 'same-origin': the Pages copy is cross-origin from
// CouchDB, so the session cookie only rides along if the request explicitly
// asks for it. CouchDB's CORS config must echo credentials for this origin
// or the browser drops the cookie regardless of what's asked for here.
function crossOriginFetch(url, opts = {}) {
  return window.PouchDB.fetch(url, { ...opts, credentials: 'include' });
}

export async function getSession() {
  let res;
  try {
    res = await crossOriginFetch(`${COUCH_ORIGIN}/_session`);
  } catch {
    // Offline: the request never reached the server, so this says nothing
    // about whether the session is actually valid. But the browser is
    // already holding whatever session cookie was last set, and the local
    // PouchDB already has the last-synced data, so treating this the same
    // as "not logged in" would bounce a legitimately offline user to a
    // login form the network can't satisfy either. Proceed optimistically;
    // if the cookie really is invalid, the first reachable request will
    // fail on its own terms once back online.
    return { ok: true, name: null, offline: true };
  }
  if (!res.ok) return { ok: false, name: null };
  const body = await res.json();
  return { ok: Boolean(body.userCtx?.name), name: body.userCtx?.name ?? null };
}

export async function login(user, password) {
  const res = await crossOriginFetch(`${COUCH_ORIGIN}/_session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: user, password }),
  });
  return res.ok;
}

export function startSync(local, onStatus) {
  return local.sync(remoteUrl(), { live: true, retry: true, fetch: crossOriginFetch })
    .on('active', () => onStatus('syncing'))
    .on('change', () => onStatus('syncing'))
    // paused with no error means caught up; with an error it means unreachable,
    // which during the commute is the normal state and not a failure to report.
    .on('paused', (err) => onStatus(err ? 'offline' : 'synced'))
    .on('error', () => onStatus('offline'))
    .on('denied', () => onStatus('offline'));
}

// Generalised over the document prefix and the merge rule so todos can reuse it.
// The two document types need genuinely different merge rules - day documents
// merge per entry because they aggregate dozens of independent ticks, todos are
// whole-document last-write-wins - but the fetch, put and loser-cleanup dance
// around that rule is identical.
export async function resolveConflicts(local, prefix, merge) {
  const res = await local.allDocs({
    include_docs: true, conflicts: true,
    startkey: prefix, endkey: `${prefix}${HIGH}`,
  });

  let resolved = 0;
  for (const row of res.rows) {
    const conflicts = row.doc?._conflicts;
    if (!conflicts?.length) continue;

    const revisions = [row.doc];
    for (const rev of conflicts) {
      revisions.push(await local.get(row.id, { rev }));
    }

    const { merged, losers } = merge(revisions);
    delete merged._conflicts;
    await local.put(merged);
    for (const loser of losers) {
      await local.remove(loser._id, loser._rev);
    }
    resolved += 1;
  }
  return resolved;
}

async function allWithPrefix(local, prefix) {
  const res = await local.allDocs({
    include_docs: true, startkey: prefix, endkey: `${prefix}${HIGH}`,
  });
  return res.rows.map(r => r.doc);
}

export async function loadAll(local) {
  const [template, campaign, days, ledger, todos] = await Promise.all([
    local.get('schedule:v1').catch(() => null),
    local.get('campaign:sermon-2026-09-13').catch(() => null),
    allWithPrefix(local, 'day:'),
    allWithPrefix(local, 'ledger:'),
    allWithPrefix(local, 'todo:'),
  ]);
  return { template, campaign, days, ledger, todos };
}

export async function saveDay(local, doc) {
  const res = await local.put(doc);
  return { ...doc, _rev: res.rev };
}

// Returns null for a delete: the document is gone, so there is no revision worth
// holding in memory and the caller drops it from state instead of replacing it.
export async function saveTodo(local, doc) {
  const res = await local.put(doc);
  return doc._deleted ? null : { ...doc, _rev: res.rev };
}

export async function saveLedger(local, entries) {
  if (entries.length) await local.bulkDocs(entries);
}

// resolveConflicts scans a prefix range; the template is a single known id,
// so this one just fetches it and asks for its conflicts directly.
export async function resolveTemplateConflicts(local) {
  let doc;
  try {
    doc = await local.get('schedule:v1', { conflicts: true });
  } catch {
    return false;
  }
  if (!doc._conflicts?.length) return false;

  const revisions = [doc];
  for (const rev of doc._conflicts) {
    revisions.push(await local.get('schedule:v1', { rev }));
  }

  const { merged, losers } = mergeTemplateDocs(revisions);
  delete merged._conflicts;
  await local.put(merged);
  for (const loser of losers) {
    await local.remove(loser._id, loser._rev);
  }
  return true;
}

export async function saveTemplate(local, doc) {
  const res = await local.put(doc);
  return { ...doc, _rev: res.rev };
}
