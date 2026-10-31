// Word-level diff (LCS). Returns runs of { type: 'same' | 'del' | 'ins', text }.
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function diffWords(oldText, newText) {
  const a = oldText ? oldText.split(' ') : [];
  const b = newText ? newText.split(' ') : [];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += ' ' + text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(a[i]) === norm(b[j])) { push('same', b[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', a[i++]);
    else push('ins', b[j++]);
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('ins', b[j++]);
  return out;
}

// Share of the new text's words carried over from the old text (0..1).
export function keptShare(oldText, newText) {
  const runs = diffWords(oldText, newText);
  const count = (t) => runs.filter((r) => r.type === t).reduce((s, r) => s + r.text.split(' ').length, 0);
  const total = count('same') + count('ins');
  return total ? count('same') / total : 1;
}
