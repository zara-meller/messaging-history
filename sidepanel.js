import { extractMessaging } from './lib/extract.js';
import { listSnapshots, fetchSnapshotHtml, snapshotUrl, isBlockedPage } from './lib/wayback.js';
import { buildEras, keyOf, splitByLanguage } from './lib/eras.js';
import { buildInsights } from './lib/insights.js';
import { diffWords, keptShare } from './lib/diff.js';

const CACHE_TTL = 7 * 24 * 3600 * 1000;
const CONCURRENCY = 2;
const SAMPLE_STEP = 3;
const $ = (sel) => document.querySelector(sel);

const state = {
  host: '',
  tabId: null,
  months: 24,
  withMeta: false,
  snapshots: [],
  total: 0,
  expected: 0,
  live: null,
  cachedAt: null,
  loading: false,
  progress: '',
  error: '',
  run: 0,
};

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const tsDate = (ts) => new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8)));
const fmtMonth = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const langName = (code) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

function hostOf(input) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return '';
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// The live tab only counts if it is the homepage (or a locale root like /en-us).
function isHomepage(url) {
  try {
    return /^\/([a-z]{2}([-_][a-z]{2})?\/?)?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- data ----------

async function analyze(host, { tabId = null, force = false } = {}) {
  const run = ++state.run;
  Object.assign(state, {
    host, tabId, snapshots: [], total: 0, expected: 0, live: null, cachedAt: null,
    loading: true, progress: 'Checking the archive…', error: '',
  });
  render();
  if (tabId != null) readLive(tabId, run);

  const cacheKey = `mh2:${host}:${state.months}`;
  try {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (run !== state.run) return;
    if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
      Object.assign(state, { snapshots: cached.snapshots, total: cached.total, cachedAt: cached.at, loading: false });
      render();
      return;
    }

    const list = await listSnapshots(host, state.months);
    if (run !== state.run) return;
    if (!list.length) {
      Object.assign(state, { loading: false, error: `The Wayback Machine has no captures of ${host}'s homepage in this period.` });
      render();
      return;
    }

    state.total = list.length;
    const results = new Map(); // month index -> { data, error }
    const byDigest = new Map(); // identical captures are read once
    const readMonths = async (indices, label) => {
      state.expected += indices.length;
      await pool(indices, CONCURRENCY, async (i) => {
        if (run !== state.run || results.has(i)) return;
        const snap = list[i];
        state.progress = `${label}… ${fmtMonth(tsDate(snap.ts))}`;
        scheduleRender();
        if (!byDigest.has(snap.digest)) byDigest.set(snap.digest, readSnapshot(snap));
        const result = await byDigest.get(snap.digest);
        if (run !== state.run) return;
        results.set(i, result);
        state.snapshots.push({ ...snap, ...result });
        scheduleRender();
      });
    };

    // The archive rate-limits hard, so don't read every month. Sample every third month,
    // then bisect only between neighbouring samples that differ to find the month of each change.
    const samples = [];
    for (let i = 0; i < list.length; i += SAMPLE_STEP) samples.push(i);
    if (samples[samples.length - 1] !== list.length - 1) samples.push(list.length - 1);
    await readMonths(samples, 'Sampling every third month');

    const gaps = samples
      .filter((i) => !results.get(i)?.data)
      .map((i) => i + 1)
      .filter((i) => i < list.length && !results.has(i));
    if (gaps.length) await readMonths(gaps, 'Replacing unreadable captures');

    for (;;) {
      if (run !== state.run) return;
      const readable = [...results.keys()].filter((i) => results.get(i).data).sort((a, b) => a - b);
      const mids = [];
      for (let k = 0; k + 1 < readable.length; k++) {
        const [a, b] = [readable[k], readable[k + 1]];
        if (keyOf(results.get(a).data, true) === keyOf(results.get(b).data, true)) continue;
        const open = [];
        for (let i = a + 1; i < b; i++) if (!results.has(i)) open.push(i);
        if (!open.length) continue;
        open.sort((x, y) => Math.abs(x - (a + b) / 2) - Math.abs(y - (a + b) / 2));
        mids.push(open[0]);
      }
      if (!mids.length) break;
      await readMonths(mids, `Pinpointing ${plural(mids.length, 'change')}`);
    }
    if (run !== state.run) return;

    state.snapshots.sort((a, b) => a.ts.localeCompare(b.ts));
    state.loading = false;
    render();
    if (state.snapshots.some((s) => s.data)) {
      chrome.storage.local.set({ [cacheKey]: { at: Date.now(), total: list.length, snapshots: state.snapshots } });
    }
  } catch (e) {
    if (run !== state.run) return;
    Object.assign(state, { loading: false, error: `Couldn't reach the Wayback Machine (${e.message}). It is often slow; try again in a minute.` });
    render();
  }
}

async function readSnapshot(snap) {
  try {
    const html = await fetchSnapshotHtml(snap.ts, snap.original);
    const data = extractMessaging(new DOMParser().parseFromString(html, 'text/html'));
    if (!data.headline || isBlockedPage(data)) return { data: null, error: 'unreadable capture' };
    return { data };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

async function readLive(tabId, run) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: extractMessaging });
    if (run !== state.run || !res?.result?.headline) return;
    state.live = res.result;
    render();
  } catch {
    // No access to this tab any more (activeTab only lasts for the click); archive only.
  }
}

// ---------- timeline model ----------

function timeline() {
  const { main, kept } = splitByLanguage(state.snapshots);
  const eras = buildEras(kept, state.withMeta).map((e) => ({ ...e, kind: 'archive' }));
  if (state.live && (!main || !state.live.lang || state.live.lang === main)) {
    const last = eras[eras.length - 1];
    if (last && last.key === keyOf(state.live, state.withMeta)) last.stillLive = true;
    else eras.push({ kind: 'live', key: keyOf(state.live, state.withMeta), data: state.live });
  }
  return eras; // oldest first
}

function changeInfo(prev, cur) {
  if (!prev) return { labels: [], rewrite: false };
  const p = prev.data;
  const c = cur.data;
  const same = (a, b) => keyOf({ headline: a }, false) === keyOf({ headline: b }, false);
  const labels = [];
  if (!same(p.headline, c.headline)) labels.push('Headline');
  if (!same(p.subheadline, c.subheadline)) labels.push('Subheadline');
  if (state.withMeta && !same(p.description, c.description)) labels.push('Meta');
  const rewrite = labels.includes('Headline') && keptShare(p.headline, c.headline) < 0.4;
  return { labels, rewrite };
}

// ---------- rendering ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function diffNodes(oldText, newText, showDiff) {
  if (!newText) return [h('span', { class: 'none' }, 'none found')];
  if (!showDiff || !oldText) return [newText];
  // A full rewrite reads as word salad when interleaved; show the new text whole, the old one under it.
  if (keptShare(oldText, newText) < 0.5) {
    return [h('ins', {}, newText), h('span', { class: 'was' }, 'before: ', h('del', {}, oldText))];
  }
  const runs = diffWords(oldText, newText);
  const nodes = [];
  runs.forEach((r, i) => {
    if (i) nodes.push(' ');
    nodes.push(r.type === 'same' ? r.text : h(r.type, {}, r.text));
  });
  return nodes;
}

function renderHeader() {
  const from = new Date();
  from.setUTCMonth(from.getUTCMonth() - state.months);
  $('#site-name').textContent = state.host || 'Competitors';
  $('#site-sub').textContent = state.host ? `since ${fmtMonth(from)}` : 'their story over time';
  fitTitle();
  $('#refresh').disabled = !state.host || state.loading;

  const p = $('#progress');
  p.hidden = !state.loading;
  if (state.loading) {
    const pct = state.expected ? (state.snapshots.length / state.expected) * 100 : 4;
    $('#progress-fill').style.width = `${Math.max(pct, 4)}%`;
    $('#progress-text').textContent = state.progress;
  }
}

// Domain as one line of condensed caps, as big as the panel width allows.
function fitTitle() {
  const el = $('#site-name');
  const max = 64;
  el.style.fontSize = `${max}px`;
  const room = el.parentElement.clientWidth;
  const width = el.getBoundingClientRect().width; // includes the scaleX narrowing
  if (width > room) el.style.fontSize = `${Math.max(24, Math.floor((max * room) / width))}px`;
}

const eraColor = (i) => (i % 2 ? 'var(--black)' : 'var(--red)');

function renderStrip(eras) {
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - state.months);
  const end = Date.now();
  const span = end - start.getTime();
  const strip = h('div', { class: 'strip', role: 'list' });
  const archived = eras.filter((e) => e.kind === 'archive');
  if (!archived.length) return null;

  const firstStart = tsDate(archived[0].firstTs).getTime();
  if (firstStart - start.getTime() > span * 0.02) {
    strip.append(h('div', { class: 'gap', style: `flex:${firstStart - start.getTime()}`, title: 'No readable captures' }));
  }
  archived.forEach((e, i) => {
    const from = tsDate(e.firstTs).getTime();
    const to = i + 1 < archived.length ? tsDate(archived[i + 1].firstTs).getTime() : end;
    const label = `${fmtMonth(tsDate(e.firstTs))}: ${e.data.headline}`;
    strip.append(h('button', {
      style: `flex:${Math.max(to - from, span * 0.01)};background:${eraColor(i)}`,
      title: label,
      'aria-label': label,
      onclick: () => document.getElementById(`era-${e.firstTs}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }));
  });
  return h('div', {},
    strip,
    h('div', { class: 'strip-labels' }, h('span', {}, fmtMonth(start)), h('span', {}, 'now')));
}

function renderEra(era, prev, index, isNewest) {
  const d = era.data;
  const { labels, rewrite } = changeInfo(prev, era);
  const color = era.kind === 'live' ? 'var(--red)' : eraColor(index);

  let when;
  if (era.kind === 'live') when = 'Live now';
  else {
    const a = fmtMonth(tsDate(era.firstTs));
    const b = era.stillLive ? 'now' : fmtMonth(tsDate(era.lastTs));
    when = a === b ? a : `${a} – ${b}`;
  }

  // One short label per card, plus a sentence when the pattern needs explaining.
  let note = null;
  let context = null;
  if (era.kind === 'live') {
    note = h('span', { class: 'badge' }, 'new on the live page');
    context = 'The page you have open says something different from the last saved copy, so this changed recently.';
  } else if (!prev) {
    note = h('span', { class: 'badge quiet' }, 'earliest saved');
  } else if (era.oneOff) {
    note = h('span', { class: 'badge' }, 'short test?');
    context = 'Seen in one month only, then the previous message came back. Usually an A/B test or a short campaign.';
  } else if (era.returnOf) {
    note = h('span', { class: 'badge' }, 'came back');
    context = `The same words ran in ${fmtMonth(tsDate(era.returnOf))}. A message that leaves and returns often means they were testing versions.`;
  } else if (rewrite) {
    note = h('span', { class: 'badge' }, 'rewritten');
  } else if (labels.length) {
    note = h('span', { class: 'badge' }, `new ${labels[0].toLowerCase()}`);
  }

  const prevCtas = new Set((prev?.data.ctas || []).map((c) => c.toLowerCase()));
  const metaRows = [
    ['Page title (Google result and browser tab)', d.title, prev?.data.title],
    ['Description under the title in Google', d.description, prev?.data.description],
    ['Title when the link is shared', d.ogTitle, prev?.data.ogTitle],
    ['Description when the link is shared', d.ogDescription, prev?.data.ogDescription],
  ].filter(([, v]) => v);

  const sourceNote = {
    h1: '', h2: 'no main heading found, using the first subheading',
    'og:title': 'headline missing from the saved copy, using the share title', title: 'headline missing from the saved copy, using the page title',
  }[d.source] || '';

  const field = (label, ...content) => h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), ...content);

  return h('li', { class: `era${isNewest ? ' current' : ''}`, id: `era-${era.firstTs || 'live'}`, style: `--era-color:${color}` },
    h('div', { class: 'era-head' },
      h('span', { class: 'cond era-when' }, when),
      note),
    h('div', { class: 'card' },
      context ? h('p', { class: 'context' }, context) : null,
      field('Headline', h('h2', { class: 'hl' }, diffNodes(prev?.data.headline, d.headline, true))),
      d.subheadline
        ? field('Line under the headline', h('p', { class: 'sub' }, diffNodes(prev?.data.subheadline, d.subheadline, true)))
        : null,
      d.ctas?.length
        ? field(prev ? 'Buttons (red = new this period)' : 'Buttons',
          h('div', { class: 'chips' }, d.ctas.map((c) => h('span', { class: `chip${prev && !prevCtas.has(c.toLowerCase()) ? ' new' : ''}` }, c))))
        : null,
      d.proof ? field('Proof they show', h('p', { class: 'sub' }, diffNodes(prev?.data.proof, d.proof, true))) : null,
      metaRows.length
        ? h('details', { class: 'meta' },
          h('summary', {}, 'How it shows in Google and when shared'),
          h('dl', {}, metaRows.map(([k, v, old]) => [h('dt', {}, k), h('dd', {}, diffNodes(old, v, !!prev))])))
        : null,
      h('div', { class: 'card-foot' },
        h('span', { class: 'source' }, sourceNote),
        era.kind === 'archive'
          ? h('a', { href: snapshotUrl(era.firstTs, era.original), target: '_blank', rel: 'noopener' }, 'see the page ↗')
          : null)));
}

function renderInsights(eras) {
  const items = buildInsights(eras);
  if (!items.length) return null;
  const since = fmtMonth(tsDate(eras[0].firstTs));
  const q = (t) => `“${t}”`;
  const fromTo = (label, from, to) => h('li', {},
    h('div', { class: 'ins-label' }, label),
    h('div', { class: 'ins-from' }, q(from)),
    h('div', { class: 'ins-to' }, '→ ', q(to)));
  const rows = items.map((it) => {
    switch (it.type) {
      case 'longest':
        return h('li', {},
          h('div', { class: 'ins-label' }, `Longest-running headline, about ${plural(it.months, 'month')}`),
          h('div', { class: 'ins-to' }, q(it.text)));
      case 'words':
        return h('li', {},
          h('div', { class: 'ins-label' }, `Words in the headline and the line under it, now vs ${since}`),
          it.added.length ? h('div', { class: 'chips' }, h('span', { class: 'chips-label' }, 'started saying'),
            it.added.map((w) => h('span', { class: 'chip new' }, w))) : null,
          it.dropped.length ? h('div', { class: 'chips' }, h('span', { class: 'chips-label' }, 'stopped saying'),
            it.dropped.map((w) => h('span', { class: 'chip gone' }, w))) : null);
      case 'buttons':
        return fromTo('What they ask visitors to do (buttons)', it.from, it.to);
      case 'proof':
        return fromTo('Proof they show (customers, numbers, logos)', it.from, it.to);
      case 'proof-now':
        return h('li', {},
          h('div', { class: 'ins-label' }, 'Proof they show now'),
          h('div', { class: 'ins-to' }, q(it.text)));
      case 'title':
        return fromTo('How they describe themselves in Google (page title)', it.from, it.to);
      default:
        return null;
    }
  });
  return h('section', { class: 'insights' },
    h('div', { class: 'section-title' }, 'What changed'),
    h('ul', {}, rows));
}

function render() {
  renderHeader();
  const main = $('#main');
  main.replaceChildren();
  $('#footer').hidden = true;

  if (!state.host) {
    main.append(h('div', { class: 'state' },
      h('div', { class: 'cond' }, 'Open a homepage'),
      h('div', { class: 'lead' }, 'then click the icon'),
      h('p', {}, 'Go to any competitor’s site and click Messaging History in the toolbar, or type a domain above.')));
    return;
  }
  if (state.error) {
    main.append(h('div', { class: 'state' },
      h('div', { class: 'cond' }, 'No history yet'),
      h('p', {}, state.error),
      h('button', { onclick: () => analyze(state.host, { tabId: state.tabId, force: true }) }, 'Try again')));
    return;
  }

  const eras = timeline();
  if (!eras.length) {
    if (!state.loading) {
      main.append(h('div', { class: 'state' },
        h('div', { class: 'cond' }, 'Nothing readable'),
        h('p', {}, `The archive has captures of ${state.host}, but none had a headline in the saved HTML. Sites that draw everything with JavaScript often save empty.`)));
    }
    return;
  }

  const archived = eras.filter((e) => e.kind === 'archive');
  const changes = eras.length - 1;
  const readable = state.snapshots.filter((s) => s.data).length;
  const since = archived.length ? fmtMonth(tsDate(archived[0].firstTs)) : '';
  const tests = eras.filter((e) => e.oneOff || e.returnOf).length;
  main.append(h('section', { class: 'summary' },
    h('div', { class: 'cond summary-big' }, changes ? plural(changes, 'change') : 'No changes'),
    h('div', { class: 'summary-tail' },
      `to the homepage message since ${since}` + (tests ? `, ${tests} of them look like tests` : '')),
    h('div', { class: 'summary-small' },
      `Read ${readable} saved copies of the homepage out of ${state.total} months` +
      (state.cachedAt ? ` · saved ${new Date(state.cachedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : '')),
    renderStrip(eras),
    h('div', { class: 'strip-caption' }, 'Each block is one message. Tap a block to jump to it.')));

  const insights = renderInsights(eras);
  if (insights) main.append(insights);

  const { other } = splitByLanguage(state.snapshots);
  if (other.length) {
    const names = [...new Set(other.map((s) => langName(s.data.lang)))].join(', ');
    main.append(h('p', { class: 'aside' },
      `Hidden: ${plural(other.length, 'saved copy', 'saved copies')} in ${names}. The archive sometimes saves a country version of the site. That is a translation, not a message change.`));
  }

  main.append(h('div', { class: 'section-title' }, 'Timeline'),
    h('p', { class: 'legend' },
      'Each card is compared with the one below it: ', h('ins', {}, 'red'), ' = new words, ', h('del', {}, 'struck out'), ' = removed.'));

  const list = h('ol', { class: 'timeline' });
  for (let i = eras.length - 1; i >= 0; i--) {
    list.append(renderEra(eras[i], eras[i - 1], i, i === eras.length - 1));
  }
  main.append(list);
  main.append(h('p', { class: 'note' },
    'How this works: the Internet Archive saves copies of public homepages. We read one copy every three months, plus extra months around each change to date it. A message that ran only a few weeks between two checks may not show up.'));

  $('#footer').hidden = state.loading;
}

// ---------- export ----------

function toMarkdown() {
  const eras = timeline();
  const lines = [`# ${state.host}: homepage messaging history`, ''];
  for (let i = eras.length - 1; i >= 0; i--) {
    const e = eras[i];
    const d = e.data;
    const when = e.kind === 'live' ? 'Live now'
      : `${fmtMonth(tsDate(e.firstTs))} – ${e.stillLive ? 'now' : fmtMonth(tsDate(e.lastTs))}`;
    lines.push(`## ${when}`);
    lines.push(`**Headline:** ${d.headline}`);
    if (d.subheadline) lines.push(`**Line under the headline:** ${d.subheadline}`);
    if (d.ctas?.length) lines.push(`**Buttons:** ${d.ctas.join(' · ')}`);
    if (d.proof) lines.push(`**Proof:** ${d.proof}`);
    if (d.description) lines.push(`**Meta description:** ${d.description}`);
    if (e.kind === 'archive') lines.push(`[Capture](${snapshotUrl(e.firstTs, e.original)})`);
    lines.push('');
  }
  return lines.join('\n');
}

function toCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['date', 'language', 'headline', 'subheadline', 'buttons', 'proof', 'title', 'meta_description', 'capture_url']];
  for (const s of state.snapshots) {
    if (!s.data) continue;
    const d = s.data;
    rows.push([tsDate(s.ts).toISOString().slice(0, 10), d.lang, d.headline, d.subheadline, d.ctas.join(' | '),
      d.proof, d.title, d.description, snapshotUrl(s.ts, s.original)]);
  }
  if (state.live) {
    const d = state.live;
    rows.push([new Date().toISOString().slice(0, 10), d.lang, d.headline, d.subheadline, d.ctas.join(' | '), d.proof, d.title, d.description, 'live']);
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

// ---------- wiring ----------

async function openTarget(target) {
  const host = hostOf(target.url || '');
  if (!host) {
    state.run++;
    Object.assign(state, { host: '', loading: false, error: '' });
    render();
    return;
  }
  analyze(host, { tabId: isHomepage(target.url) ? target.tabId : null });
}

async function init() {
  const prefs = await chrome.storage.local.get(['months', 'withMeta']);
  state.months = prefs.months || 24;
  state.withMeta = !!prefs.withMeta;
  $('#range').value = String(state.months);
  $('#with-meta').checked = state.withMeta;

  $('#lookup').addEventListener('submit', (e) => {
    e.preventDefault();
    const host = hostOf($('#domain').value.trim());
    if (!host) return toast('That doesn’t look like a domain');
    $('#domain').value = '';
    $('#domain').blur();
    analyze(host);
  });
  $('#range').addEventListener('change', (e) => {
    state.months = +e.target.value;
    chrome.storage.local.set({ months: state.months });
    if (state.host) analyze(state.host, { tabId: state.tabId });
  });
  $('#with-meta').addEventListener('change', (e) => {
    state.withMeta = e.target.checked;
    chrome.storage.local.set({ withMeta: state.withMeta });
    render();
  });
  $('#refresh').addEventListener('click', () => analyze(state.host, { tabId: state.tabId, force: true }));
  $('#copy-md').addEventListener('click', async () => {
    await navigator.clipboard.writeText(toMarkdown());
    toast('Copied as Markdown');
  });
  $('#download-csv').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([toCsv()], { type: 'text/csv' }));
    h('a', { href: url, download: `${state.host}-messaging-history.csv` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.target?.newValue) openTarget(changes.target.newValue);
  });
  const { target } = await chrome.storage.session.get('target');
  if (target) openTarget(target);
  else render();
}

window.addEventListener('resize', fitTitle);
document.fonts.ready.then(fitTitle);
init();
