// Talks to GitHub and understands the vault's note format (YAML frontmatter + Markdown body).
// No dependencies, no build step. Everything that touches the network or parses a note lives here.
import SCHEMA from './schema.js';

export const RECORD_FOLDERS = Object.keys(SCHEMA.folders);
const HIDDEN_TOP = new Set(['migration', 'scripts', 'web', 'node_modules']);
const ISO = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const BAD_NAME = /[\\/:*?"<>|#^[\]]/;

/* ---------- GitHub ---------- */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    Object.assign(this, { owner, repo, branch, token });
  }

  async request(method, path, { body, raw = false, accept = 'application/vnd.github+json' } = {}) {
    const headers = { Authorization: `Bearer ${this.token}`, Accept: accept };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(`https://api.github.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new ApiError(0, 'Could not reach GitHub. Check the connection.');
    }
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).message || message; } catch { /* body was not JSON */ }
      throw new ApiError(res.status, message);
    }
    return raw ? res.text() : res.json();
  }

  get base() { return `/repos/${this.owner}/${this.repo}`; }
  repoInfo() { return this.request('GET', this.base); }
  // The "_" parameter keeps the browser from serving a cached copy of an authenticated read.
  tree() { return this.request('GET', `${this.base}/git/trees/${encodeURIComponent(this.branch)}?recursive=1&_=${Date.now()}`); }
  readFile(path) {
    return this.request('GET', `${this.base}/contents/${enc(path)}?ref=${encodeURIComponent(this.branch)}&_=${Date.now()}`,
      { raw: true, accept: 'application/vnd.github.raw+json' });
  }
  async writeFile(path, text, sha, message) {
    const body = { message, content: toBase64(text), branch: this.branch };
    if (sha) body.sha = sha;
    const j = await this.request('PUT', `${this.base}/contents/${enc(path)}`, { body });
    return { sha: j.content.sha, commit: j.commit.sha };
  }
}

/* ---------- frontmatter ---------- */

export function splitNote(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (!text.startsWith('---' + eol)) return { fmText: null, eol, rest: text };
  const m = /\r?\n---[ \t]*(?=\r?\n|$)/.exec(text.slice(3));
  if (!m) return { fmText: null, eol, rest: text };
  return { fmText: text.slice(3 + eol.length, 3 + m.index), eol, rest: text.slice(3 + m.index + m[0].length) };
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s[0] === '"') { try { return JSON.parse(s); } catch { return s.replace(/^"|"$/g, ''); } }
  if (s[0] === "'") return s.replace(/^'|'$/g, '').replace(/''/g, "'");
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseInlineList(s) {
  const inner = s.trim().slice(1, -1);
  const out = [];
  let cur = '', quote = null;
  for (const ch of inner) {
    if (quote) { cur += ch; if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
    else if (ch === ',') { out.push(parseScalar(cur)); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(parseScalar(cur));
  return out.filter((v) => v !== null);
}

// Each entry keeps its original lines, so a field nobody edits is written back byte for byte.
export function parseFM(fmText) {
  const entries = [];
  let cur = null;
  for (const line of fmText === null ? [] : fmText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (m) {
      cur = { key: m[1], inline: m[2] ?? '', cont: [], lines: [line] };
      entries.push(cur);
    } else if (cur) {
      cur.cont.push(line);
      cur.lines.push(line);
    } else {
      entries.push({ key: null, inline: '', cont: [], lines: [line], value: null });
    }
  }
  for (const e of entries) {
    if (e.key === null) continue;
    const items = e.cont.filter((l) => /^\s*-\s+/.test(l));
    if (e.inline === '' && items.length && items.length === e.cont.filter((l) => l.trim()).length) {
      e.value = items.map((l) => parseScalar(l.replace(/^\s*-\s+/, '')));
    } else if (e.inline.startsWith('[') && e.inline.endsWith(']')) {
      e.value = parseInlineList(e.inline);
    } else if (e.cont.some((l) => l.trim())) {
      e.value = null; e.opaque = true; // multi-line text we do not edit
    } else {
      e.value = parseScalar(e.inline);
    }
  }
  return entries;
}

function scalarText(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return ISO.test(s) ? s : JSON.stringify(s);
}

export function serializeEntry(key, value) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return [];
  if (Array.isArray(value)) return [`${key}:`, ...value.map((v) => `  - ${scalarText(v)}`)];
  return [`${key}: ${scalarText(value)}`];
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Change one property. Returns true if the text actually changes.
export function setEntry(entries, key, value) {
  const i = entries.findIndex((e) => e.key === key);
  if (i >= 0 && !entries[i].opaque && same(entries[i].value, value === '' ? null : value)) return false;
  const lines = serializeEntry(key, value);
  if (i >= 0) {
    if (!lines.length) entries.splice(i, 1);
    else entries[i] = { key, value, lines, cont: [], inline: '' };
  } else if (lines.length) {
    entries.push({ key, value, lines, cont: [], inline: '' });
  } else return false;
  return true;
}

export const fmData = (entries) => Object.fromEntries(entries.filter((e) => e.key).map((e) => [e.key, e.value]));

export function buildNote({ entries, eol, rest }) {
  return `---${eol}${entries.flatMap((e) => e.lines).join(eol)}${entries.length ? eol : ''}---${rest}`;
}

/* ---------- names, dates ---------- */

export function cleanName(raw) {
  return raw.replace(/: /g, ' - ').replace(/:/g, ' -').replace(/[\\/*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 120);
}
export const nameProblem = (name) => (!name ? 'Give it a name.' : BAD_NAME.test(name) ? 'The name cannot contain \\ / : * ? " < > | # ^ [ ]' : null);
export const todayISO = () => new Date().toLocaleDateString('en-CA');
export const isRecordPath = (p) => RECORD_FOLDERS.includes(p.split('/')[0]) && p.split('/').length === 2;
export const isVaultMd = (p) => p.endsWith('.md') && !p.startsWith('.') && !HIDDEN_TOP.has(p.split('/')[0]) && !p.split('/').some((s) => s.startsWith('.'));
export const baseName = (p) => p.split('/').pop().replace(/\.md$/, '');

/* ---------- the vault ---------- */

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

export class Vault {
  constructor(gh) {
    this.gh = gh;
    this.notes = new Map();   // path -> note (loaded)
    this.shas = new Map();    // path -> blob sha, for every file in the repo
    this.paths = [];          // vault markdown paths
    this.byName = new Map();  // lowercase name -> path
  }

  makeNote(path, text, sha) {
    const { fmText, eol, rest } = splitNote(text);
    const entries = parseFM(fmText);
    return { path, name: baseName(path), folder: path.split('/')[0], sha, text, hasFM: fmText !== null, parts: { entries, eol, rest }, data: fmData(entries) };
  }

  index() {
    this.paths = [...this.shas.keys()].filter(isVaultMd).sort((a, b) => a.localeCompare(b));
    this.byName = new Map();
    for (const p of this.paths) {
      const k = baseName(p).toLowerCase();
      if (!this.byName.has(k) || isRecordPath(p)) this.byName.set(k, p);
    }
  }

  resolve(name) { return this.byName.get(name.trim().toLowerCase()) || null; }

  async load(onProgress) {
    const t = await this.gh.tree();
    this.truncated = !!t.truncated;
    this.shas = new Map(t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    this.index();
    const todo = this.paths.filter(isRecordPath);
    let done = 0;
    await pool(todo, 6, async (p) => {
      this.notes.set(p, this.makeNote(p, await this.gh.readFile(p), this.shas.get(p)));
      onProgress?.(++done, todo.length);
    });
  }

  async open(path) {
    if (!this.notes.has(path)) this.notes.set(path, this.makeNote(path, await this.gh.readFile(path), this.shas.get(path)));
    return this.notes.get(path);
  }

  // Cheap "has anything changed" check: one tree call, then re-read only files whose blob changed.
  async refresh() {
    const t = await this.gh.tree();
    const next = new Map(t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    const changed = [];
    for (const [p, sha] of next) if (this.shas.get(p) !== sha) changed.push(p);
    const removed = [...this.shas.keys()].filter((p) => !next.has(p));
    this.shas = next;
    this.index();
    for (const p of removed) this.notes.delete(p);
    await pool(changed.filter((p) => this.notes.has(p) || (isVaultMd(p) && isRecordPath(p))), 6, async (p) => {
      this.notes.set(p, this.makeNote(p, await this.gh.readFile(p), next.get(p)));
    });
    for (const p of changed) if (!isRecordPath(p)) this.notes.delete(p);
    return changed.length + removed.length;
  }

  async save(note, text, message) {
    const r = await this.gh.writeFile(note.path, text, note.sha, message);
    const fresh = this.makeNote(note.path, text, r.sha);
    this.notes.set(note.path, fresh);
    this.shas.set(note.path, r.sha);
    return fresh;
  }

  async create(path, text, message) {
    if (this.shas.has(path)) throw new ApiError(422, 'A note with that name already exists.');
    const r = await this.gh.writeFile(path, text, null, message);
    this.shas.set(path, r.sha);
    this.index();
    const note = this.makeNote(path, text, r.sha);
    this.notes.set(path, note);
    return note;
  }

  records(folder) {
    return [...this.notes.values()].filter((n) => n.folder === folder && isRecordPath(n.path)).sort((a, b) => a.name.localeCompare(b.name));
  }
}

// Mirrors the rules in scripts/validate_vault.py for what a form can get wrong. The Python validator stays the authority.
export function validateRecord(folder, data, vault) {
  const problems = [];
  const def = SCHEMA.folders[folder];
  if (!def) return problems;
  for (const f of def.fields) {
    const v = data[f.key];
    if (v === null || v === undefined || v === '') continue;
    if (f.type === 'select' && !f.options.includes(v)) problems.push(`${f.key}: "${v}" is not an allowed value.`);
    if (f.type === 'date' && !ISO.test(String(v))) problems.push(`${f.key}: use a date like 2026-10-31.`);
    if (f.type === 'datetime' && !ISO.test(String(v))) problems.push(`${f.key}: use 2026-10-31 or 2026-10-31T14:00:00Z.`);
    if (f.type === 'number' && (typeof v !== 'number' || Number.isNaN(v))) problems.push(`${f.key}: must be a number.`);
    if (f.key === 'amount' && typeof v === 'number' && v < 0) problems.push('amount: enter a positive number; type says expense or income.');
    if (f.type === 'course') for (const l of [].concat(v)) {
      const m = /^\[\[([^\]|#]+)/.exec(l);
      if (!m || !vault.notes.has(`Courses/${m[1]}.md`)) problems.push(`course: ${l} is not a course in Courses/.`);
    }
  }
  const { area, part } = data;
  if (area && part && SCHEMA.partsByArea[area] && folder !== 'Routines' && !SCHEMA.partsByArea[area].includes(part)) problems.push(`part: "${part}" does not belong to ${area}.`);
  if (['Tasks'].includes(folder) && !area && data.status !== 'Inbox') problems.push('area: every task needs an area unless its status is Inbox.');
  if (['Notes', 'Events', 'Money', 'Routines', 'People'].includes(folder) && !area) problems.push('area: every row gets an area.');
  if (folder === 'Tasks' && data.phase && area !== 'lumi') problems.push('phase: only lumi tasks have a phase.');
  if (folder === 'Coursework' && !(data.course && data.course.length)) problems.push('course: coursework needs a course.');
  return problems;
}
