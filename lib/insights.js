// Plain-language findings across the whole period, oldest era vs newest era.
const STOP = new Set(('a an and are as at be by can for from has have how in into is it its more most of on or our ' +
  'that the their them they this to up us we what when where which while who why will with you your yours all any ' +
  'every get just like make new not now one out over so than then there these those through use very way all-in-one')
  .split(' '));

function words(text) {
  const out = new Map(); // lowercase -> as written
  for (const raw of (text || '').split(/[^\p{L}\p{N}'’-]+/u)) {
    const w = raw.replace(/^['’-]+|['’-]+$/g, '');
    const key = w.toLowerCase();
    if (key.length < 2 || STOP.has(key) || /^\d+$/.test(key)) continue;
    if (!out.has(key)) out.set(key, w);
  }
  return out;
}

const tsDate = (ts) => new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8)));
const sameText = (a, b) => (a || '').toLowerCase().trim() === (b || '').toLowerCase().trim();

export function buildInsights(eras) {
  const archived = eras.filter((e) => e.kind === 'archive');
  if (eras.length < 2 || !archived.length) return [];
  const first = eras[0].data;
  const last = eras[eras.length - 1].data;
  const items = [];

  // Longest-running message.
  let best = null;
  archived.forEach((e, i) => {
    const end = i + 1 < archived.length ? tsDate(archived[i + 1].firstTs) : new Date();
    const months = Math.max(1, Math.round((end - tsDate(e.firstTs)) / (30.4 * 864e5)));
    if (!best || months > best.months) best = { months, text: e.data.headline };
  });
  if (best) items.push({ type: 'longest', ...best });

  // Words that came in and went out of the headline + line under it.
  const before = words(`${first.headline} ${first.subheadline}`);
  const after = words(`${last.headline} ${last.subheadline}`);
  // Acronyms (AI, CRM) and capitalised words first: they tend to be the category and product terms.
  const rank = (w) => (/^[A-Z0-9]{2,}$/.test(w) ? 0 : /^[A-Z]/.test(w) ? 1 : 2);
  const pickWords = (from, other) => [...from].filter(([k]) => !other.has(k)).map(([, w]) => w)
    .sort((x, y) => rank(x) - rank(y)).slice(0, 8);
  const added = pickWords(after, before);
  const dropped = pickWords(before, after);
  if (added.length || dropped.length) items.push({ type: 'words', added, dropped });

  const firstCtas = (first.ctas || []).join(' · ');
  const lastCtas = (last.ctas || []).join(' · ');
  if (firstCtas && lastCtas && !sameText(firstCtas, lastCtas)) items.push({ type: 'buttons', from: firstCtas, to: lastCtas });

  if (first.proof && last.proof && !sameText(first.proof, last.proof)) items.push({ type: 'proof', from: first.proof, to: last.proof });
  else if (last.proof) items.push({ type: 'proof-now', text: last.proof });

  if (first.title && last.title && !sameText(first.title, last.title)) items.push({ type: 'title', from: first.title, to: last.title });

  return items;
}
