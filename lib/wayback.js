// Free data source: the Internet Archive's Wayback Machine.
// CDX lists captures; the "id_" URL returns the original HTML without the archive toolbar.
const WB = 'https://web.archive.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = 4000; // ~15 requests a minute: faster gets flagged as bot traffic (HTTP 429)

// Shared across all callers: each request takes the next free slot.
let nextSlot = 0;
async function waitTurn() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + GAP;
  if (at > now) await sleep(at - now);
}

async function get(url, { timeout = 45000, tries = 4 } = {}) {
  for (let i = 0; ; i++) {
    await waitTurn();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, credentials: 'omit' });
      if (res.status === 429) {
        // Pause every queued request, not just this one.
        const retryAfter = Number(res.headers.get('Retry-After')) * 1000 || 0;
        nextSlot = Date.now() + Math.max(retryAfter, 15000 * (i + 1));
        throw new Error('the archive asked us to slow down');
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.final = res.status < 500;
        throw err;
      }
      return await res.text();
    } catch (e) {
      if (e.final || i >= tries - 1) throw e.name === 'AbortError' ? new Error('timed out') : e;
      await sleep(2000 * 2 ** i);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function cdx(url) {
  const text = await get(url);
  if (!text.trim()) return [];
  return JSON.parse(text).slice(1); // first row is the header
}

// One capture per month (the first of each month) across the range.
export async function listSnapshots(host, months) {
  const to = new Date();
  const from = new Date();
  from.setUTCMonth(from.getUTCMonth() - months);
  const ym = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const base = `${WB}/cdx/search/cdx?url=${encodeURIComponent(host)}&from=${ym(from)}&to=${ym(to)}` +
    '&output=json&fl=timestamp,original,digest&collapse=timestamp:6';

  let rows = await cdx(`${base}&filter=statuscode:200&filter=mimetype:text/html`);
  // Some homepages are only captured as redirects (to /en, www., etc.); the archive follows them.
  if (rows.length < 3) rows = await cdx(`${base}&filter=${encodeURIComponent('!statuscode:[45]..')}`);
  return rows.map(([ts, original, digest]) => ({ ts, original, digest }));
}

export function fetchSnapshotHtml(ts, original) {
  return get(`${WB}/web/${ts}id_/${original}`);
}

export function snapshotUrl(ts, original) {
  return `${WB}/web/${ts}/${original}`;
}

// Bot walls and error pages the crawler sometimes saved instead of the homepage.
const BLOCKED_TITLE = /^(just a moment|attention required|access denied|403 forbidden|404|page not found|not found|error|site maintenance|are you a robot)/i;
export function isBlockedPage(data) {
  return BLOCKED_TITLE.test(data.title) || BLOCKED_TITLE.test(data.headline);
}
