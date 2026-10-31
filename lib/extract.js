// Pulls the hero messaging (headline, subheadline, CTAs, meta) out of a homepage.
// Works on a parsed archive document and on the live tab. It must stay
// self-contained: chrome.scripting.executeScript serialises it into the page.
export function extractMessaging(doc) {
  doc = doc || document;
  const live = !!doc.defaultView;
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/;
  const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|SELECT|OPTION|CANVAS|VIDEO)$/;
  // Saved HTML has no CSS, so responsive duplicates (desktop + mobile headline) both show up.
  // Keep the desktop one by skipping elements whose class marks them mobile-only.
  const MOBILE_ONLY = /(^|[\s_-])((show|visible|only)[-_]?(on[-_])?(mobile|phone|xs)|mobile[-_]?(only|show|visible)|(sm|md|lg):hidden|d-(sm|md|lg)-none|hidden-(md|lg|desktop))($|[\s_-])/i;
  const mobileOnly = (el) => {
    if (live) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (MOBILE_ONLY.test(n.getAttribute('class') || '')) return true;
    }
    return false;
  };
  const clean = (s) => (s || '').replace(/[\s​‌‍﻿]+/g, ' ').trim();

  // textContent glues "<br>" lines together; walk the tree and space out blocks.
  const textOf = (root) => {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toUpperCase();
      if (SKIP_TAGS.test(tag) || n.hidden || n.getAttribute('aria-hidden') === 'true') return;
      if (!live && MOBILE_ONLY.test(n.getAttribute('class') || '')) return;
      const block = BLOCK.test(tag);
      if (block) out += ' ';
      for (const c of n.childNodes) walk(c);
      if (block) out += ' ';
    };
    walk(root);
    return clean(out);
  };

  const hiddenArea = 'nav, footer, dialog, [role="dialog"], [role="navigation"], [aria-modal="true"], [hidden], [aria-hidden="true"]';
  const usable = (el) => !el.closest(hiddenArea) && !mobileOnly(el) && (!live || el.getClientRects().length > 0);
  const meta = (sel) => clean(doc.querySelector(sel)?.getAttribute('content'));

  const title = clean(doc.title);
  const description = meta('meta[name="description" i]');
  const ogTitle = meta('meta[property="og:title"]');
  const ogDescription = meta('meta[property="og:description"]') || meta('meta[name="twitter:description"]');

  const pick = (sel, minWords) => {
    for (const el of doc.querySelectorAll(sel)) {
      if (!usable(el)) continue;
      const t = textOf(el);
      if (t.length < 3 || t.length > 220 || t.split(' ').length < minWords) continue;
      return { el, t };
    }
    return null;
  };

  // Headline: first real h1 (a one-word h1 is usually the logo), then fallbacks.
  const found = pick('h1', 2) || pick('h1', 1) || pick('[role="heading"][aria-level="1"]', 2) || pick('h2', 3);
  let headline = '';
  let source = '';
  if (found) {
    headline = found.t;
    source = found.el.tagName.toLowerCase() === 'h2' ? 'h2' : 'h1';
  } else if (ogTitle) {
    headline = ogTitle;
    source = 'og:title';
  } else if (title) {
    headline = title;
    source = 'title';
  }

  let subheadline = '';
  const ctas = [];
  if (found) {
    const h = found.el;
    const after = (el) => (h.compareDocumentPosition(el) & 4) && !h.contains(el);

    let seen = 0;
    const subSel = 'p, h2, h3, [class*="subtitle" i], [class*="subhead" i], [class*="description" i], [class*="lead" i]';
    for (const el of doc.querySelectorAll(subSel)) {
      if (!after(el) || !usable(el)) continue;
      if (++seen > 12) break;
      const t = textOf(el);
      if (t.length >= 25 && t.length <= 320 && t !== headline) { subheadline = t; break; }
    }

    // Buttons: skip form controls, links inside sentences and legal/utility labels.
    const NOT_CTA = /^(submit|send|close|menu|search|skip|accept|reject|ok|next|previous|prev|privacy|privacy policy|terms|cookies?|cookie settings|log ?in|sign ?in)$/i;
    const ACTION = /^(start|try|buy|join|download|subscribe|book|contact|register|install|watch|explore|discover|shop|order|demo|pricing|learn|apply|continue|get|signup|upgrade|compare)/i;
    seen = 0;
    for (const el of doc.querySelectorAll('a, button')) {
      if (!after(el) || !usable(el) || el.closest('form, p, label')) continue;
      if (++seen > 10) break;
      const t = textOf(el);
      if (t.length < 2 || t.length > 32 || t.split(' ').length > 5 || NOT_CTA.test(t)) continue;
      // One-word buttons are usually tabs or filters ("Code", "Cloud") unless they are an action.
      if (!t.includes(' ') && !ACTION.test(t)) continue;
      if (!ctas.some((c) => c.toLowerCase() === t.toLowerCase())) ctas.push(t);
      if (ctas.length === 3) break;
    }
  }

  // Proof line: the first social-proof claim on the page ("Trusted by 50% of the Fortune 100").
  const PROOF = /\b(trusted by|used by|loved by|chosen by|relied on by|join(ed)? (over|more than)?|fortune \d+|\d[\d,.]*\s*[%+kmb]?\+?\s*(customers|companies|organizations|teams|users|businesses|brands|developers))\b/i;
  let proof = '';
  for (const el of doc.querySelectorAll('h2, h3, h4, p, span, div')) {
    if (el.children.length > 3 || !usable(el)) continue;
    const t = textOf(el);
    if (t.length < 12 || t.length > 140 || !PROOF.test(t)) continue;
    proof = t;
    break;
  }

  // Language of the page; the archive's crawler sometimes saves a regional version.
  const lang = (doc.documentElement.getAttribute('lang') || meta('meta[property="og:locale"]') || '')
    .toLowerCase().split(/[-_]/)[0];

  return { headline, subheadline, ctas, proof, lang, title, description, ogTitle, ogDescription, source };
}
