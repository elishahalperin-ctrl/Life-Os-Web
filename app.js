// Life OS web app: view and edit the vault in a browser. Every save is a commit to the GitHub repo.
import SCHEMA from './schema.js';
import {
  GitHub, ApiError, Vault, RECORD_FOLDERS, buildNote, setEntry, cleanName, nameProblem, todayISO,
  isRecordPath, validateRecord, baseName,
} from './vault.js';

const DEFAULT_CFG = { owner: 'elishahalperin-ctrl', repo: 'ObsidianVaultSync', branch: 'main' };
const STATUSES = ['Inbox', 'To Do', 'In Progress', 'Waiting', 'Blocked', 'Done'];
const STATUS_ORDER = ['Blocked', 'In Progress', 'To Do', 'Waiting', 'Inbox', 'Done'];
const EMBED_ROUTE = { Tasks: '#/tasks', Money: '#/money', Events: '#/today', People: '#/today', Routines: '#/today', Coursework: '#/today', Courses: '#/notes', Notes: '#/notes' };
const FOLDER_LABEL = { Tasks: 'Task', Notes: 'Note', Events: 'Event', People: 'Person', Money: 'Money entry', Routines: 'Routine', Courses: 'Course', Coursework: 'Coursework' };

/* ---------- small helpers ---------- */

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
const getCfg = () => { try { return { ...DEFAULT_CFG, ...JSON.parse(store.get('lifeos.cfg') || '{}') }; } catch { return { ...DEFAULT_CFG }; } };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const encPath = (p) => encodeURIComponent(p).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const noteHref = (p) => `#/note/${encPath(p)}`;
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const day = (v) => String(v ?? '').slice(0, 10);
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const statusClass = (s) => ({ Inbox: 'inbox', 'To Do': '', 'In Progress': 'prog', Waiting: 'wait', Blocked: 'block', Done: 'done' }[s] ?? '');
const pill = (text, cls = '') => h('span', { class: `pill ${cls}` }, text);

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function explain(e) {
  if (!(e instanceof ApiError)) return e.message || String(e);
  if (e.status === 0) return e.message;
  if (e.status === 401) return 'GitHub rejected the token. It may be mistyped, expired or revoked.';
  if (e.status === 403) return /rate limit/i.test(e.message) ? 'GitHub rate limit reached. Wait a few minutes.' : 'The token is not allowed to do that. It needs "Contents: Read and write" on this repository.';
  if (e.status === 404) return 'Repository or branch not found. Check the names in Settings, and that the token covers this repository.';
  if (e.status === 409 || e.status === 422) return 'This note changed on GitHub since you opened it, or that name is taken. Reload and try again.';
  return `GitHub said: ${e.message}`;
}

const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
function toast(text, err = false) {
  const t = h('div', { class: `toast${err ? ' err' : ''}`, role: err ? 'alert' : 'status' }, text);
  toasts.append(t);
  setTimeout(() => t.remove(), err ? 7000 : 2600);
}

/* ---------- state ---------- */

const S = { vault: null, status: 'idle', error: null, progress: null, filter: { area: 'All', showDone: false }, query: '', lastSync: 0, lastHash: '' };
let DRAFT = null; // unsaved edit of one note: { path, values, body, raw, dirty }

const token = () => store.get('lifeos.token') || '';

async function connect() {
  S.status = 'loading'; S.error = null; S.progress = null; render();
  try {
    const cfg = getCfg();
    S.vault = new Vault(new GitHub({ ...cfg, token: token() }));
    await S.vault.load((done, total) => { S.progress = [done, total]; const p = document.getElementById('progress'); if (p) p.textContent = `Loading notes… ${done} of ${total}`; });
    S.status = 'ready'; S.lastSync = Date.now();
  } catch (e) {
    S.status = 'error'; S.error = e;
  }
  render();
}

async function poll() {
  if (S.status !== 'ready' || document.hidden || DRAFT?.dirty) return;
  try {
    const n = await S.vault.refresh();
    S.lastSync = Date.now();
    if (n) { render(); toast(`${n} change${n === 1 ? '' : 's'} from GitHub`); }
    else updateBadge();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { S.status = 'error'; S.error = e; render(); }
  }
}

/* ---------- routing + frame ---------- */

function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = raw.split('/');
  return { view: view || 'today', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
}

const NAV = [['today', 'Today'], ['tasks', 'Tasks'], ['notes', 'Notes'], ['money', 'Money'], ['new', '+ New']];

function badge() {
  const cfg = getCfg();
  return h('div', { class: 'sync' },
    h('span', { class: 'label', id: 'badge' }, S.status === 'ready' ? `${cfg.repo} · ${cfg.branch} · synced ${ago(S.lastSync)}` : ''),
    S.status === 'ready' && h('button', { class: 'btn small', type: 'button', onclick: reload }, 'Reload'),
    h('a', { class: 'btn small', href: '#/settings', 'aria-current': route().view === 'settings' ? 'page' : null }, 'Settings'));
}
function updateBadge() {
  const b = document.getElementById('badge');
  if (b && S.status === 'ready') { const cfg = getCfg(); b.textContent = `${cfg.repo} · ${cfg.branch} · synced ${ago(S.lastSync)}`; }
}

async function reload() { DRAFT = null; await connect(); toast('Reloaded from GitHub'); }

function frame(content, active) {
  return [
    h('header', { class: 'top' }, h('div', { class: 'top-row' },
      h('a', { class: 'brand', href: '#/today' }, 'Life OS'),
      h('nav', { class: 'nav', 'aria-label': 'Sections' }, NAV.map(([k, label]) => h('a', { href: `#/${k}`, 'aria-current': k === active ? 'page' : null }, label))),
      badge())),
    h('main', { class: 'wrap' }, content),
  ];
}

function render() {
  const app = document.getElementById('app');
  const { view, arg } = route();
  let node, active = view;
  if (!token()) { node = viewSettings(true); active = 'settings'; }
  else if (S.status === 'loading' || S.status === 'idle') node = h('div', { class: 'stack' }, h('h1', {}, 'Loading your vault'), h('p', { class: 'muted', id: 'progress' }, S.progress ? `Loading notes… ${S.progress[0]} of ${S.progress[1]}` : 'Connecting to GitHub…'));
  else if (S.status === 'error') node = viewError();
  else {
    try {
      node = ({ today: viewToday, tasks: viewTasks, notes: viewNotes, money: viewMoney, note: () => viewNote(arg), new: () => viewNew(arg), settings: () => viewSettings(false) }[view] || viewToday)();
    } catch (e) { node = h('div', { class: 'panel' }, h('h2', {}, 'Something went wrong showing this page'), h('p', {}, String(e.message || e))); }
  }
  const sameRoute = S.lastHash === location.hash, y = window.scrollY;
  S.lastHash = location.hash;
  app.replaceChildren(...frame(node, active));
  window.scrollTo(0, sameRoute ? y : 0); // keep your place after a save, start at the top on a new page
}

function viewError() {
  return h('div', { class: 'stack' }, h('h1', {}, 'Could not open the vault'),
    h('p', { class: 'problems' }, explain(S.error)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: connect }, 'Try again'), h('a', { class: 'btn', href: '#/settings' }, 'Open settings')));
}

/* ---------- shared pieces ---------- */

async function changeStatus(note, status, select) {
  select.disabled = true;
  try {
    const parts = { ...note.parts, entries: note.parts.entries.map((e) => ({ ...e })) };
    setEntry(parts.entries, 'status', status);
    if (status === 'Done' && !note.data.done_on) setEntry(parts.entries, 'done_on', todayISO());
    await S.vault.save(note, buildNote(parts), `web: ${note.name} → ${status}`);
    toast(`${note.name}: ${status}`);
    render();
  } catch (e) {
    select.value = note.data.status || '';
    select.disabled = false;
    toast(explain(e), true);
  }
}

function taskRow(t, { select = true } = {}) {
  const d = t.data;
  const today = todayISO();
  return h('li', {},
    h('div', { class: 'title' }, h('a', { href: noteHref(t.path) }, t.name),
      h('div', { class: 'meta' }, [d.area, d.part, d.phase, d.priority && `${d.priority} priority`, d.due && `due ${day(d.due)}${day(d.due) < today && d.status !== 'Done' ? ' (overdue)' : ''}`].filter(Boolean).join(' · '))),
    select
      ? h('select', { class: 'status-select', 'aria-label': `Status of ${t.name}`, onchange: (e) => changeStatus(t, e.target.value, e.target) },
        STATUSES.map((s) => h('option', { value: s, selected: s === d.status }, s)))
      : pill(d.status || '—', statusClass(d.status)));
}

function section(title, items, empty, render_ = (x) => x) {
  return h('section', { class: 'panel' }, h('h2', {}, title),
    items.length ? h('ul', { class: 'list' }, items.map(render_)) : h('p', { class: 'empty' }, empty));
}

async function quickAdd(input, areaFilter) {
  const raw = input.value.trim();
  if (!raw) return;
  const name = cleanName(raw);
  const problem = nameProblem(name) || (S.vault.resolve(name) ? `There is already a note called "${name}".` : null);
  if (problem) { toast(problem, true); return; }
  const values = { ...SCHEMA.folders.Tasks.defaults };
  if (areaFilter && areaFilter !== 'All') values.area = areaFilter;
  try {
    const note = await S.vault.create(`Tasks/${name}.md`, newNoteText('Tasks', values, ''), `web: add task ${name}`);
    toast(`Added to Inbox: ${note.name}`);
    input.value = '';
    render();
  } catch (e) { toast(explain(e), true); }
}

function quickAddBox(areaFilter) {
  const input = h('input', { type: 'text', id: 'quick-add', placeholder: 'Add a task to the inbox…', enterkeyhint: 'done', 'aria-label': 'New task title', onkeydown: (e) => { if (e.key === 'Enter') quickAdd(input, areaFilter); } });
  return h('div', { class: 'row' }, h('div', { class: 'grow' }, input), h('button', { class: 'btn primary', type: 'button', onclick: () => quickAdd(input, areaFilter) }, 'Add'));
}

/* ---------- Capture ---------- */

// Local time with its offset ("2026-10-18T23:05:09-04:00"), so a late-night capture keeps the right day.
function localStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  return `${d.toLocaleDateString('en-CA')}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const waitingCaptures = () => S.vault.paths.filter((p) => p.startsWith('Capture/') && p.split('/').length === 2);

// "2026-10-18 1432 math hw page 45" — sorts by time, and the first words say what it is.
function captureName(text, stamp) {
  const first = cleanName((text.split('\n').find((l) => l.trim()) || '').replace(/^[\s>*+-]+/, '')).split(' ').slice(0, 6).join(' ').replace(/[.,;!-]+$/, '');
  return `${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)} ${first}`.trim();
}

async function saveCapture(area, btn) {
  const text = area.value.replace(/\r\n?/g, '\n').trim();
  if (!text) { toast('Write something first.', true); return; }
  const stamp = localStamp(), base = captureName(text, stamp);
  let name = base;
  for (let n = 2; S.vault.resolve(name); n++) name = `${base} ${n}`;
  btn.disabled = true;
  try {
    await S.vault.create(`Capture/${name}.md`, `---\ncaptured: ${stamp}\n---\n\n${text}\n`, `web: capture ${name}`);
    area.value = '';
    store.del('lifeos.capture-draft');
    toast('Captured. Claude files it on the next organize run.');
    render();
  } catch (e) { toast(explain(e), true); } finally { btn.disabled = false; }
}

function captureBox() {
  const waiting = waitingCaptures().length;
  const area = h('textarea', {
    class: 'short', id: 'capture', 'aria-label': 'Capture', value: store.get('lifeos.capture-draft') || '',
    placeholder: 'Homework, an idea, something for lumi, a thing to remember…',
    oninput: () => store.set('lifeos.capture-draft', area.value),
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveCapture(area, btn); },
  });
  const btn = h('button', { class: 'btn primary', type: 'button', id: 'capture-save', onclick: () => saveCapture(area, btn) }, 'Capture');
  return h('section', { class: 'panel capture' }, h('h2', {}, 'Capture'),
    h('p', { class: 'muted' }, 'Write it the way you would say it, several things at once is fine. Claude files it: homework into Coursework, to-dos into Tasks, lumi into its workstream, lasting facts into Memory.'),
    area,
    h('div', { class: 'row' }, btn, h('span', { class: 'muted', id: 'capture-waiting' }, waiting ? `${waiting} waiting to be filed` : 'Nothing waiting to be filed')));
}

function newNoteText(folder, values, body) {
  const entries = [];
  for (const f of SCHEMA.folders[folder].fields) setEntry(entries, f.key, values[f.key]);
  return buildNote({ entries, eol: '\n', rest: body ? `\n\n${body.replace(/\s+$/, '')}\n` : '\n' });
}

/* ---------- Today ---------- */

function viewToday() {
  const v = S.vault;
  const today = todayISO(), soon = addDays(today, 3), month = addDays(today, 30), week = addDays(today, 7);
  const tasks = v.records('Tasks').filter((t) => !t.data.archived);
  const open = tasks.filter((t) => t.data.status !== 'Done');
  const by = (a, b) => (day(a.data.due) || '9999').localeCompare(day(b.data.due) || '9999') || a.name.localeCompare(b.name);
  const blocked = open.filter((t) => t.data.status === 'Blocked');
  const slipping = open.filter((t) => t.data.due && day(t.data.due) < today).sort(by);
  const dueSoon = open.filter((t) => t.data.due && day(t.data.due) >= today && day(t.data.due) <= soon).sort(by);
  const inbox = open.filter((t) => t.data.status === 'Inbox' || !t.data.area);
  const prog = open.filter((t) => t.data.status === 'In Progress');
  const events = v.records('Events').filter((e) => day(e.data.when) >= today && day(e.data.when) <= month).sort((a, b) => String(a.data.when).localeCompare(String(b.data.when)));
  const follow = v.records('People').filter((p) => p.data.follow_up_by && day(p.data.follow_up_by) <= soon);
  const routines = v.records('Routines').filter((r) => r.data.next_due && day(r.data.next_due) <= today);
  const work = v.records('Coursework').filter((w) => w.data.status !== 'Graded' && w.data.due && day(w.data.due) <= week).sort((a, b) => day(a.data.due).localeCompare(day(b.data.due)));
  const attention = [...new Map([...blocked, ...slipping, ...dueSoon].map((t) => [t.path, t])).values()];

  return h('div', { class: 'stack' },
    h('div', { class: 'stack' }, h('h1', {}, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, open.length), h('span', {}, 'open tasks')),
        h('div', { class: 'stat' }, h('b', {}, blocked.length), h('span', {}, 'blocked')),
        h('div', { class: 'stat' }, h('b', {}, inbox.length), h('span', {}, 'in the inbox')),
        h('div', { class: 'stat' }, h('b', {}, events.length), h('span', {}, 'events in 30 days')))),
    captureBox(),
    quickAddBox(),
    h('div', { class: 'cols' },
      section('Needs attention', attention, 'Nothing blocked, overdue or due in the next three days.', (t) => taskRow(t)),
      section('In progress', prog, 'Nothing in progress.', (t) => taskRow(t)),
      section('Inbox', inbox, 'Inbox is empty.', (t) => taskRow(t))),
    h('div', { class: 'cols' },
      section('Coming up', events, 'No events in the next 30 days.', (e) => h('li', {}, h('div', { class: 'title' }, h('a', { href: noteHref(e.path) }, e.name), h('div', { class: 'meta' }, [e.data.kind, e.data.where, e.data.area].filter(Boolean).join(' · '))), h('span', { class: 'meta' }, String(e.data.when || '').replace('T', ' ').replace(/:00(\.\d+)?Z?$/, '')))),
      section('Coursework due this week', work, 'No coursework due in the next 7 days.', (w) => h('li', {}, h('div', { class: 'title' }, h('a', { href: noteHref(w.path) }, w.name), h('div', { class: 'meta' }, [w.data.type, w.data.status].filter(Boolean).join(' · '))), h('span', { class: 'meta' }, `due ${day(w.data.due)}`))),
      section('Follow up with', follow, 'No follow-ups due.', (p) => h('li', {}, h('div', { class: 'title' }, h('a', { href: noteHref(p.path) }, p.name)), h('span', { class: 'meta' }, `by ${day(p.data.follow_up_by)}`))),
      section('Routines due', routines, 'No routines due.', (r) => h('li', {}, h('div', { class: 'title' }, h('a', { href: noteHref(r.path) }, r.name)), h('span', { class: 'meta' }, `${r.data.cadence || ''} · due ${day(r.data.next_due)}`)))));
}

/* ---------- Tasks ---------- */

function viewTasks() {
  const f = S.filter;
  const all = S.vault.records('Tasks').filter((t) => !t.data.archived);
  const shown = all.filter((t) => (f.area === 'All' || t.data.area === f.area || (f.area === 'Unsorted' && !t.data.area)) && (f.showDone || t.data.status !== 'Done'));
  const set = (patch) => { Object.assign(S.filter, patch); render(); };
  const groups = STATUS_ORDER.map((s) => [s, shown.filter((t) => (t.data.status || 'Inbox') === s)]).filter(([, l]) => l.length);
  return h('div', { class: 'stack' },
    h('h1', {}, 'Tasks'),
    quickAddBox(f.area),
    h('div', { class: 'row' },
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Area' }, ['All', ...SCHEMA.areas, 'Unsorted'].map((a) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.area === a), onclick: () => set({ area: a }) }, a))),
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.showDone), onclick: () => set({ showDone: !f.showDone }) }, 'Show done')),
    groups.length
      ? groups.map(([s, list]) => h('section', { class: 'panel' }, h('h2', {}, h('span', {}, `${s} `), h('span', { class: 'muted' }, `(${list.length})`)),
        h('ul', { class: 'list' }, list.sort((a, b) => (a.data.phase || '~').localeCompare(b.data.phase || '~') || (day(a.data.due) || '9999').localeCompare(day(b.data.due) || '9999') || a.name.localeCompare(b.name)).map((t) => taskRow(t)))))
      : h('p', { class: 'empty' }, 'No tasks match.'));
}

/* ---------- Notes ---------- */

function viewNotes() {
  const v = S.vault;
  const results = h('div', { class: 'stack' });
  const q = h('input', { type: 'search', id: 'note-search', placeholder: 'Search names and note text…', value: S.query, 'aria-label': 'Search notes', oninput: (e) => { S.query = e.target.value; fill(); } });
  const link = (p) => h('li', {}, h('div', { class: 'title' }, h('a', { href: noteHref(p) }, baseName(p)), h('div', { class: 'meta' }, p)));
  function fill() {
    const term = S.query.trim().toLowerCase();
    results.replaceChildren();
    if (term) {
      const hits = v.paths.filter((p) => baseName(p).toLowerCase().includes(term) || (v.notes.get(p)?.text || '').toLowerCase().includes(term));
      results.append(h('section', { class: 'panel' }, h('h2', {}, `${hits.length} match${hits.length === 1 ? '' : 'es'}`), h('ul', { class: 'list' }, hits.slice(0, 80).map(link)), hits.length > 80 && h('p', { class: 'meta' }, 'Showing the first 80.'), h('p', { class: 'meta' }, 'Text search covers tasks, notes, events, money, people and courses. Open other pages to read them.')));
      return;
    }
    const pages = v.paths.filter((p) => !isRecordPath(p) && !p.startsWith('Templates/'));
    results.append(h('section', { class: 'panel' }, h('h2', {}, 'Pages'), h('ul', { class: 'list' }, pages.map(link))));
    for (const folder of RECORD_FOLDERS) {
      const list = v.records(folder);
      if (!list.length) continue;
      results.append(h('section', { class: 'panel' }, h('h2', {}, `${folder} `, h('span', { class: 'muted' }, `(${list.length})`)), h('ul', { class: 'list' }, list.map((n) => link(n.path)))));
    }
  }
  fill();
  return h('div', { class: 'stack' }, h('h1', {}, 'Notes'), q, results);
}

/* ---------- Money ---------- */

function viewMoney() {
  const rows = S.vault.records('Money');
  const lumi = rows.filter((m) => m.data.category === 'lumi costs' || m.data.area === 'lumi');
  const other = rows.filter((m) => !lumi.includes(m));
  const num = (m) => (typeof m.data.amount === 'number' ? m.data.amount : null);
  const sum = (f) => lumi.filter((m) => num(m) !== null && f(m)).reduce((a, m) => a + num(m), 0);
  const missing = lumi.filter((m) => num(m) === null);
  const table = (list, cols) => h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map(([label, , cls]) => h('th', { class: cls }, label)))),
    h('tbody', {}, list.map((m) => h('tr', {}, cols.map(([, fn, cls]) => h('td', { class: cls }, fn(m))))))));
  const name = (m) => h('a', { href: noteHref(m.path) }, m.name);
  return h('div', { class: 'stack' }, h('h1', {}, 'Money'),
    h('section', { class: 'panel' }, h('h2', {}, 'lumi costs'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, money(sum((m) => !m.data.recurring || m.data.recurring === 'None'))), h('span', {}, 'one-off costs listed')),
        h('div', { class: 'stat' }, h('b', {}, money(sum((m) => m.data.recurring === 'Monthly'))), h('span', {}, 'per month')),
        h('div', { class: 'stat' }, h('b', {}, money(sum((m) => m.data.recurring === 'Yearly'))), h('span', {}, 'per year'))),
      missing.length > 0 && h('p', { class: 'meta' }, `${missing.length} ${missing.length === 1 ? 'entry has' : 'entries have'} no amount yet: ${missing.map((m) => m.name).join(', ')}.`),
      table([...lumi].sort((a, b) => (num(b) ?? -1) - (num(a) ?? -1)), [['Item', name], ['Amount', (m) => (num(m) === null ? '' : money(num(m))), 'num'], ['Type', (m) => m.data.type], ['Recurring', (m) => m.data.recurring], ['Paid', (m) => (m.data.paid ? 'yes' : 'no')]])),
    other.length > 0 && h('section', { class: 'panel' }, h('h2', {}, 'Personal and school'), table(other, [['Item', name], ['Amount', (m) => (num(m) === null ? '' : money(num(m))), 'num'], ['Type', (m) => m.data.type], ['Category', (m) => m.data.category], ['Date', (m) => day(m.data.date)]])),
    h('p', { class: 'meta' }, 'A reference log, not accounting. Never enter account or card numbers.'));
}

/* ---------- note view + editor ---------- */

function mdToHtml(src) {
  const v = S.vault;
  src = src.replace(/!\[\[([^\]]+?)\]\]/g, (_, inner) => {
    const name = inner.split('#')[0].split('|')[0].trim();
    return `*Live table "${escHtml(name)}": [open it here](${EMBED_ROUTE[name.replace(/\.base$/, '')] || '#/notes'})*`;
  });
  src = src.replace(/\[\[([^\]]+?)\]\]/g, (_, inner) => {
    const [target, alias] = inner.split('|');
    const label = (alias || target).trim();
    const path = v.resolve(target.split('#')[0]);
    return path ? `[${label.replace(/[[\]]/g, '')}](${noteHref(path)})` : `<span class="wl-missing">${escHtml(label)}</span>`;
  });
  src = src.replace(/^> \[!(\w+)\][ \t]*(.*)$/gm, (_, t, rest) => `> **${rest || t}**`);
  return DOMPurify.sanitize(marked.parse(src, { gfm: true }), { FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'], USE_PROFILES: { html: true } });
}
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') || '')) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
});

const bodyOf = (note) => note.parts.rest.replace(/^\r?\n/, '');

function readValue(field, value) {
  if (value === null || value === undefined || value === '') return h('span', { class: 'muted' }, '—');
  if (field.type === 'course') return h('span', { class: 'course-chips' }, [].concat(value).map((l) => {
    const m = /^\[\[([^\]|#]+)/.exec(l); const p = m && S.vault.resolve(m[1]);
    return p ? h('a', { href: noteHref(p) }, m[1]) : h('span', {}, String(l));
  }));
  if (field.type === 'bool') return value ? 'Yes' : 'No';
  if (field.key === 'status' && STATUSES.includes(value)) return pill(value, statusClass(value));
  if (field.type === 'select') return pill(value, 'plain');
  if (field.type === 'number' && field.key === 'amount') return money(value);
  return String(value).replace(/T(\d\d:\d\d):00(\.\d+)?Z$/, ' $1 UTC');
}

function control(field, values, rerender) {
  const set = (v, redraw = false) => { values[field.key] = v; DRAFT.dirty = true; markDirty(); if (redraw) rerender(); };
  const id = `f-${field.key}`;
  const v = values[field.key];
  if (field.type === 'select') {
    let opts = field.options;
    if (field.key === 'part' && values.area && SCHEMA.partsByArea[values.area] && SCHEMA.folders[DRAFT.folder]?.fields.some((f) => f.key === 'part') && DRAFT.folder !== 'Routines') opts = SCHEMA.partsByArea[values.area];
    const disabled = field.key === 'phase' && DRAFT.folder === 'Tasks' && values.area !== 'lumi';
    return h('select', { id, disabled, onchange: (e) => set(e.target.value || null, field.key === 'area') }, h('option', { value: '' }, '—'), opts.map((o) => h('option', { value: o, selected: o === v }, o)));
  }
  if (field.type === 'bool') return h('input', { id, type: 'checkbox', checked: !!v, onchange: (e) => set(e.target.checked) });
  if (field.type === 'number') return h('input', { id, type: 'number', step: 'any', inputmode: 'decimal', value: v ?? '', oninput: (e) => set(e.target.value === '' ? null : Number(e.target.value)) });
  if (field.type === 'date') return h('input', { id, type: 'date', value: v ? day(v) : '', oninput: (e) => set(e.target.value || null) });
  if (field.type === 'course') {
    const cur = [].concat(v || []);
    const courses = S.vault.records('Courses').map((c) => `[[${c.name}]]`);
    return h('div', { class: 'course-chips' },
      cur.map((c) => h('button', { class: 'chip', type: 'button', 'aria-label': `Remove ${c}`, onclick: () => { set(cur.filter((x) => x !== c), true); } }, `${String(c).replace(/^\[\[|\]\]$/g, '')} ✕`)),
      h('select', { id, 'aria-label': 'Add course', onchange: (e) => { if (e.target.value) set([...cur, e.target.value], true); } }, h('option', { value: '' }, 'Add course…'), courses.filter((c) => !cur.includes(c)).map((c) => h('option', { value: c }, c.replace(/^\[\[|\]\]$/g, '')))));
  }
  return h('input', { id, type: 'text', value: v ?? '', placeholder: field.type === 'datetime' ? '2026-10-31 or 2026-10-31T14:00:00Z' : '', oninput: (e) => set(e.target.value) });
}

function markDirty() { const b = document.getElementById('save-btn'); if (b) b.disabled = !DRAFT?.dirty; const s = document.getElementById('dirty-label'); if (s) s.textContent = DRAFT?.dirty ? 'Unsaved changes' : 'No changes yet'; }

function propsEditor(folder, values) {
  const wrap = h('div', { class: 'props' });
  const redraw = () => { wrap.replaceChildren(...fieldsFor()); };
  const fieldsFor = () => SCHEMA.folders[folder].fields.map((f) => h('div', { class: `prop${f.type === 'course' || f.key === 'summary' ? ' wide' : ''}` }, h('label', { for: `f-${f.key}` }, f.key.replace(/_/g, ' ')), control(f, values, redraw)));
  redraw();
  return wrap;
}

function viewNote(path) {
  const v = S.vault;
  if (!path || !v.shas.has(path)) return h('div', { class: 'stack' }, h('h1', {}, 'Note not found'), h('p', {}, `There is no note at "${path || ''}".`), h('a', { class: 'btn', href: '#/notes' }, 'Back to notes'));
  const note = v.notes.get(path);
  if (!note) {
    v.open(path).then(() => { if (route().arg === path) render(); }).catch((e) => toast(explain(e), true));
    return h('p', { class: 'muted' }, 'Loading…');
  }
  const folder = note.folder;
  const isRecord = isRecordPath(path) && SCHEMA.folders[folder];
  const generated = path.startsWith('Index/');
  const editing = DRAFT?.path === path;
  const fields = isRecord ? SCHEMA.folders[folder].fields : [];
  const known = new Set(fields.map((f) => f.key));
  const extras = note.parts.entries.filter((e) => e.key && !known.has(e.key));

  const startEdit = () => {
    DRAFT = { path, folder, dirty: false, values: JSON.parse(JSON.stringify(note.data)), body: bodyOf(note), raw: note.text };
    render();
  };
  const body = h('div', { class: 'body' });
  if (!editing) body.innerHTML = mdToHtml(bodyOf(note));

  return h('div', { class: 'stack' },
    h('div', {}, h('div', { class: 'crumb' }, h('a', { href: '#/notes' }, 'Notes'), ' / ', path), h('h1', {}, note.name)),
    generated && h('p', { class: 'banner' }, 'This page is generated from your notes. Change the notes themselves and it refreshes on the next sync.'),
    h('div', { class: 'row' },
      !editing && !generated && h('button', { class: 'btn primary', type: 'button', onclick: startEdit }, 'Edit'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { try { v.notes.delete(path); await v.open(path); render(); toast('Reloaded'); } catch (e) { toast(explain(e), true); } } }, 'Reload this note'),
      h('a', { class: 'btn', href: `https://github.com/${getCfg().owner}/${getCfg().repo}/blob/${getCfg().branch}/${path.split('/').map(encodeURIComponent).join('/')}`, target: '_blank', rel: 'noopener noreferrer' }, 'View on GitHub')),
    editing ? editorPanel(note, isRecord, extras)
      : h('div', { class: 'stack' },
        isRecord && h('section', { class: 'panel' }, h('h2', {}, 'Properties'), h('div', { class: 'props' },
          fields.filter((f) => note.data[f.key] !== undefined && note.data[f.key] !== null && note.data[f.key] !== '' || ['status', 'area'].includes(f.key)).map((f) => h('div', { class: `prop${f.type === 'course' ? ' wide' : ''}` }, h('label', {}, f.key.replace(/_/g, ' ')), h('div', { class: 'val' }, readValue(f, note.data[f.key])))),
          extras.map((e) => h('div', { class: 'prop' }, h('label', {}, e.key.replace(/_/g, ' ')), h('div', { class: 'val muted' }, e.key === 'notion_url' ? h('a', { href: String(e.value), target: '_blank', rel: 'noopener noreferrer' }, 'Original in Notion') : Array.isArray(e.value) ? e.value.join(', ') : String(e.value ?? '')))))),
        bodyOf(note).trim() ? h('section', { class: 'panel' }, body) : isRecord && h('p', { class: 'empty' }, 'No text in this note yet.')));
}

function editorPanel(note, isRecord, extras) {
  const d = DRAFT;
  const problems = h('ul', { class: 'problems', hidden: true, id: 'problems', role: 'alert' });
  const showProblems = (list) => { problems.replaceChildren(...list.map((p) => h('li', {}, p))); problems.hidden = !list.length; };
  const ta = h('textarea', { id: 'body-text', 'aria-label': isRecord ? 'Note text' : 'Whole file', oninput: (e) => { if (isRecord) d.body = e.target.value; else d.raw = e.target.value; d.dirty = true; markDirty(); } });
  ta.value = isRecord ? d.body : d.raw;

  const save = async () => {
    try {
      let text;
      if (isRecord && note.hasFM) {
        const entries = note.parts.entries.map((e) => ({ ...e }));
        const values = { ...d.values };
        if (values.status === 'Done' && !values.done_on && note.folder === 'Tasks') values.done_on = todayISO();
        const out = {};
        for (const f of SCHEMA.folders[note.folder].fields) {
          let val = values[f.key];
          if (val === '' || val === undefined) val = null;
          if (f.type === 'datetime' && typeof val === 'string') val = val.trim().replace(' ', 'T') || null;
          out[f.key] = val;
        }
        const list = validateRecord(note.folder, out, S.vault);
        if (list.length) { showProblems(list); return; }
        for (const f of SCHEMA.folders[note.folder].fields) setEntry(entries, f.key, out[f.key]);
        const rest = d.body === bodyOf(note) ? note.parts.rest : `\n${d.body.replace(/\s+$/, '')}\n`;
        text = buildNote({ entries, eol: note.parts.eol, rest });
      } else text = d.raw;
      if (text === note.text) { DRAFT = null; render(); toast('No changes to save'); return; }
      const btn = document.getElementById('save-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      await S.vault.save(note, text, `web: update ${note.path}`);
      DRAFT = null; render(); toast('Saved to GitHub');
    } catch (e) {
      const btn = document.getElementById('save-btn'); if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      showProblems([explain(e)]);
    }
  };

  return h('div', { class: 'stack' },
    isRecord && note.hasFM && h('section', { class: 'panel' }, h('h2', {}, 'Properties'), propsEditor(note.folder, d.values),
      extras.length > 0 && h('p', { class: 'meta' }, `Also on this note, not editable here: ${extras.map((e) => e.key).join(', ')}.`)),
    h('section', { class: 'panel' }, h('h2', {}, isRecord ? 'Text' : 'Whole file, including any properties at the top'), ta),
    problems,
    h('div', { class: 'savebar' }, h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', id: 'save-btn', disabled: !d.dirty, onclick: save }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: () => { DRAFT = null; render(); } }, 'Cancel'),
      h('span', { class: 'meta', id: 'dirty-label' }, d.dirty ? 'Unsaved changes' : 'No changes yet'))));
}

/* ---------- new note ---------- */

function viewNew(folder) {
  if (!folder || !SCHEMA.folders[folder]) {
    return h('div', { class: 'stack' }, h('h1', {}, 'New'), h('p', { class: 'muted' }, 'What are you adding?'),
      h('div', { class: 'chips' }, RECORD_FOLDERS.map((f) => h('a', { class: 'btn', href: `#/new/${f}` }, FOLDER_LABEL[f]))));
  }
  const def = SCHEMA.folders[folder];
  if (DRAFT?.path !== `new:${folder}`) {
    const values = { ...def.defaults };
    for (const k of Object.keys(values)) if (values[k] === 'today') values[k] = todayISO();
    DRAFT = { path: `new:${folder}`, folder, values, body: '', name: '', dirty: false };
  }
  const d = DRAFT;
  const problems = h('ul', { class: 'problems', hidden: true, id: 'problems', role: 'alert' });
  const show = (list) => { problems.replaceChildren(...list.map((p) => h('li', {}, p))); problems.hidden = !list.length; };
  const nameInput = h('input', { id: 'new-name', type: 'text', placeholder: def.hint, value: d.name, autocapitalize: 'sentences', oninput: (e) => { d.name = e.target.value; d.dirty = true; } });
  const bodyArea = h('textarea', { id: 'new-body', 'aria-label': 'Text', oninput: (e) => { d.body = e.target.value; d.dirty = true; } });
  bodyArea.value = d.body;
  bodyArea.className = 'short';

  const create = async () => {
    const name = cleanName(d.name);
    const list = [];
    const np = nameProblem(name);
    if (np) list.push(np);
    else if (S.vault.resolve(name)) list.push(`A note called "${name}" already exists (${S.vault.resolve(name)}). Names must be unique so links stay unambiguous.`);
    const out = {};
    for (const f of def.fields) { let val = d.values[f.key]; if (val === '' || val === undefined) val = null; if (f.type === 'datetime' && typeof val === 'string') val = val.trim().replace(' ', 'T') || null; out[f.key] = val; }
    list.push(...validateRecord(folder, out, S.vault));
    if (list.length) { show(list); return; }
    const btn = document.getElementById('create-btn'); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const note = await S.vault.create(`${folder}/${name}.md`, newNoteText(folder, out, d.body), `web: add ${folder}/${name}.md`);
      DRAFT = null; toast(`Created ${note.name}`); location.hash = noteHref(note.path);
    } catch (e) { btn.disabled = false; btn.textContent = 'Create'; show([explain(e)]); }
  };

  return h('div', { class: 'stack' },
    h('div', {}, h('div', { class: 'crumb' }, h('a', { href: '#/new' }, 'New'), ' / ', FOLDER_LABEL[folder]), h('h1', {}, `New ${FOLDER_LABEL[folder].toLowerCase()}`)),
    h('section', { class: 'panel stack' }, h('div', { class: 'prop' }, h('label', { for: 'new-name' }, 'Name'), nameInput, h('span', { class: 'meta' }, def.hint)), propsEditor(folder, d.values)),
    h('section', { class: 'panel' }, h('h2', {}, 'Text (optional)'), bodyArea),
    problems,
    h('div', { class: 'savebar' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', id: 'create-btn', onclick: create }, 'Create'), h('button', { class: 'btn', type: 'button', onclick: () => { DRAFT = null; location.hash = '#/today'; } }, 'Cancel'))));
}

/* ---------- settings ---------- */

function viewSettings(first) {
  const cfg = getCfg();
  const fields = {
    owner: h('input', { id: 's-owner', type: 'text', value: cfg.owner, autocapitalize: 'none', autocorrect: 'off' }),
    repo: h('input', { id: 's-repo', type: 'text', value: cfg.repo, autocapitalize: 'none', autocorrect: 'off' }),
    branch: h('input', { id: 's-branch', type: 'text', value: cfg.branch, autocapitalize: 'none', autocorrect: 'off' }),
    token: h('input', { id: 's-token', type: 'password', value: token(), autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' }),
  };
  const msg = h('p', { class: 'problems', hidden: true, role: 'alert', id: 's-msg' });
  const connectNow = async () => {
    const next = { owner: fields.owner.value.trim(), repo: fields.repo.value.trim(), branch: fields.branch.value.trim() || 'main' };
    const tok = fields.token.value.trim();
    if (!next.owner || !next.repo || !tok) { msg.textContent = 'Fill in the repository and the token.'; msg.hidden = false; return; }
    msg.hidden = true;
    try { await new GitHub({ ...next, token: tok }).repoInfo(); } catch (e) { msg.textContent = explain(e); msg.hidden = false; return; }
    store.set('lifeos.cfg', JSON.stringify(next));
    if (!store.set('lifeos.token', tok)) toast('This browser would not save the token, so you will sign in again next time.', true);
    DRAFT = null; location.hash = '#/today'; await connect();
  };
  return h('div', { class: 'stack' },
    h('h1', {}, first ? 'Connect to your vault' : 'Settings'),
    first && h('p', { class: 'muted' }, 'This app reads and writes your notes straight on GitHub. Nothing passes through any other server.'),
    h('section', { class: 'panel stack' },
      h('h2', {}, 'Repository'),
      h('div', { class: 'cols' }, h('div', { class: 'prop' }, h('label', { for: 's-owner' }, 'Owner'), fields.owner), h('div', { class: 'prop' }, h('label', { for: 's-repo' }, 'Repository'), fields.repo), h('div', { class: 'prop' }, h('label', { for: 's-branch' }, 'Branch'), fields.branch)),
      h('h2', {}, 'GitHub token'),
      h('div', { class: 'prop' }, h('label', { for: 's-token' }, 'Fine-grained personal access token'), fields.token),
      msg,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: connectNow }, 'Connect'),
        token() && h('button', { class: 'btn danger', type: 'button', onclick: () => { store.del('lifeos.token'); S.status = 'idle'; S.vault = null; DRAFT = null; render(); toast('Signed out. The token is gone from this browser.'); } }, 'Sign out'))),
    h('section', { class: 'panel' }, h('h2', {}, 'Getting a token (about two minutes)'),
      h('ol', {}, h('li', {}, 'On github.com, open Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.'),
        h('li', {}, 'Resource owner: your account. Repository access: ', h('b', {}, 'Only select repositories'), ' and pick just this vault.'),
        h('li', {}, 'Permissions → Repository permissions → ', h('b', {}, 'Contents: Read and write'), '. Nothing else is needed.'),
        h('li', {}, 'Set an expiry, generate, copy the token, paste it above.')),
      h('p', { class: 'meta' }, 'The token is kept only in this browser. On an iPad, use Share → Add to Home Screen first and sign in inside that icon: Safari clears the storage of ordinary tabs after a week without use. Sign out when you are done on a shared or school device.')));
}

/* ---------- boot ---------- */

window.addEventListener('hashchange', () => {
  if (DRAFT?.dirty && S.lastHash && S.lastHash !== location.hash && !window.confirm('Discard your unsaved changes?')) { history.replaceState(null, '', S.lastHash); return; }
  const r = route();
  if (DRAFT && !(r.view === 'note' && DRAFT.path === r.arg) && !(r.view === 'new' && DRAFT.path === `new:${r.arg}`)) DRAFT = null;
  render();
});
window.addEventListener('beforeunload', (e) => { if (DRAFT?.dirty) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
setInterval(poll, 45000);
setInterval(updateBadge, 30000);
document.body.append(toasts);
if (token()) connect(); else render();
