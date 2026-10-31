// Groups monthly captures into "eras": runs of months with the same messaging.
const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function keyOf(data, withMeta) {
  const parts = [data.headline, data.subheadline];
  if (withMeta) parts.push(data.description);
  return parts.map(norm).join('|');
}

// The site's main language = the most common one among readable captures.
// Captures in other languages are regional versions the crawler happened to get, not changes.
export function splitByLanguage(snapshots) {
  const counts = new Map();
  for (const s of snapshots) if (s.data) counts.set(s.data.lang || '', (counts.get(s.data.lang || '') || 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const other = snapshots.filter((s) => s.data && s.data.lang && main && s.data.lang !== main);
  return { main, kept: snapshots.filter((s) => !other.includes(s)), other };
}

export function buildEras(snapshots, withMeta) {
  const ok = snapshots.filter((s) => s.data).sort((a, b) => a.ts.localeCompare(b.ts));
  const eras = [];
  for (const s of ok) {
    const key = keyOf(s.data, withMeta);
    const last = eras[eras.length - 1];
    if (last && last.key === key) {
      last.lastTs = s.ts;
      last.captures++;
    } else {
      eras.push({ key, data: s.data, firstTs: s.ts, lastTs: s.ts, original: s.original, captures: 1 });
    }
  }
  // Patterns that usually mean a test or a short campaign rather than a new position.
  eras.forEach((e, i) => {
    const earlier = eras.slice(0, i).find((x) => x.key === e.key);
    if (earlier) e.returnOf = earlier.firstTs;
    const prev = eras[i - 1];
    const next = eras[i + 1];
    if (prev && next && prev.key === next.key && e.captures === 1) e.oneOff = true;
  });
  return eras;
}
