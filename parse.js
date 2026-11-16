// parse.js — a fast, dependency-free Markdown renderer.
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off, async off).
// Written from the CommonMark 0.31.2 / GFM 0.29 specifications and the
// observable behaviour of marked on its own test cases. No code is copied
// from marked or from any other renderer; the structure below (a line-based
// block walk that builds a small block tree, then a direct-to-HTML render
// with a delimiter-stack inline parser) is original work.

// ---------------------------------------------------------------- helpers

const CHR = (s, i) => (i < s.length ? s.charCodeAt(i) : -1);

// ASCII punctuation: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return UNICODE_PUNCT.test(ch);
}
function isSpaceCh(ch) {
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}
function isWhitespaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}

// --- HTML escaping -------------------------------------------------------
// Text escaping (marked's rule): & is left alone when it starts something
// that looks like a named entity reference (&word;), otherwise it becomes
// &amp;. Numeric character references are decoded first (see below).
const ESCAPE_RE = /[<>"']|&(?!(\w+;))/g;
const ESCAPE_ATTR_RE = /[<>"']|&(?!#?(\w+;))/g;
const ESCAPE_PLAIN_RE = /[&<>"']/g;
const NEEDS_ESC = /[&<>"']/;
function escRepl(m) {
  switch (m) {
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    case '&': return '&amp;';
    default: return m;
  }
}
// Escape plain text that holds no entity references to decode (code spans,
// fenced/indented code, autolink hrefs/text): every & becomes &amp;, no
// decoding, no preservation.
function escapePlain(s) {
  return NEEDS_ESC.test(s) ? s.replace(ESCAPE_PLAIN_RE, escRepl) : s;
}

// Numeric character references: &#123; (1-7 decimal digits) and
// &#x1F600; (1-6 hex digits). Out of range, surrogate, or 0 -> U+FFFD.
const NUMREF_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g;
function decodeNumRef(m, dec, hex) {
  let cp;
  if (dec !== undefined) cp = parseInt(dec, 10);
  else cp = parseInt(hex, 16);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(cp);
}
// Escape inline text: decode numeric references, then escape, preserving
// named-entity-looking sequences (&word;) verbatim.
function escapeText(s) {
  if (s.indexOf('&#') !== -1) s = s.replace(NUMREF_RE, decodeNumRef);
  return NEEDS_ESC.test(s) ? s.replace(ESCAPE_RE, escRepl) : s;
}

// --- URLs ----------------------------------------------------------------
// marked's cleanUrl: encodeURI, then put back any %25 (a literal % in the
// source stays a literal %). encodeURI throws on lone surrogates.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}
// Attribute escaping for href/title/alt: like escapeText but without
// numeric decoding (an entity in a URL or title stays as written, so &#35;
// is preserved here while it is decoded in text).
function escapeAttr(s) {
  return NEEDS_ESC.test(s) ? s.replace(ESCAPE_ATTR_RE, escRepl) : s;
}
// Unescape backslash escapes in a link destination or title: a backslash
// before an ASCII punctuation character drops the backslash.
function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      i++;
      out += s[i];
    } else {
      out += s[i];
    }
  }
  return out;
}

// --- link labels ---------------------------------------------------------
// Normalise a link label for reference lookup: collapse all whitespace
// runs (spaces, tabs, newlines) to one space, trim, lowercase.
function normalizeLabel(label) {
  let out = '';
  let inWs = true; // trims leading whitespace
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (isSpaceCh(ch)) {
      if (!inWs) { out += ' '; inWs = true; }
    } else {
      out += ch.toLowerCase();
      inWs = false;
    }
  }
  if (out.endsWith(' ')) out = out.slice(0, -1);
  // Unicode case folding: ß/ẞ fold to "ss" (toLowerCase gives ß for ẞ),
  // and the Latin ligatures fold to their expansions.
  return out.replace(/\u00df/g, 'ss')
    .replace(/\ufb00/g, 'ff').replace(/\ufb01/g, 'fi').replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi').replace(/\ufb04/g, 'ffl')
    .replace(/\ufb05/g, 'st').replace(/\ufb06/g, 'st');
}

// ---------------------------------------------------------------- inline
// Node types in a `parts` array (one inline sequence: a paragraph, a
// heading, a link label, a table cell):
//  {t:0, a, b}  raw text, a slice of the sequence's source string
//  {t:1, c, n, open, close}  emphasis delimiter run (*, _, or ~)
//  {t:2, h}  pre-rendered raw HTML (an inline HTML tag)
//  {t:3}  hard break <br>
//  {t:4, href, title, img, kids, labelSrc, nullHref}  link or image
//  {t:5, tag, kids}  em / strong / del (made by delimiter processing)
//  {t:6, s}  code span, raw inner text
//  {t:7, href, text}  autolink (bare or <...>)
function isLocalCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 43 || c === 45;
}
function isWordCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isDomainCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 45 || c === 95 || c === 46;
}
function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// A domain-label char (no dot): alphanumerics, '-' and '_'.
function isDomainLabelCharCode(c) {
  return isAlnumCode(c) || c === 45 || c === 95;
}
// RFC 5322 atext (the <...> autolink local part).
function isAtextCharCode(c) {
  return isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
    c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
    c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 ||
    c === 45;
}

// --- GFM autolink backpedal --------------------------------------------
// A direct port of marked's _backpedal regex:
// /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/
// applied repeatedly until the string stops changing. It keeps the longest
// prefix made of "good" segments: plain runs, balanced ( ... ) groups, an
// & that does not start a trailing entity, and punctuation runs that do
// not reach the end of the string.
function isBackpedalPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
}
function isBackpedalPlain(c) {
  return c !== 63 && c !== 33 && c !== 46 && c !== 44 && c !== 58 && c !== 59 &&
    c !== 42 && c !== 95 && c !== 39 && c !== 34 && c !== 126 && c !== 40 &&
    c !== 41 && c !== 38;
}
function backpedalOnce(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 40) { // '(' : \([^)]*\)
      let j = i + 1;
      while (j < n && s.charCodeAt(j) !== 41) j++;
      if (j < n) { i = j + 1; continue; }
      break;
    }
    if (c === 38) { // '&' : &(?![a-zA-Z0-9]+;$)
      let j = i + 1;
      while (j < n && isAlnumCode(s.charCodeAt(j))) j++;
      if (j > i + 1 && j < n && s.charCodeAt(j) === 59 && j + 1 === n) break;
      i++;
      continue;
    }
    if (isBackpedalPunct(c)) {
      let j = i;
      while (j < n && isBackpedalPunct(s.charCodeAt(j))) j++;
      if (j === n) break;
      i = j;
      continue;
    }
    while (i < n && isBackpedalPlain(s.charCodeAt(i))) i++;
  }
  return s.slice(0, i);
}
function backpedalUrl(s) {
  let cur = s;
  for (;;) {
    const t = backpedalOnce(cur);
    if (t.length === cur.length) return cur;
    cur = t;
  }
}

// A bare scheme URL (http/https/ftp) or www URL starting at i in src.
// Returns {end, href, text} (end is the index just past the URL) or null.
// Mirrors marked's url rule: the scheme/www part, then a domain part
// (?:[a-zA-Z0-9\-]+\.?)+ (so the first domain char must be alphanumeric
// or '-'), then any run of non-space, non-'<' chars, trimmed by backpedal.
function scanBareUrl(src, i, kind) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60 || c < 32) break;
    if (isSpaceCh(src[j])) break;
    j++;
  }
  const cand = backpedalUrl(src.slice(i, j));
  if (cand.length === 0) return null;
  let href;
  if (kind === 'www') {
    if (cand.length <= 4) return null;
    const first = cand.charCodeAt(4);
    if (!isAlnumCode(first) && first !== 45) return null;
    href = cleanUrl('http://' + cand);
  } else {
    const schemeEnd = cand.indexOf('://');
    if (schemeEnd === -1) return null;
    const after = schemeEnd + 3;
    if (after >= cand.length) return null;
    const first = cand.charCodeAt(after);
    if (!isAlnumCode(first) && first !== 45) return null;
    href = cleanUrl(cand);
  }
  if (href === null) return null;
  return { end: i + cand.length, href: escapePlain(href), text: cand };
}

// Whether the delimiter parts in `parts` leave an unmatched opener of
// char `ch` (* or _): a simplified simulation of the delimiter stack —
// open-only delimiters push, close-only ones pop a matching opener, and
// a both-ways delimiter closes when one is open, else opens. Used to
// decide whether a run after a bare email is an emphasis closer.
function hasOpenDelim(parts, ch) {
  const stack = [];
  for (const p of parts) {
    if (p.t !== 1 || p.c !== ch) continue;
    if (p.open && !p.close) stack.push(p.n);
    else if (p.close && !p.open) {
      if (stack.length > 0) stack.pop();
    } else if (p.open && p.close) {
      if (stack.length > 0) stack.pop();
      else stack.push(p.n);
    }
  }
  return stack.length > 0;
}

// A bare email starting at localStart in src. Returns the index just past
// the email, or -1. Matches marked's bare-email regex:
// /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/
// implemented as label walking: the domain is dot-separated labels; the
// match is the longest prefix of >= 2 labels whose last label ends with
// an alphanumeric. A label with no alphanumeric, or with trailing -/_
// after its last alphanumeric, stops the walk (the regex cannot get past
// it, so an earlier prefix is the match, if any).
// hasOpen, when given, is (ch) => whether an unmatched emphasis opener
// of that char exists before the email: marked matches emphasis first
// and lexes the email on the inner text, so a label ending right before
// a closing __/_/** /* still links in full, while the same run with no
// opener is literal text and the regex backtracks.
function scanEmail(src, localStart, hasOpen) {
  const n = src.length;
  let i = localStart;
  const ls = i;
  while (i < n && isLocalCharCode(src.charCodeAt(i))) i++;
  if (i === ls || src.charCodeAt(i) !== 64) return -1;
  i++; // past '@'
  const d0 = i;
  while (i < n && isDomainLabelCharCode(src.charCodeAt(i))) i++;
  if (i === d0) return -1;
  let best = -1;
  while (i < n && src.charCodeAt(i) === 46) {
    let j = i + 1;
    const lstart = j;
    while (j < n && isDomainLabelCharCode(src.charCodeAt(j))) j++;
    if (j === lstart) break;
    let lastAlnum = -1;
    for (let k = lstart; k < j; k++) {
      if (isAlnumCode(src.charCodeAt(k))) lastAlnum = k;
    }
    if (lastAlnum === -1) break;
    if (lastAlnum === j - 1) {
      best = j;
      i = j;
    } else {
      // the label ends with -/_ after its last alphanumeric: the regex
      // backtracks, unless the trailing run is an emphasis closer for
      // an opener before the email (then the email ends at the label)
      let c = src.charCodeAt(lastAlnum + 1);
      if ((c === 95 || c === 42) && hasOpen) {
        let k = lastAlnum + 1;
        while (k < j && src.charCodeAt(k) === c) k++;
        if (k === j && hasOpen(c === 95 ? '_' : '*')) {
          best = lastAlnum + 1;
        }
      }
      break;
    }
  }
  return best;
}

// The <...> autolink email: an RFC-atext local part and domain labels of
// 1-63 chars of [A-Za-z0-9-], each starting and ending with an
// alphanumeric, with at least two labels. Returns true iff the whole
// string is such an email.
function scanAngleEmail(s) {
  const n = s.length;
  let i = 0;
  const ls = i;
  while (i < n && isAtextCharCode(s.charCodeAt(i))) i++;
  if (i === ls || s.charCodeAt(i) !== 64) return false;
  i++;
  let labels = 0;
  for (;;) {
    const lstart = i;
    while (i < n && (isAlnumCode(s.charCodeAt(i)) || s.charCodeAt(i) === 45)) i++;
    const len = i - lstart;
    if (len === 0 || len > 63) return false;
    if (!isAlnumCode(s.charCodeAt(lstart)) || !isAlnumCode(s.charCodeAt(i - 1))) return false;
    labels++;
    if (i >= n) break;
    if (s.charCodeAt(i) !== 46) return false;
    i++;
  }
  return labels >= 2;
}

// --- code spans ----------------------------------------------------------
function findCodeSpanClose(src, from, n) {
  // find a run of exactly n backticks at or after `from`; return its index
  for (let j = from; j < src.length; j++) {
    if (src.charCodeAt(j) !== 96) continue;
    let k = j;
    while (k < src.length && src.charCodeAt(k) === 96) k++;
    if (k - j === n) return j;
    j = k - 1;
  }
  return -1;
}

// --- inline HTML tags and <...> autolinks --------------------------------
// Scan an HTML tag starting at src[i] === '<'. Returns the index just past
// the tag, or -1. Handles comments, processing instructions,
// declarations, CDATA, and open/close tags (with quoted attribute values
// that may hold '>').
function scanTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    // <!--> and <!---> are complete (abruptly closed) comments
    if (src.charCodeAt(i + 4) === 62) return i + 5;
    if (src.charCodeAt(i + 4) === 45 && src.charCodeAt(i + 5) === 62) return i + 6;
    const e = src.indexOf('-->', i + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (src.startsWith('<?', i)) {
    const e = src.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const e = src.indexOf(']]>', i + 9);
    return e === -1 ? -1 : e + 3;
  }
  if (src.startsWith('<!', i)) {
    // declaration: <! + letters + whitespace + ... up to '>'
    let j = i + 2;
    if (j >= n || !((src.charCodeAt(j) >= 65 && src.charCodeAt(j) <= 90) ||
      (src.charCodeAt(j) >= 97 && src.charCodeAt(j) <= 122))) return -1;
    while (j < n && ((src.charCodeAt(j) >= 65 && src.charCodeAt(j) <= 90) ||
      (src.charCodeAt(j) >= 97 && src.charCodeAt(j) <= 122))) j++;
    if (j >= n || !isWhitespaceCode(src.charCodeAt(j))) return -1;
    const e = src.indexOf('>', j);
    return e === -1 ? -1 : e + 1;
  }
  // open or close tag
  let j = i + 1;
  let closing = false;
  if (src.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n) return -1;
  const c0 = src.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  j++;
  while (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (closing) {
    while (j < n && isWhitespaceCode(src.charCodeAt(j))) j++;
    return (j < n && src.charCodeAt(j) === 62) ? j + 1 : -1;
  }
  // attributes: each one must be preceded by whitespace
  for (;;) {
    let ws = 0;
    while (j < n && isWhitespaceCode(src.charCodeAt(j))) { j++; ws++; }
    if (j >= n) return -1;
    const c = src.charCodeAt(j);
    if (c === 62) return j + 1;
    if (c === 47 && src.charCodeAt(j + 1) === 62) return j + 2;
    if (ws === 0) return -1;
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return -1;
    j++;
    while (j < n) {
      const d = src.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) ||
        d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // Only consume the whitespace if an '=' follows; a valueless
    // attribute must leave it so the next loop sees ws > 0.
    let k = j;
    while (k < n && isWhitespaceCode(src.charCodeAt(k))) k++;
    if (k < n && src.charCodeAt(k) === 61) {
      j = k + 1;
      while (j < n && isWhitespaceCode(src.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = src.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        const e = src.indexOf(String.fromCharCode(q), j);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        if (isWhitespaceCode(q) || q === 34 || q === 39 || q === 61 || q === 60 || q === 62 || q === 96) return -1;
        while (j < n) {
          const d = src.charCodeAt(j);
          if (isWhitespaceCode(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          j++;
        }
      }
    }
  }
}

// An <...> autolink at src[i] === '<'. Returns {end, href, text} or null.
function scanAngleAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  // scheme: letter, then 1-31 letters/digits/+/-/. , then ':'
  if (j >= n) return null;
  const c0 = src.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  let k = j + 1;
  while (k < n) {
    const c = src.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 43 || c === 45 || c === 46) k++;
    else break;
  }
  if (k - j >= 2 && k - j <= 32 && k < n && src.charCodeAt(k) === 58) {
    // scheme autolink: content up to '>', no space, '<', '>' or control
    let e = k + 1;
    while (e < n) {
      const c = src.charCodeAt(e);
      if (c === 62) {
        const url = src.slice(i + 1, e);
        const href = cleanUrl(url);
        if (href === null) return null;
        return { end: e + 1, href: escapePlain(href), text: url };
      }
      if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) return null;
      e++;
    }
    return null;
  }
  // email autolink: <local@domain>
  const gt = src.indexOf('>', j);
  if (gt === -1) return null;
  const inner = src.slice(j, gt);
  if (scanAngleEmail(inner)) {
    return { end: gt + 1, href: 'mailto:' + escapePlain(inner), text: inner };
  }
  return null;
}

// --- link labels and destinations ----------------------------------------
function findLabelEnd(src, i) {
  // src[i] === '['; index of the matching ']' or -1
  let depth = 1;
  for (let j = i + 1; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (c === 92) { j++; continue; }
    if (c === 96) {
      let n = 0;
      while (j + n < src.length && src.charCodeAt(j + n) === 96) n++;
      // In a label, a backtick run opens a code span only if a closing
      // run (any length — marked's label code-span alternative allows
      // different run lengths) follows after content with no backticks;
      // the content may contain ']' (it is not a label end). A run of
      // TWO OR MORE backticks immediately before the closing ']' is the
      // trailing run (the ``+(?=]) alternative — it is ``+, not `+)
      // and is checked first: marked's lazy label prefers that shorter
      // reading over a code span whose closer is far away. A single
      // backtick before ']' is NOT a trailing run, so it opens a code
      // span (and the label is invalid if no closing run follows).
      if (n >= 2 && j + n < src.length && src.charCodeAt(j + n) === 93) {
        j += n - 1;
        continue;
      }
      let k = j + n;
      while (k < src.length && src.charCodeAt(k) !== 96) k++;
      if (k < src.length) {
        let m = 0;
        while (k + m < src.length && src.charCodeAt(k + m) === 96) m++;
        j = k + m - 1;
        continue;
      }
      return -1;
    }
    if (c === 60) {
      // skip an autolink or HTML tag; a `]` inside it is not a label end
      const auto = scanAngleAutolink(src, j);
      if (auto) { j = auto.end - 1; continue; }
      const tagEnd = scanTag(src, j);
      if (tagEnd !== -1) { j = tagEnd - 1; continue; }
    }
    if (c === 91) depth++;
    else if (c === 93) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// Parse an inline link's (destination title?) at src[p] === '('.
// Returns {end, dest, title} with dest/title raw (escapes intact) or null.
function parseInlineDest(src, p) {
  const n = src.length;
  let i = p + 1;
  while (i < n && isWhitespaceCode(src.charCodeAt(i))) i++;
  if (i >= n) return null;
  let dest = null;
  let next = -1;
  if (src.charCodeAt(i) === 60) {
    let j = i + 1;
    let raw = '';
    let ok = false;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 10 || c === 60) break;
      if (c < 32 && c !== 9) break;
      if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { raw += src[j] + src[j + 1]; j += 2; continue; }
      if (c === 62) { ok = true; break; }
      raw += src[j];
      j++;
    }
    if (!ok) return null;
    dest = raw;
    next = j + 1;
  } else {
    let depth = 0;
    let j = i;
    let raw = '';
    let ok = false;
    let hitWs = false;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n && isAsciiPunct(src.charCodeAt(j + 1))) { raw += src[j] + src[j + 1]; j += 2; continue; }
      if (c === 32 || c === 9 || c === 10) { hitWs = true; break; }
      if (c === 40) { depth++; raw += src[j]; j++; continue; }
      if (c === 41) {
        if (depth === 0) { ok = true; break; }
        depth--;
        raw += src[j];
        j++;
        continue;
      }
      if (c < 32) return null;
      raw += src[j];
      j++;
    }
    if (!ok && !hitWs) return null;
    dest = raw;
    next = j;
  }
  let k = next;
  while (k < n && isWhitespaceCode(src.charCodeAt(k))) k++;
  if (k < n && src.charCodeAt(k) === 41) {
    return { end: k + 1, dest, title: null };
  }
  if (k >= n) return null;
  const ch = src.charCodeAt(k);
  if (ch === 34 || ch === 39 || ch === 40) {
    const closeCh = ch === 40 ? 41 : ch;
    let t = k + 1;
    let rawT = '';
    let okT = false;
    while (t < n) {
      const c = src.charCodeAt(t);
      if (c === 92 && t + 1 < n && isAsciiPunct(src.charCodeAt(t + 1))) { rawT += src[t] + src[t + 1]; t += 2; continue; }
      if (c === closeCh) { okT = true; break; }
      rawT += src[t];
      t++;
    }
    if (!okT) return null;
    let m = t + 1;
    while (m < n && isWhitespaceCode(src.charCodeAt(m))) m++;
    if (m < n && src.charCodeAt(m) === 41) {
      return { end: m + 1, dest, title: rawT };
    }
    return null;
  }
  return null;
}

// Try to parse a link or image starting at src[i] === '['.
// Returns {end, href, title, labelA, labelB} or null. href is the cleaned
// URL or null when cleanUrl refuses it (lone surrogate): such a link still
// consumes its text but renders without an <a>/<img> tag.
function parseLinkAt(src, i, defs) {
  const le = findLabelEnd(src, i);
  if (le === -1) return null;
  const label = src.slice(i + 1, le);
  const after = le + 1;
  // An empty label only forms a link with an inline destination.
  if (label.length === 0 && src.charCodeAt(after) !== 40) return null;
  if (src.charCodeAt(after) === 40) {
    const r = parseInlineDest(src, after);
    if (r) {
      return {
        end: r.end,
        href: cleanUrl(unescapeBackslashes(r.dest)),
        title: r.title === null ? null : unescapeBackslashes(r.title),
        labelA: i + 1,
        labelB: le,
      };
    }
    // Not a valid inline destination: fall through to a shortcut
    // reference (e.g. [foo](not a link) with [foo]: /url1).
  }
  if (src.charCodeAt(after) === 91) {
    const le2 = findLabelEnd(src, after);
    if (le2 !== -1) {
      const label2 = src.slice(after + 1, le2);
      const key = label2.length === 0 ? normalizeLabel(label) : normalizeLabel(label2);
      const def = defs.get(key);
      if (def) {
        return {
          end: le2 + 1,
          href: cleanUrl(unescapeBackslashes(def.dest)),
          title: def.title === null ? null : unescapeBackslashes(def.title),
          labelA: i + 1,
          labelB: le,
        };
      }
      return null; // closed second label, unknown: no shortcut fallback
    }
    // unclosed second label: fall through to the shortcut reference
  }
  const def = defs.get(normalizeLabel(label));
  if (def) {
    return {
      end: le + 1,
      href: cleanUrl(unescapeBackslashes(def.dest)),
      title: def.title === null ? null : unescapeBackslashes(def.title),
      labelA: i + 1,
      labelB: le,
    };
  }
  return null;
}

// --- marked's emStrong (regex emphasis) ---------------------------------
// The delimiter-stack in processDelimiters does not reproduce marked's
// regex-based emStrong: marked scans forward from an opening run with an
// accumulator (m = delimiters still owed, f = delimiters skipped by the
// rule of 3, y = the opening run's offset) and a mask boundary (the last
// delimiter run not preceded by whitespace). The stack matches the outer
// delimiter in cases where marked leaves it literal (e.g. `*a **b**c*`,
// `*public as *so*other* option html*`, `_x <code>..</code>_`), so
// `*`/`_` emphasis is done here, with marked's GFM delimiter regexes
// and its forward scan, ported faithfully. `~` (strikethrough) stays in
// the delimiter stack.
const EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const EM_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const EM_ALNUM = /[\p{L}\p{N}]/u;

// True if src[a..b) contains a '[' or ']' outside a code span. Used by
// the mask: marked's link mask only covers labels without nested
// brackets (a bracket inside a code span does not count).
function labelHasBrackets(src, a, b) {
  let i = a;
  while (i < b) {
    const c = src.charCodeAt(i);
    if (c === 96) {
      let m = 0;
      while (i + m < b && src.charCodeAt(i + m) === 96) m++;
      const close = findCodeSpanClose(src, i + m, m);
      if (close !== -1 && close + m <= b) { i = close + m; continue; }
      i += m;
      continue;
    }
    if (c === 91 || c === 93) return true;
    i++;
  }
  return false;
}

// Masked copy of an inline source for emStrong: `*`/`_`/`~` runs inside
// code spans, link labels/destinations, raw HTML tags/autolinks, and
// after a backslash are replaced (length preserved) so the forward scan
// never uses them as closers — marked's #n mask. The mask is only used
// for the emStrong scan/boundary; rendering always uses the original.
//
// Two passes, like marked: pass 1 masks code spans, escapes, `~` and
// HTML; pass 2 masks links on the pass-1 result, so a code span inside
// a label (whose inner backtick would otherwise break the label scan)
// no longer blocks the link from being masked.
function maskInlineSrc(src, defs) {
  const n = src.length;
  const out = src.split('');
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 126) { // ~ : strikethrough delimiters are parsed by
      // processDelimiters, not by emStrong; marked parses a del's
      // inner text recursively, so the ~~ is not in emStrong's source
      // at all. Mask it as punctuation so a `*`/`_` run next to it is
      // grouped as a closer, not as an opener (the GFM regex counts
      // `~` as not-punctuation, which would make `**~~` an opener).
      out[i] = '+';
      i++;
      continue;
    }
    if (c === 92) { // backslash + punct: hide both (the punct after it
      // is an escaped literal, not a delimiter)
      const d = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      if (d !== -1 && isAsciiPunct(d)) { out[i] = '+'; out[i + 1] = '+'; i += 2; continue; }
      i++;
      continue;
    }
    if (c === 96) { // code span: hide the whole span incl. backticks
      let m = 0;
      while (i + m < n && src.charCodeAt(i + m) === 96) m++;
      const close = findCodeSpanClose(src, i + m, m);
      if (close !== -1) {
        for (let j = i; j < close + m; j++) out[j] = '+';
        i = close + m;
        continue;
      }
      i += m;
      continue;
    }
    if (c === 60) { // < : raw HTML tag or autolink — hide up to the
      // next '>' if there is no '<' or space right after '<' first
      if (i + 1 < n && src.charCodeAt(i + 1) !== 32) {
        let j = i + 1;
        while (j < n && src.charCodeAt(j) !== 62 && src.charCodeAt(j) !== 60) j++;
        if (j < n && src.charCodeAt(j) === 62) {
          for (let k = i + 1; k < j; k++) out[k] = 'a';
          i = j + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  // Pass 2: mask links. parseLinkAt runs on the pass-1 result, where
  // code spans are already '+'s, so a label containing a code span
  // parses here even though the raw label would not.
  const tmp = out.join('');
  i = 0;
  while (i < n) {
    const c = tmp.charCodeAt(i);
    if (c === 91 || (c === 33 && tmp.charCodeAt(i + 1) === 91)) { // [ or ![
      const at = c === 33 ? i + 1 : i;
      const link = parseLinkAt(tmp, at, defs);
      if (link && !labelHasBrackets(tmp, link.labelA, link.labelB)) {
        // hide the label content and the destination/title part; keep
        // the brackets/parens (they are not delimiters). A label with
        // nested brackets is NOT masked: marked's mask only covers
        // simple labels, so emphasis can still form across a nested
        // link (e.g. `*[bar [baz](/uri)](/uri)*`).
        for (let j = link.labelA; j < link.labelB; j++) out[j] = 'a';
        for (let j = link.labelB + 1; j < link.end; j++) {
          const ch = tmp.charCodeAt(j);
          if (ch !== 91 && ch !== 93 && ch !== 40 && ch !== 41) out[j] = 'a';
        }
        i = link.end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

// Last `*`/`_` run not preceded by whitespace, per delimiter char:
// the forward scan never looks past it (marked's `fe` mask).
function emStrongMask(src) {
  const idx = { '*': -1, '_': -1 };
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const r = src[s];
    if (r !== '*' && r !== '_') continue;
    const o = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    while (i < n && src[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') idx[r] = s;
    s = i - 1;
  }
  return idx;
}

// Try marked's emStrong at the `*`/`_` run starting at position i in the
// full inline source src. masked is maskInlineSrc(src) (same length);
// prevChar is src[i-1] ('' at the start); maskIdx is
// emStrongMask(masked). Returns {raw, tag, text} or null. `text` is the
// inner text with the delimiters stripped (1 char each side for em,
// 2 for strong); the caller parses it recursively.
function tryEmStrong(src, masked, i, prevChar, maskIdx) {
  const e = src.slice(i);
  const t = masked;
  const s = EM_LDELIM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prevChar === r;
  const ii = t.length - e.length;
  let l = ii;
  while (l > 0 && t[l - 1] === r) l--;
  const p = [...t.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || EM_PUNCT.test(p);
  let n = prevChar;
  if (l < ii) n = p;
  const u = l < ii ? h : EM_PUNCT.test(n);
  if (s[4] && EM_ALNUM.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = ii - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
    const v = maskIdx[r];
    const Q = t.length - e.length + k;
    if (v < Q) return null;
    const tt = t.slice(-e.length + k);
    const ee = v - Q;
    A.lastIndex = 0;
    let s2;
    while ((s2 = A.exec(tt)) !== null && !(s2.index > ee)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      const b = [...g].length;
      if (s2[3] || s2[4]) { m += b; continue; }
      else if (s2[5] || s2[6] || R) {
        if (o && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const bb = Math.min(b, b + m + f);
      const te = [...s2[0]][0].length;
      const M = e.slice(0, k + s2.index + te + bb);
      if (Math.min(k, bb) % 2) return { raw: M, tag: 'em', text: M.slice(1, -1) };
      return { raw: M, tag: 'strong', text: M.slice(2, -2) };
    }
  }
  return null;
}

// --- the inline scan ------------------------------------------------------
// Document-level inLink state: marked keeps inLink on the Lexer, so an
// unclosed raw <a ...> tag in one block suppresses bare URLs in all
// later blocks until a </a>. `parse` resets it per document; `inline`
// threads it through scanInline.
let docInLink = false;

function scanInline(src, defs, inLinkStart) {
  const parts = [];
  const n = src.length;
  let i = 0;
  let runStart = -1;
  // Lazily computed emStrong mask for this source (shared by all
  // tryEmStrong calls in this scan): the masked source and the last
  // possible closer index per delimiter char.
  let emMasked = null;
  let emMaskIdx = null;
  // Bare URLs/emails are suppressed while inside a link (a label, or a
  // raw <a ...> tag); <...> autolinks are not.
  let inLink = inLinkStart === true;
  function flushText(end) {
    if (runStart !== -1 && end > runStart) parts.push({ t: 0, a: runStart, b: end });
    runStart = -1;
  }
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      const d = src.charCodeAt(i + 1);
      if (d === 10) {
        flushText(i);
        parts.push({ t: 3 });
        i += 2;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (d !== -1 && isAsciiPunct(d)) {
        flushText(i);
        parts.push({ t: 0, a: i + 1, b: i + 2 });
        i += 2;
        continue;
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 96) { // code span
      let m = 0;
      while (i + m < n && src.charCodeAt(i + m) === 96) m++;
      const close = findCodeSpanClose(src, i + m, m);
      if (close !== -1) {
        let content = src.slice(i + m, close).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText(i);
        parts.push({ t: 6, s: content });
        i = close + m;
        continue;
      }
      if (runStart === -1) runStart = i;
      i += m;
      continue;
    }
    if (c === 42 || c === 95) { // * _ : emphasis via marked's emStrong
      // (the forward scan); a run it rejects is literal text, not a
      // delimiter — the stack must never match it later.
      if (emMasked === null) {
        emMasked = maskInlineSrc(src, defs);
        emMaskIdx = emStrongMask(emMasked);
      }
      const prevChar = i === 0 ? '' : src[i - 1];
      const em = tryEmStrong(src, emMasked, i, prevChar, emMaskIdx);
      if (em) {
        flushText(i);
        const innerRes = scanInline(em.text, defs, inLink);
        inLink = innerRes.inLink;
        const kids = innerRes.parts;
        processDelimiters(kids);
        parts.push({ t: 5, tag: em.tag, kids, src: em.text });
        i += em.raw.length;
        continue;
      }
      // emStrong rejected this run: marked consumes one delimiter as
      // text and retries emStrong at the next delimiter in the run
      // (so `**foo*` yields `*<em>foo</em>`), so advance by one char.
      if (runStart === -1) runStart = i;
      i += 1;
      continue;
    }
    if (c === 126) { // ~ : runs of 1-2 are strikethrough delimiters (like
      // *); runs of 3+ are literal text
      let m = 0;
      while (i + m < n && src.charCodeAt(i + m) === 126) m++;
      if (m >= 3) {
        if (runStart === -1) runStart = i;
        i += m;
        continue;
      }
      const prev = i === 0 ? '' : src[i - 1];
      const next = i + m >= n ? '' : src[i + m];
      const prevWs = prev === '' || isSpaceCh(prev);
      const nextWs = next === '' || isSpaceCh(next);
      const prevPunct = prev !== '' && isPunctCh(prev);
      const nextPunct = next !== '' && isPunctCh(next);
      const leftFlanking = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlanking = !prevWs && (!prevPunct || nextWs || nextPunct);
      flushText(i);
      parts.push({ t: 1, c: '~', n: m, open: leftFlanking, close: rightFlanking });
      i += m;
      continue;
    }
    if (c === 91 || (c === 33 && src.charCodeAt(i + 1) === 91)) { // [ or ![
      const isImage = c === 33;
      const at = isImage ? i + 1 : i;
      const link = parseLinkAt(src, at, defs);
      if (link) {
        const labelSrc = src.slice(link.labelA, link.labelB);
        const labelParts = scanInline(labelSrc, defs, true).parts;
        processDelimiters(labelParts);
        let blocked = false;
        if (!isImage) {
          // a link (not an image) anywhere inside the label — even
          // nested in emphasis — kills the outer link
          const stack = labelParts.slice();
          for (let k = 0; k < stack.length; k++) {
            const p = stack[k];
            if (p.t === 4 && !p.img) { blocked = true; break; }
            if (p.t === 5) for (const kd of p.kids) stack.push(kd);
          }
        }
        if (!blocked) {
          flushText(i);
          const title = link.title === null || link.title === '' ? null : escapeAttr(link.title);
          const href = link.href === null ? null : escapeAttr(link.href);
          const alt = isImage ? plainText(labelParts, labelSrc) : null;
          parts.push({ t: 4, href, title, img: isImage, kids: labelParts, labelSrc, alt });
          i = link.end;
          continue;
        }
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 60) { // <
      const auto = scanAngleAutolink(src, i);
      if (auto) {
        flushText(i);
        parts.push({ t: 7, href: auto.href, text: auto.text });
        i = auto.end;
        continue;
      }
      const tagEnd = scanTag(src, i);
      if (tagEnd !== -1) {
        flushText(i);
        const h = src.slice(i, tagEnd);
        parts.push({ t: 2, h });
        // a raw <a ...> tag (a space after the 'a') suppresses bare URLs
        // until </a>; </a> (exactly) re-enables them
        if (!inLink && h.length >= 3 && (h.charCodeAt(1) === 97 || h.charCodeAt(1) === 65) &&
          h.charCodeAt(2) === 32) inLink = true;
        else if (inLink && (h === '</a>' || h === '</A>')) inLink = false;
        i = tagEnd;
        continue;
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 104 || c === 72) { // h/H: http:// https://
      let isScheme = false;
      const c1 = src.charCodeAt(i + 1) | 32;
      const c2 = src.charCodeAt(i + 2) | 32;
      const c3 = src.charCodeAt(i + 3) | 32;
      if (c1 === 116 && c2 === 116 && c3 === 112) {
        const c4 = src.charCodeAt(i + 4) | 32;
        if (c4 === 115 && src.charCodeAt(i + 5) === 58 && src.charCodeAt(i + 6) === 47 && src.charCodeAt(i + 7) === 47) isScheme = true;
        else if (c4 === 58 && src.charCodeAt(i + 5) === 47 && src.charCodeAt(i + 6) === 47) isScheme = true;
      }
      if (!inLink && isScheme) {
        const r = scanBareUrl(src, i, 'scheme');
        if (r) {
          flushText(i);
          parts.push({ t: 7, href: r.href, text: r.text });
          i = r.end;
          continue;
        }
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 102 || c === 70) { // f/F: ftp://
      if (!inLink && (src.charCodeAt(i + 1) | 32) === 116 && (src.charCodeAt(i + 2) | 32) === 112 &&
        src.charCodeAt(i + 3) === 58 && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47) {
        const r = scanBareUrl(src, i, 'scheme');
        if (r) {
          flushText(i);
          parts.push({ t: 7, href: r.href, text: r.text });
          i = r.end;
          continue;
        }
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 119) { // w: www.
      if (!inLink && src.charCodeAt(i + 1) === 119 && src.charCodeAt(i + 2) === 119 && src.charCodeAt(i + 3) === 46) {
        const prev = i === 0 ? '' : src[i - 1];
        if (runStart === -1 || prev === '' || prev === ' ' || prev === '\t' || prev === '\n' ||
          prev === '(' || prev === '*' || prev === '_' || prev === '~') {
          const r = scanBareUrl(src, i, 'www');
          if (r) {
            flushText(i);
            parts.push({ t: 7, href: r.href, text: r.text });
            i = r.end;
            continue;
          }
        }
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 109 || c === 120) { // m: mailto:  x: xmpp:
      const isMailto = c === 109;
      const proto = isMailto ? 'mailto:' : 'xmpp:';
      // the protocol must not be preceded by an alphanumeric
      const prev = i === 0 ? '' : src[i - 1];
      if (!inLink && src.startsWith(proto, i) && (runStart === -1 || prev === '' || !isAlnumCode(prev.charCodeAt(0)))) {
        const end = scanEmail(src, i + proto.length);
        if (end !== -1) {
          let linkEnd = end;
          let text = src.slice(i, end);
          if (!isMailto && src.charCodeAt(end) === 47) {
            // xmpp: optional /[A-Za-z0-9@.]+ resource
            let r = end + 1;
            while (r < n && (isAlnumCode(src.charCodeAt(r)) || src.charCodeAt(r) === 64 || src.charCodeAt(r) === 46)) r++;
            if (r > end + 1) { linkEnd = r; text = src.slice(i, r); }
          }
          flushText(i);
          parts.push({ t: 7, href: escapePlain(text), text });
          i = linkEnd;
          continue;
        }
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 64) { // @: bare email
      let s = i - 1;
      const lo = runStart === -1 ? i : runStart;
      while (s >= lo && isLocalCharCode(src.charCodeAt(s))) s--;
      s++;
      if (!inLink && s < i) {
        const end = scanEmail(src, s, (ch) => hasOpenDelim(parts, ch));
        if (end !== -1) {
          flushText(s);
          const email = src.slice(s, end);
          parts.push({ t: 7, href: 'mailto:' + escapePlain(email), text: email });
          i = end;
          continue;
        }
      }
      if (runStart === -1) runStart = i;
      i++;
      continue;
    }
    if (c === 32 || c === 9) { // spaces/tabs: maybe a hard break
      let j = i;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
      if (src.charCodeAt(j) === 10) {
        let cnt = 0;
        let s = j - 1;
        while (s >= i && src.charCodeAt(s) === 32) { cnt++; s--; }
        if (cnt >= 2) {
          flushText(i);
          parts.push({ t: 3 });
          i = j + 1;
          // a hard break strips the next line's leading spaces/tabs
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          continue;
        }
      }
      if (runStart === -1) runStart = i;
      i = j;
      continue;
    }
    if (runStart === -1) runStart = i;
    i++;
  }
  flushText(n);
  return { parts, inLink };
}

// --- emphasis / strikethrough (CommonMark delimiter stack) ---------------
function processDelimiters(parts) {
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p.t !== 1 || !p.close) { i++; continue; }
    let opener = -1;
    for (let j = i - 1; j >= 0; j--) {
      const q = parts[j];
      if (q.t !== 1 || q.c !== p.c || !q.open) continue;
      if (p.c === '~') {
        // strikethrough needs equal-length runs (1 or 2)
        if (q.n !== p.n) continue;
      } else if ((p.open || q.close) && (p.n + q.n) % 3 === 0 && (p.n % 3 !== 0 || q.n % 3 !== 0)) {
        continue;
      }
      opener = j;
      break;
    }
    if (opener === -1) { i++; continue; }
    const o = parts[opener];
    const use = (o.n >= 2 && p.n >= 2) ? 2 : 1;
    const tag = p.c === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    const kids = parts.slice(opener + 1, i);
    const node = { t: 5, tag, kids };
    const repl = [];
    if (o.n - use > 0) repl.push({ t: 1, c: o.c, n: o.n - use, open: o.open, close: o.close });
    repl.push(node);
    if (p.n - use > 0) repl.push({ t: 1, c: p.c, n: p.n - use, open: p.open, close: p.close });
    parts.splice(opener, i - opener + 1, ...repl);
    i = opener + (o.n - use > 0 ? 1 : 0) + 1;
  }
}

// --- rendering ------------------------------------------------------------
function renderParts(parts, src, out) {
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    switch (p.t) {
      case 0:
        out.push(escapeText(src.slice(p.a, p.b)));
        break;
      case 1:
        out.push(p.c.repeat(p.n));
        break;
      case 2:
        out.push(p.h);
        break;
      case 3:
        out.push('<br>');
        break;
      case 4:
        if (p.href === null) {
          if (p.img) out.push(p.alt);
          else renderParts(p.kids, p.labelSrc, out);
          break;
        }
        if (p.img) {
          out.push('<img src="', p.href, '" alt="', p.alt, '"');
          if (p.title !== null) out.push(' title="', p.title, '"');
          out.push('>');
        } else {
          out.push('<a href="', p.href, '"');
          if (p.title !== null) out.push(' title="', p.title, '"');
          out.push('>');
          renderParts(p.kids, p.labelSrc, out);
          out.push('</a>');
        }
        break;
      case 5:
        out.push('<', p.tag, '>');
        renderParts(p.kids, p.src !== undefined ? p.src : src, out);
        out.push('</', p.tag, '>');
        break;
      case 6:
        out.push('<code>', escapePlain(p.s), '</code>');
        break;
      case 7:
        out.push('<a href="', p.href, '">', escapePlain(p.text), '</a>');
        break;
    }
  }
}

// Plain-text rendering of an inline sequence (image alt text).
function plainText(parts, src) {
  let out = '';
  for (const p of parts) {
    switch (p.t) {
      case 0:
        out += escapeText(src.slice(p.a, p.b));
        break;
      case 1:
        out += p.c.repeat(p.n);
        break;
      case 2:
        break;
      case 3:
        out += '\n';
        break;
      case 4:
        if (p.img) out += p.alt;
        else out += plainText(p.kids, p.labelSrc);
        break;
      case 5:
        out += plainText(p.kids, p.src !== undefined ? p.src : src);
        break;
      case 6:
        out += escapePlain(p.s);
        break;
      case 7:
        out += escapePlain(p.text);
        break;
    }
  }
  return out;
}

function inline(src, defs) {
  if (src === '') return '';
  const res = scanInline(src, defs, docInLink);
  docInLink = res.inLink;
  const parts = res.parts;
  processDelimiters(parts);
  const out = [];
  renderParts(parts, src, out);
  return out.join('');
}


// --- block parsing --------------------------------------------------------
// Block node kinds:
//  para {src}  h {level, src}  code {info, text}  html {text}  hr
//  quote {kids}  list {ordered, start, tight, items}  item {kids}
//  table {head, align, rows}
// Paragraph lines keep their leading spaces (only the first line's indent
// decides code vs paragraph); a paragraph is its lines joined with '\n'.

function lineInfo(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { indent: col, start: i, blank: i >= line.length };
}

// Return the text of `line` from column `targetCol` onward, starting the
// scan at index `fromIdx` (column `fromCol`). The remaining indent is
// preserved in columns as spaces, so a tab that straddles the cut does
// not lose columns.
// Strip leading whitespace up to targetCol columns, preserving tabs
// only when they advance the output to exactly the right column;
// otherwise the remainder is spaces.
function stripToCol(line, fromIdx, fromCol, targetCol) {
  let inCol = fromCol;
  let outCol = 0;
  let i = fromIdx;
  let out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      if (inCol < targetCol) { inCol++; i++; }
      else { out += ' '; outCol++; inCol++; i++; }
    } else if (c === 9) {
      const nextCol = inCol + 4 - (inCol % 4);
      if (nextCol <= targetCol) { inCol = nextCol; i++; }
      else if (inCol < targetCol) {
        const rem = nextCol - targetCol;
        out += ' '.repeat(rem);
        outCol += rem;
        inCol = nextCol;
        i++;
      } else {
        const targetOutCol = nextCol - targetCol;
        const tabAdvance = 4 - (outCol % 4);
        if (outCol + tabAdvance === targetOutCol) {
          out += '\t';
          outCol += tabAdvance;
        } else {
          const rem = nextCol - inCol;
          out += ' '.repeat(rem);
          outCol += rem;
        }
        inCol = nextCol;
        i++;
      }
    } else break;
  }
  return out + line.slice(i);
}

// Strip a blockquote marker (`>` plus one optional column of whitespace)
// from a line, preserving the remaining indent in columns as spaces.
function stripQuoteContent(line, info) {
  const nextIdx = info.start + 1;
  let targetCol = info.indent + 1;
  if (nextIdx < line.length) {
    const c = line.charCodeAt(nextIdx);
    if (c === 32 || c === 9) targetCol = info.indent + 2;
  }
  const rest = stripToCol(line, nextIdx, info.indent + 1, targetCol);
  // marked expands the whitespace after `>` (J()), so a tab left at the
  // start of the content becomes spaces to the next tab stop
  let col = targetCol;
  let k = 0;
  let out = '';
  while (k < rest.length) {
    const c = rest.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; k++; }
    else break;
  }
  return out + rest.slice(k);
}

// Remove `cols` columns of leading whitespace from a line. The remaining
// indent is preserved in columns (a tab that straddles the cut becomes
// spaces), so the result's indent equals the original indent minus `cols`.
// marked's indented-code dedent: strip 1-4 spaces, or up to 3 spaces
// plus a tab, from the start of the line.
function codeRemoveIndent(line) {
  const m = /^(?: {0,3}\t| {1,4})/.exec(line);
  return m === null ? line : line.slice(m[0].length);
}

function stripIndent(line, cols) {
  let inCol = 0;
  let outCol = 0;
  let i = 0;
  let out = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      if (inCol < cols) { inCol++; i++; }
      else { out += ' '; outCol++; inCol++; i++; }
    } else if (c === 9) {
      const nextCol = inCol + 4 - (inCol % 4);
      if (nextCol <= cols) { inCol = nextCol; i++; }
      else if (inCol < cols) {
        const rem = nextCol - cols;
        out += ' '.repeat(rem);
        outCol += rem;
        inCol = nextCol;
        i++;
      } else {
        const targetOutCol = nextCol - cols;
        const tabAdvance = 4 - (outCol % 4);
        if (outCol + tabAdvance === targetOutCol) {
          out += '\t';
          outCol += tabAdvance;
        } else {
          const rem = nextCol - inCol;
          out += ' '.repeat(rem);
          outCol += rem;
        }
        inCol = nextCol;
        i++;
      }
    } else break;
  }
  return out + line.slice(i);
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Parse a link reference definition at pos in a paragraph's joined source.
// Returns the position just past the def's line, or -1.
function parseDef(src, pos, defs) {
  const n = src.length;
  let i = pos;
  let spaces = 0;
  while (i < n && src.charCodeAt(i) === 32 && spaces < 3) { i++; spaces++; }
  if (i >= n || src.charCodeAt(i) !== 91) return -1;
  const le = findLabelEnd(src, i);
  if (le === -1) return -1;
  const label = src.slice(i + 1, le);
  if (label.length === 0 || normalizeLabel(label) === '') return -1;
  // A definition's label may not contain unescaped [ or ] (marked's
  // definition label does not allow nested brackets, even balanced ones).
  for (let k = 0; k < label.length; k++) {
    const ch = label.charCodeAt(k);
    if (ch === 92) { k++; continue; }
    if (ch === 91 || ch === 93) return -1;
  }
  let j = le + 1;
  while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
  if (j >= n || src.charCodeAt(j) !== 58) return -1;
  j++;
  while (j < n && isWhitespaceCode(src.charCodeAt(j))) j++;
  if (j >= n) return -1;
  let dest = null;
  if (src.charCodeAt(j) === 60) {
    let k = j + 1;
    let raw = '';
    let ok = false;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 10 || c === 60) break;
      if (c === 92 && k + 1 < n && isAsciiPunct(src.charCodeAt(k + 1))) { raw += src[k] + src[k + 1]; k += 2; continue; }
      if (c === 62) { ok = true; break; }
      raw += src[k];
      k++;
    }
    if (!ok) return -1;
    dest = raw;
    j = k + 1;
  } else {
    let k = j;
    let raw = '';
    let depth = 0;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && k + 1 < n && isAsciiPunct(src.charCodeAt(k + 1))) { raw += src[k] + src[k + 1]; k += 2; continue; }
      if (c === 40) { depth++; raw += src[k]; k++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        raw += src[k];
        k++;
        continue;
      }
      if (c < 32) return -1;
      raw += src[k];
      k++;
    }
    if (raw.length === 0) return -1;
    dest = raw;
    j = k;
  }
  // After the destination, a title may follow on the same line (after
  // whitespace) or on the next line. A title on the same line must be
  // valid, or the whole definition fails; a title on the next line that
  // is invalid leaves the definition valid without it.
  let title = null;
  let endPos = j;
  // skip spaces/tabs on the destination's line
  let k = j;
  while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
  if (k < n && src.charCodeAt(k) !== 10) {
    // something on the same line: it must be a valid title, preceded
    // by whitespace
    if (k === j) return -1;
    const ch = src.charCodeAt(k);
    if (ch !== 34 && ch !== 39 && ch !== 40) return -1;
    const closeCh = ch === 40 ? 41 : ch;
    let t = k + 1;
    let rawT = '';
    let okT = false;
    while (t < n) {
      const c = src.charCodeAt(t);
      if (c === 92 && t + 1 < n && isAsciiPunct(src.charCodeAt(t + 1))) { rawT += src[t] + src[t + 1]; t += 2; continue; }
      if (c === closeCh) { okT = true; break; }
      rawT += src[t];
      t++;
    }
    if (!okT) return -1;
    let m = t + 1;
    while (m < n && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
    if (m < n && src.charCodeAt(m) !== 10) return -1;
    title = rawT;
    endPos = m;
  } else {
    // the destination ends its line; a title may be on the next line
    endPos = k;
    if (k < n && src.charCodeAt(k) === 10) {
      let p = k + 1;
      while (p < n && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
      if (p < n) {
        const ch = src.charCodeAt(p);
        if (ch === 34 || ch === 39 || ch === 40) {
          const closeCh = ch === 40 ? 41 : ch;
          let t = p + 1;
          let rawT = '';
          let okT = false;
          while (t < n) {
            const c = src.charCodeAt(t);
            if (c === 92 && t + 1 < n && isAsciiPunct(src.charCodeAt(t + 1))) { rawT += src[t] + src[t + 1]; t += 2; continue; }
            if (c === closeCh) { okT = true; break; }
            rawT += src[t];
            t++;
          }
          if (okT) {
            let m = t + 1;
            while (m < n && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
            if (m >= n || src.charCodeAt(m) === 10) {
              title = rawT;
              endPos = m;
            }
          }
        }
      }
    }
  }
  const key = normalizeLabel(label);
  if (!defs.has(key)) defs.set(key, { dest, title });
  return endPos;
}

// Is this line an ATX heading? Returns the level or 0.
function atxLevel(line, info) {
  if (info.indent >= 4) return 0;
  let i = info.start;
  let level = 0;
  while (i < line.length && line.charCodeAt(i) === 35 && level < 7) { level++; i++; }
  if (level === 0 || level > 6) return 0;
  if (i >= line.length) return level;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return 0;
  return level;
}

// Is this line a thematic break? (---, ***, ___ with spaces, 0-3 indent)
function isHr(line, info) {
  if (info.indent >= 4) return false;
  let i = info.start;
  if (i >= line.length) return false;
  const ch = line[i];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let count = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (line[i] !== ch) return false;
    count++;
    i++;
  }
  return count >= 3;
}

// Is this line a setext underline? Returns '=' or '-' or ''.
// The underline is a contiguous run of one char (no spaces between the
// chars, unlike a thematic break); trailing spaces are allowed.
function setextCh(line, info) {
  if (info.indent >= 4) return '';
  let i = info.start;
  if (i >= line.length) return '';
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return '';
  while (i < line.length && line[i] === ch) i++;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i >= line.length ? ch : '';
}

// Fenced code start: returns {fence, len, info} or null.
function fenceStart(line, info) {
  if (info.indent >= 4) return null;
  let i = info.start;
  if (i >= line.length) return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i + len < line.length && line[i + len] === ch) len++;
  if (len < 3) return null;
  if (ch === '`' && line.indexOf('`', i + len) !== -1) return null;
  return { fence: ch, len, info: line.slice(i + len).trim() };
}

// HTML block start: returns {type, endTag} or null.
// type 1: script/pre/style/textarea (ends at the closing tag)
// type 2: <!-- (ends at -->)  type 3: <? (ends at ?>)
// type 4: <!letter (ends at >)  type 5: <![CDATA[ (ends at ]]>)
// type 6: block-level tag (ends at a blank line)
// type 7: a complete tag on one line (ends at a blank line)
function htmlBlockStart(line, info) {
  if (info.indent >= 4) return null;
  let i = info.start;
  if (i >= line.length || line.charCodeAt(i) !== 60) return null;
  const rest = line.slice(i + 1);
  const lower = rest.toLowerCase();
  if (lower.startsWith('script') || lower.startsWith('pre') || lower.startsWith('style') || lower.startsWith('textarea')) {
    const after = rest[lower.startsWith('script') ? 6 : lower.startsWith('textarea') ? 8 : lower.startsWith('style') ? 5 : 3];
    if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') {
      const tag = lower.startsWith('script') ? 'script' : lower.startsWith('textarea') ? 'textarea' : lower.startsWith('style') ? 'style' : 'pre';
      return { type: 1, endTag: '</' + tag };
    }
  }
  if (rest.startsWith('!--')) return { type: 2, endTag: '-->' };
  if (rest.startsWith('?')) return { type: 3, endTag: '?>' };
  if (rest.startsWith('!') && rest.length > 1) {
    const c = rest.charCodeAt(1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return { type: 4, endTag: '>' };
    if (rest.startsWith('![CDATA[')) return { type: 5, endTag: ']]>' };
  }
  // type 6/7: a tag name
  let j = 0;
  let closing = false;
  if (rest.charCodeAt(0) === 47) { closing = true; j = 1; }
  if (j >= rest.length) return null;
  const c0 = rest.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  let k = j;
  while (k < rest.length) {
    const c = rest.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) k++;
    else break;
  }
  const name = rest.slice(j, k).toLowerCase();
  const after = rest[k];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '>' && after !== '/' && after !== '\n') return null;
  if (BLOCK_TAGS.has(name)) return { type: 6, endTag: null };
  // type 7: the tag must be complete on this line
  const tagEnd = scanTag(line, i);
  if (tagEnd !== -1) {
    let m = tagEnd;
    while (m < line.length && (line.charCodeAt(m) === 32 || line.charCodeAt(m) === 9)) m++;
    if (m >= line.length) return { type: 7, endTag: null };
  }
  return null;
}

// Table delimiter row: returns the alignment array or null.
function tableDelim(line, info) {
  if (info.indent >= 4) return null;
  const cells = splitTableRow(line, info.start);
  if (cells === null) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    align.push(t.charCodeAt(0) === 58 && t.charCodeAt(t.length - 1) === 58 ? 'center' : t.charCodeAt(0) === 58 ? 'left' : t.charCodeAt(t.length - 1) === 58 ? 'right' : null);
  }
  return align.length === 0 ? null : align;
}

// Split a table row into cells. An unescaped `|` is a separator; a `|`
// preceded by an odd number of backslashes is a literal `|` in the cell.
// Code spans do NOT protect pipes.
function splitTableRow(line, start) {
  const cells = [];
  let cur = '';
  let i = start;
  let hasPipe = false;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 124) {
      let bs = 0;
      for (let k = cur.length - 1; k >= 0 && cur.charCodeAt(k) === 92; k--) bs++;
      if (bs % 2 === 1) {
        cur = cur.slice(0, -1) + '|';
        i++;
        continue;
      }
      hasPipe = true;
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  if (!hasPipe) return null;
  cells.push(cur);
  // drop a leading/trailing empty cell from an edge pipe
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// Parse a list marker at line/info. Returns {ordered, num, markerLen,
// contentIndent} or null.
function listMarker(line, info) {
  if (info.indent >= 4) return null;
  let i = info.start;
  if (i >= line.length) return null;
  const ch = line[i];
  let ordered = false;
  let num = 0;
  let markerLen = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    ordered = false;
    markerLen = 1;
  } else if (ch >= '0' && ch <= '9') {
    let j = i;
    let digits = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57 && digits < 10) { digits++; j++; }
    if (digits === 0 || digits > 9) return null;
    if (j >= line.length) return null;
    const d = line[j];
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    num = parseInt(line.slice(i, j), 10);
    markerLen = digits + 1;
  } else return null;
  // after the marker: 1+ spaces/tabs, or end of line
  let j = i + markerLen;
  let spaces = 0;
  let col = info.indent + markerLen;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 32) { spaces++; col++; j++; }
    else if (c === 9) { spaces += 4 - (col % 4); col += 4 - (col % 4); j++; }
    else break;
  }
  if (j >= line.length) {
    // empty item: content indent is marker width + 1
    return { ordered, num, markerLen, contentIndent: info.indent + markerLen + 1, R: markerLen + 1, empty: true };
  }
  if (spaces === 0) return null;
  if (spaces >= 5) {
    // 5+ spaces: the content indent is marker width + 1
    return { ordered, num, markerLen, contentIndent: info.indent + markerLen + 1, R: markerLen + 1, empty: false };
  }
  // marked's R (the indent a following line needs to belong to the item)
  // is the marker width plus the spaces after it, not the content column
  return { ordered, num, markerLen, contentIndent: col, R: markerLen + spaces, empty: false };
}




// --- main block walk ------------------------------------------------------
// Join a paragraph's lines, strip leading link reference definitions
// (first definition wins), and return the remaining inline source, or
// null when the paragraph was only definitions.
function paraSource(paraLines, defs) {
  const src = paraLines.join('\n');
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    let p = pos;
    while (p < n && src.charCodeAt(p) === 10) p++;
    const r = parseDef(src, p, defs);
    if (r === -1) { pos = p; break; }
    pos = r;
  }
  const rest = src.slice(pos);
  if (rest.trim() === '') return null;
  return rest;
}

// Would this line end a container (block quote / list item) instead of
// continuing its open paragraph lazily? A table delimiter does not end
// the container (it turns the paragraph into a table inside it), and
// neither does a setext underline made of `=` or `--` (those stay in the
// paragraph; a `-` run of 3+ is a thematic break and a lone `-` is a
// list marker, both caught below).
function isLazyEnd(line) {
  const info = lineInfo(line);
  if (info.blank) return true;
  if (atxLevel(line, info) > 0) return true;
  if (fenceStart(line, info) !== null) return true;
  if (isHr(line, info)) return true;
  const hb = htmlBlockStart(line, info);
  if (hb !== null && hb.type !== 7) return true;
  if (listMarker(line, info) !== null) return true;
  return false;
}

// Would this line start a new block (rather than continue a paragraph)?
// paraOpen: a paragraph is currently open; paraSingle: that paragraph is
// a single line (needed for the table delimiter check).
function isBlockStart(line, paraOpen, paraSingle, inItem) {
  const info = lineInfo(line);
  if (info.blank) return true;
  if (info.indent <= 3 && info.start < line.length && line.charCodeAt(info.start) === 62) return true;
  if (atxLevel(line, info) > 0) return true;
  if (fenceStart(line, info) !== null) return true;
  if (isHr(line, info)) return true;
  if (paraOpen && setextCh(line, info) !== '') return true;
  if (paraOpen && paraSingle) {
    // A table delimiter row turns a one-line paragraph into a table, but
    // only when the header row has at least one pipe (or the delimiter
    // does) — the delimiter itself is checked here.
    if (tableDelim(line, info) !== null) return true;
  }
  const hb = htmlBlockStart(line, info);
  if (hb !== null && !(paraOpen && hb.type === 7)) return true;
  const lm = listMarker(line, info);
  if (lm !== null) {
    if (!paraOpen) return true;
    // A list interrupts a paragraph only for bullets, or for an ordered
    // list starting at 1 — and never when the item is empty. Inside a
    // list item, a nested ordered list interrupts whatever it starts at.
    if ((!lm.ordered || lm.num === 1 || inItem) && !lm.empty) return true;
  }
  if (!paraOpen && info.indent >= 4) return true;
  return false;
}

// Does this content line, when added to a container, leave a paragraph
// open? Strips nested blockquote markers and list markers to find the
// innermost content.
function contentEndsPara(c) {
  let line = c;
  while (true) {
    const info = lineInfo(line);
    if (info.blank) return false;
    if (info.indent <= 3 && info.start < line.length && line.charCodeAt(info.start) === 62) {
      line = stripQuoteContent(line, info);
      continue;
    }
    break;
  }
  const info = lineInfo(line);
  if (info.blank) return false;
  if (setextCh(line, info) !== '') return false;
  const lm = listMarker(line, info);
  if (lm !== null) {
    if (lm.empty) return false;
    const first = stripToCol(line, info.start + lm.markerLen, info.indent + lm.markerLen, lm.contentIndent);
    return contentEndsPara(first);
  }
  if (isBlockStart(line, false, false)) return false;
  return true;
}

// Collect the content lines of a blockquote starting at line i.
// Returns {lines, next} where next is the first line after the quote.
// Update fenced-code state for a content line. `fence` is {ch, len} or
// null. Returns the new state.
function fenceUpdate(line, fence) {
  const info = lineInfo(line);
  if (fence === null) {
    const fs = fenceStart(line, info);
    if (fs !== null) return { ch: fs.fence.charCodeAt(0), len: fs.len };
    return null;
  }
  if (info.indent <= 3) {
    let k = info.start;
    let len = 0;
    while (k + len < line.length && line.charCodeAt(k + len) === fence.ch) len++;
    if (len >= fence.len) {
      let m = k + len;
      while (m < line.length && (line.charCodeAt(m) === 32 || line.charCodeAt(m) === 9)) m++;
      if (m >= line.length) return null;
    }
  }
  return fence;
}

function collectQuote(lines, i, end) {
  const content = [];
  let paraOpen = false;
  let paraLines = 0;
  // A lazy line is the first of its group when the previous content line
  // came from a `>` line; only later lazy lines get the setext escape.
  let lazyFirst = true;
  let fence = null;
  while (i < end) {
    const line = lines[i];
    const info = lineInfo(line);
    // a `>` line?
    let j = info.start;
    if (info.indent <= 3 && j < line.length && line.charCodeAt(j) === 62) {
      const c = stripQuoteContent(line, info);
      content.push(c);
      lazyFirst = true;
      fence = fenceUpdate(c, fence);
      const ci = lineInfo(c);
      if (fence !== null) { paraOpen = false; paraLines = 0; }
      else if (ci.blank) { paraOpen = false; paraLines = 0; }
      else if (contentEndsPara(c)) { paraOpen = true; paraLines++; }
      else { paraOpen = false; paraLines = 0; }
      i++;
      continue;
    }
    if (info.blank) break;
    if (paraOpen) {
      if (isLazyEnd(line)) break;
      // marked lexes a blockquote in chunks: a chunk is a run of lazy
      // lines followed by `>` lines, lexed together. A chunk that starts
      // with indented-code lines forms a code block whose dedented text
      // merges into the open paragraph (its text ends with a newline
      // when another line follows in the chunk, which surfaces as an
      // empty paragraph line); a chunk that starts with ordinary lines
      // is paragraph content, where an indented lazy line after a
      // non-indented one is a continuation, not a code line.
      const chunk = [];
      let j = i;
      let seenQuote = false;
      while (j < end) {
        const l2 = lines[j];
        const i2 = lineInfo(l2);
        if (i2.blank) break;
        if (i2.indent <= 3 && i2.start < l2.length && l2.charCodeAt(i2.start) === 62) {
          chunk.push({ quote: true, src: stripQuoteContent(l2, i2) });
          seenQuote = true;
          j++;
          continue;
        }
        if (seenQuote) break;
        if (chunk.length > 0 && isLazyEnd(l2)) break;
        chunk.push({ quote: false, src: l2 });
        j++;
      }
      const cs = chunk.map(c => c.src);
      // leading indented-code run: code lines (indent >= 4) and empty
      // lines that are followed by a code line
      let lastCode = -1;
      {
        let q = 0;
        while (q < cs.length) {
          const ci = lineInfo(cs[q]);
          if (!ci.blank && ci.indent >= 4) { lastCode = q; q++; continue; }
          if (ci.blank) {
            let k = q + 1;
            while (k < cs.length && lineInfo(cs[k]).blank) k++;
            if (k < cs.length && !lineInfo(cs[k]).blank && lineInfo(cs[k]).indent >= 4) { q++; continue; }
          }
          break;
        }
      }
      let rest = 0;
      if (lastCode >= 0) {
        // the code block merges into the open paragraph, dedented;
        // empty lines between code lines stay empty. A dedented code
        // line that would start a block (a list marker, a heading, a
        // fence) is still just paragraph text, so mark it as a
        // continuation for the recursive parse.
        for (let q = 0; q <= lastCode; q++) {
          if (lineInfo(cs[q]).blank) content.push('\u0001');
          else {
            const dl = codeRemoveIndent(cs[q]);
            content.push(isBlockStart(dl, true, false) ? '\u0001' + dl : dl);
          }
        }
        // the code text ends with a newline only when the next line
        // follows immediately (trailing blank lines are dropped);
        // trailing blank lines after the code block are dropped too,
        // but they still separate the following paragraph (a space token
        // in marked prevents it merging into the open paragraph)
        if (lastCode + 1 < cs.length && !lineInfo(cs[lastCode + 1]).blank) content.push('\u0001');
        rest = lastCode + 1;
        {
          const r0 = rest;
          while (rest < cs.length && lineInfo(cs[rest]).blank) rest++;
          if (rest > r0 && rest < cs.length) content.push('');
        }
      }
      // the rest of the chunk: `>` lines as quote content, lazy lines
      // as paragraph continuations (pushed as-is)
      for (let q = rest; q < cs.length; q++) {
        const c = cs[q];
        if (chunk[q].quote) {
          content.push(c);
          lazyFirst = true;
          fence = fenceUpdate(c, fence);
          const ci = lineInfo(c);
          if (fence !== null) { paraOpen = false; paraLines = 0; }
          else if (ci.blank) { paraOpen = false; paraLines = 0; }
          else if (contentEndsPara(c)) { paraOpen = true; paraLines++; }
          else { paraOpen = false; paraLines = 0; }
        } else {
          let lazyLine = c;
          const sinfo = lineInfo(lazyLine);
          if (!lazyFirst && setextCh(lazyLine, sinfo) !== '') {
            lazyLine = '    ' + lazyLine.slice(sinfo.start);
          }
          if (isBlockStart(lazyLine, true, false)) lazyLine = '\u0001' + lazyLine;
          lazyFirst = false;
          content.push(lazyLine);
          paraLines++;
        }
      }
      i = j;
      continue;
    }
    break;
  }
  return { lines: content, next: i };
}

// Collect the content lines of a list item. `first` is the first line's
// content (after the marker, already stripped of the marker + spaces).
// `contentIndent` is the column the item's content starts at.
// Returns {lines, next, blankSeen}.
// Expand leading tabs to spaces (tab stops every 4 columns from column
// 0), as marked's list loop does with J() before slicing item lines:
// a tab in an item's content line becomes spaces, it is not preserved.
function expandLeadingTabs(s) {
  let col = 0, k = 0, out = '';
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; k++; }
    else break;
  }
  return out + s.slice(k);
}

// Is this content line (already stripped of the container's indent) the
// start of a nested list or blockquote?
function isListOrQuote(line) {
  const info = lineInfo(line);
  if (info.blank || info.indent > 3) return false;
  if (line.charCodeAt(info.start) === 62) return true;
  return listMarker(line, info) !== null;
}

// Would this raw line end a list item in marked's list loop? marked
// breaks an item when the line matches a fence/heading/html/blockquote/
// bullet/hr start at up to the item's content indent R (spaces only) —
// even a fence-looking line whose info string is invalid (a backtick
// fence's info may not contain backticks, but the list loop only tests
// for the fence run).
function listBreaksItem(line, R) {
  // marked's break regexes are built with D(), which clamps the indent
  // to min(3, R-1) spaces.
  const lim = Math.max(0, Math.min(3, R - 1));
  let sp = 0;
  while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
  if (sp > lim) return false;
  const rest = line.slice(sp);
  if (rest.startsWith('```') || rest.startsWith('~~~')) return true;
  if (/^#{1,6}(?:\s|$)/.test(rest)) return true;
  if (rest.charCodeAt(0) === 62) return true;
  if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return true;
  if (/^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/.test(rest)) return true;
  if (htmlBlockStart(line, { indent: Math.min(sp, 3), start: sp, blank: false }) !== null) return true;
  return false;
}

// Is this line (already stripped to the item's content coordinates) a
// continuation of the open nested list, so that a blank run before it
// stays inside that list? True for a line indented into the open item
// (marked appends it to the item's text) and for a same-marker item at
// the list's indent (marked breaks the nested item but the nested list
// continues with a new item). The append threshold uses the CURRENT
// (last) item's R, not the list's first item's R: marked computes R per
// item from that item's own marker (marker length + spaces after it,
// clamped), so a later item with fewer spaces has a smaller R.
function blankInsideNested(c, openList) {
  if (openList === null) return false;
  const ci = lineInfo(c);
  const lastR = openList.lastR !== undefined ? openList.lastR : openList.R;
  if (ci.indent >= lastR) return true;
  const lm = listMarker(c, ci);
  if (lm !== null && ci.indent <= Math.min(3, lastR - 1) && lm.ordered === openList.ordered &&
      (lm.ordered ? c.charAt(ci.start + lm.markerLen - 1) === openList.delim : c[ci.start] === openList.bullet)) return true;
  return false;
}

function collectItem(lines, i, end, first, contentIndent) {
  const content = [first];
  let paraOpen = first.trim() !== '';
  let paraLines = paraOpen ? 1 : 0;
  let hasContent = paraOpen;
  let blankSeen = false;
  let blankRun = [];
  let blankStart = -1;
  let blankRunInFence = false;
  let fence = fenceUpdate(first, null);
  // whether the last content line opened a fence: in marked's list loop,
  // an unindented line after a fence opener ends the item (the loop
  // breaks when the previous line starts a fence), while an unindented
  // line after fence content is swallowed as a lazy line
  let lastFenceOpener = fence !== null;
  // a fence opener starts a container; a fence closer ends one
  let lastContainer = fence !== null || isListOrQuote(first);
  // The nested list whose items are being collected, if the last content
  // line started one: a blank run before its next item (or before a line
  // indented into its item) is inside that list, not a separation of
  // this item's top-level blocks, so it must not make this list loose.
  // marked's list loop keeps such a blank inside the nested list's raw
  // (it breaks the nested item but the nested list continues), while a
  // blank before any other top-level block leaves a space token.
  let openList = null;
  {
    const fi = lineInfo(first);
    const flm = listMarker(first, fi);
    if (flm !== null) openList = { ordered: flm.ordered, bullet: flm.ordered ? null : first[fi.start], delim: flm.ordered ? first.charAt(fi.start + flm.markerLen - 1) : null, indent: fi.indent, contentIndent: flm.contentIndent, R: flm.R, lastR: flm.R };
  }
  // indent of the previous content line (after stripping); a blank run
  // only separates top-level blocks when the line before it was one
  let lastIndent = lineInfo(first).indent;
  if (fence !== null) { paraOpen = false; paraLines = 0; }
  i++;
  while (i < end) {
    const line = lines[i];
    const info = lineInfo(line);
    if (info.blank) {
      // An empty item ends at a blank line; later lines are not its own.
      if (!hasContent) break;
      if (blankRun.length === 0) { blankStart = i; blankRunInFence = false; }
      if (fence !== null) blankRunInFence = true;
      blankRun.push('');
      paraOpen = false;
      paraLines = 0;
      i++;
      continue;
    }
    // marked's list loop breaks the item on a line that starts a fence,
    // heading, HTML block, blockquote, list item or thematic break at up
    // to min(3, contentIndent-1) spaces — before any indent check, and
    // even for a fence-looking line with an invalid info string.
    if (listBreaksItem(line, contentIndent)) break;
    // indented enough to belong to the item?
    if (info.indent >= contentIndent) {
      const c = expandLeadingTabs(stripIndent(line, contentIndent));
      // a blank run separates top-level blocks unless the line continues
      // the open nested list: a line indented into its item is appended
      // to that item, and a same-marker item at the list's indent starts
      // the list's next item (the blank stays inside the nested list).
      if (blankRun.length > 0 && !blankRunInFence && !blankInsideNested(c, openList)) blankSeen = true;
      for (const b of blankRun) content.push(b);
      blankRun = [];
      blankStart = -1;
      blankRunInFence = false;
      content.push(c);
      const wasFence = fence;
      fence = fenceUpdate(c, fence);
      lastFenceOpener = wasFence === null && fence !== null;
      if (wasFence === null && fence !== null) lastContainer = true;
      else if (wasFence !== null && fence === null) lastContainer = false;
      else lastContainer = isListOrQuote(c);
      const ci = lineInfo(c);
      // update the open nested list: a list start at the item's top
      // level replaces it (or keeps it when it is the same list, or a
      // deeper list inside the open item); a fence/heading/hr/html/quote
      // line at the item's top level ends it
      {
        const lm = listMarker(c, ci);
        const lastR = openList !== null ? (openList.lastR !== undefined ? openList.lastR : openList.R) : 0;
        if (lm !== null) {
          if (openList !== null && ci.indent >= lastR) {
            // deeper list inside the open item: keep openList
          } else if (openList !== null && ci.indent <= Math.min(3, lastR - 1) && lm.ordered === openList.ordered &&
              (lm.ordered ? c.charAt(ci.start + lm.markerLen - 1) === openList.delim : c[ci.start] === openList.bullet)) {
            // same list: keep openList, but the current item's R is now
            // this item's R (marked computes R per item)
            openList.lastR = lm.R;
          } else {
            openList = { ordered: lm.ordered, bullet: lm.ordered ? null : c[ci.start], delim: lm.ordered ? c.charAt(ci.start + lm.markerLen - 1) : null, indent: ci.indent, contentIndent: lm.contentIndent, R: lm.R, lastR: lm.R };
          }
        } else if (openList !== null && ci.indent <= Math.min(3, lastR - 1) &&
            (ci.start < c.length && c.charCodeAt(ci.start) === 62 || atxLevel(c, ci) > 0 || isHr(c, ci) || htmlBlockStart(c, ci) !== null || (wasFence === null && fence !== null))) {
          openList = null;
        }
      }
      lastIndent = ci.indent;
      if (fence !== null) { paraOpen = false; paraLines = 0; }
      else if (ci.blank) { paraOpen = false; paraLines = 0; }
      else {
        if (ci.start < c.length) hasContent = true;
        if (contentEndsPara(c)) { paraOpen = true; paraLines++; }
        else { paraOpen = false; paraLines = 0; }
      }
      i++;
      continue;
    }
    if (paraOpen) {
      if (isLazyEnd(line)) break;
      // lazy paragraph continuation; up to 4 columns stripped
      let lazyLine = line;
      if (info.indent >= 4) lazyLine = stripIndent(line, 4);
      if (isBlockStart(lazyLine, true, false, true)) lazyLine = '\u0001' + lazyLine;
      if (blankRun.length > 0 && !blankRunInFence && !blankInsideNested(lazyLine, openList)) blankSeen = true;
      for (const b of blankRun) content.push(b);
      blankRun = [];
      blankStart = -1;
      blankRunInFence = false;
      content.push(lazyLine);
      lastContainer = isListOrQuote(lazyLine);
      lastIndent = lineInfo(lazyLine).indent;
      hasContent = true;
      paraLines++;
      i++;
      continue;
    }
    if (fence !== null) {
      // Inside a fenced code block, every line is fence content until
      // the fence closes, regardless of indent — except an unindented
      // line right after a line that starts a block (a fence opener, an
      // ATX heading, an hr, an html block, a blockquote): marked's list
      // loop breaks the item there, because the previous line starts a
      // block (the same test as the lazy-continuation break).
      if (lastFenceOpener) break;
      const lastLine = content[content.length - 1];
      if (lastLine !== undefined) {
        const li = lineInfo(lastLine);
        if (fenceUpdate(lastLine, null) !== null || atxLevel(lastLine, li) > 0 || isHr(lastLine, li) || htmlBlockStart(lastLine, li) !== null || (li.start < lastLine.length && lastLine.charCodeAt(li.start) === 62)) break;
      }
      for (const b of blankRun) content.push(b);
      blankRun = [];
      blankStart = -1;
      blankRunInFence = false;
      content.push(line);
      fence = fenceUpdate(line, fence);
      lastFenceOpener = false;
      lastContainer = fence !== null;
      lastIndent = info.indent;
      hasContent = true;
      paraOpen = false;
      paraLines = 0;
      i++;
      continue;
    }
    break;
  }
  // Trailing blank lines are not part of the item; leave them for the
  // list loop so it can see the separation between items.
  const next = blankRun.length > 0 ? blankStart : i;
  return { lines: content, next, blankSeen };
}

// Parse a table's body rows starting just after the delimiter row at
// index delimIdx; headCells/align are already validated. Returns the
// table block and the index of the first line after the table.
function parseTableRows(lines, delimIdx, end, headCells, align) {
  const rows = [];
  let i = delimIdx + 1;
  while (i < end) {
    const rl = lines[i];
    const ri = lineInfo(rl);
    if (ri.blank) {
      // a whitespace-only line ends the table — unless it holds a tab,
      // which marked reads as a single empty-cell row (padded to the
      // table's width)
      if (rl.indexOf('\t') === -1) break;
      rows.push(['']);
      i++;
      continue;
    }
    const cells = splitTableRow(rl, ri.start);
    // a row without pipes is a single-cell row (padded) — unless the
    // line starts a new block, which ends the table
    if (cells === null && isBlockStart(rl, false, false)) break;
    rows.push(cells === null ? [rl.slice(ri.start)] : cells);
    i++;
  }
  return { block: { k: 'table', head: headCells, align, rows }, next: i };
}

function parseBlocks(lines, start, end, defs, terminated, inItem, inQuote) {
  const blocks = [];
  let i = start;
  let para = [];
  // set once an indented-code merge has joined a paragraph: a setext
  // underline after it cannot turn the text token into a heading
  let paraCodeMerged = false;
  function flushPara() {
    if (para.length === 0) return;
    const src = paraSource(para, defs);
    para = [];
    paraCodeMerged = false;
    if (src !== null) blocks.push({ k: 'para', src });
  }
  while (i < end) {
    const line = lines[i];
    const info = lineInfo(line);
    if (info.blank) {
      // A whitespace-only last line of a non-terminated range is
      // paragraph content, not a blank line (e.g. a trailing `>  `).
      // A truly empty line is still a blank line.
      if (!terminated && i === end - 1 && para.length > 0 && line.length > 0) {
        para.push(line);
        i++;
        continue;
      }
      flushPara(); i++; continue;
    }
    // setext heading (only when a paragraph is open)
    if (para.length > 0) {
      // A stripped lazy line that would otherwise start a block is
      // marked with \u0001; it is a paragraph continuation.
      if (line.charCodeAt(0) === 1) {
        para.push(line.slice(1));
        i++;
        continue;
      }
      // Inside a list item, marked lexes with state.top=false, so the
      // paragraph is a single line and an indented line after it is an
      // indented code block that merges into the text token (dedented);
      // a following line merges after a blank line in the merged text.
      // (Not inside a blockquote: there marked lexes with state.top=true
      // and the paragraph swallows indented lines.)
      if (inItem && !inQuote && info.indent >= 4) {
        let k = i;
        let lastCode = -1;
        while (k < end) {
          const ci = lineInfo(lines[k]);
          if (!ci.blank && ci.indent >= 4) { lastCode = k; k++; continue; }
          if (ci.blank) {
            let m = k + 1;
            while (m < end && lineInfo(lines[m]).blank) m++;
            if (m < end && !lineInfo(lines[m]).blank && lineInfo(lines[m]).indent >= 4) { k++; continue; }
          }
          break;
        }
        if (lastCode >= 0) {
          for (let q = i; q <= lastCode; q++) {
            if (lineInfo(lines[q]).blank) para.push('');
            else para.push(codeRemoveIndent(lines[q]));
          }
          if (lastCode + 1 < end && !lineInfo(lines[lastCode + 1]).blank) para.push('');
          paraCodeMerged = true;
          i = lastCode + 1;
          continue;
        }
      }
      const se = setextCh(line, info);
      if (se !== '' && !paraCodeMerged) {
        const src0 = paraSource(para, defs);
        para = [];
        if (src0 !== null) {
          // a setext heading's content has leading/trailing whitespace
          // stripped (unlike a paragraph, which keeps it)
          const src = src0.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          blocks.push({ k: 'h', level: se === '=' ? 1 : 2, src });
          i++;
          continue;
        }
        // the paragraph was only definitions; the setext line is a
        // paragraph line now — fall through and handle it as one
      }
      // table: a one-line paragraph followed by a delimiter row
      if (para.length === 1) {
        const align = tableDelim(line, info);
        if (align !== null) {
          const headCells = splitTableRow(para[0], lineInfo(para[0]).start);
          if (headCells !== null && headCells.length === align.length) {
            const headSrc = paraSource(para, defs);
            para = [];
            const t = parseTableRows(lines, i, end, headCells, align);
            blocks.push(t.block);
            i = t.next;
            continue;
          }
        }
      }
      // a table header row ends a multi-line paragraph: marked's
      // paragraph regex refuses to swallow a line that starts a table
      // (a header row with the delimiter row after it), so the paragraph
      // ends before the header and the table starts here
      if (i + 1 < end) {
        const headCells = splitTableRow(line, info.start);
        if (headCells !== null) {
          const dInfo = lineInfo(lines[i + 1]);
          const align = tableDelim(lines[i + 1], dInfo);
          if (align !== null && align.length === headCells.length) {
            flushPara();
            const t = parseTableRows(lines, i + 1, end, headCells, align);
            blocks.push(t.block);
            i = t.next;
            continue;
          }
        }
      }
      // otherwise, a line that starts a new block ends the paragraph;
      // anything else continues it. A table delimiter whose cell count
      // does not match the header is a continuation, not a block start.
      if (para.length === 1) {
        const align = tableDelim(line, info);
        if (align !== null) {
          const headCells = splitTableRow(para[0], lineInfo(para[0]).start);
          if (headCells === null || headCells.length !== align.length) {
            para.push(line);
            i++;
            continue;
          }
        }
      }
      // A paragraph that is only link reference definitions is not a
      // paragraph at all (marked matches the defs first, then the next
      // block), so an indented line after it starts indented code —
      // unless the line belongs to a definition (a title on the next
      // line, or a new definition), tested by joining it into the
      // paragraph source: if the joined source is still only defs, the
      // line continues the paragraph. The probes use a throwaway map:
      // registering here would lock in an incomplete definition (a
      // title on the next line) under first-definition-wins.
      if (info.indent >= 4 && paraSource(para, new Map()) === null) {
        if (paraSource(para.concat([line]), new Map()) === null) {
          para.push(line);
          i++;
          continue;
        }
        flushPara();
      } else if (!isBlockStart(line, true, para.length === 1, inItem)) {
        para.push(line);
        i++;
        continue;
      } else {
        flushPara();
      }
    }
    // --- block dispatch (no paragraph open) ---
    const fl = lineInfo(line);
    const atx = atxLevel(line, fl);
    if (atx > 0) {
      let j = fl.start + atx;
      while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
      let text = line.slice(j);
      // strip a closing sequence of #'s preceded by a space
      const m = text.match(/^(.*?)[ \t]+#+[ \t]*$/);
      if (m !== null) text = m[1];
      else {
        const m2 = text.match(/^#+[ \t]*$/);
        if (m2 !== null) text = '';
      }
      text = text.replace(/[ \t]+$/, '');
      blocks.push({ k: 'h', level: atx, src: text });
      i++;
      continue;
    }
    const fs = fenceStart(line, fl);
    if (fs !== null) {
      // marked's indentCodeCompensation (Dt): only backtick fences whose
      // opening line starts with whitespace get compensation, and it
      // strips raw characters, not columns: each content line loses
      // min(leading-whitespace chars, opening indent chars). A tab after
      // the opening indent is kept whole; tilde fences strip nothing.
      const openIndentChars = fs.fence === '`' ? fl.start : 0;
      const content = [];
      i++;
      while (i < end) {
        const cl = lines[i];
        const ci = lineInfo(cl);
        if (ci.indent <= 3) {
          let k = ci.start;
          let len = 0;
          while (k + len < cl.length && cl[k + len] === fs.fence) len++;
          if (len >= fs.len) {
            let m = k + len;
            while (m < cl.length && (cl.charCodeAt(m) === 32 || cl.charCodeAt(m) === 9)) m++;
            if (m >= cl.length) { i++; break; }
          }
        }
        if (openIndentChars > 0) {
          let w = 0;
          while (w < cl.length && (cl.charCodeAt(w) === 32 || cl.charCodeAt(w) === 9)) w++;
          content.push(w > 0 ? cl.slice(Math.min(w, openIndentChars)) : cl);
        } else {
          content.push(cl);
        }
        i++;
      }
      blocks.push({ k: 'code', info: fs.info, text: content.join('\n') });
      continue;
    }
    if (isHr(line, fl)) { blocks.push({ k: 'hr' }); i++; continue; }
    const hb = htmlBlockStart(line, fl);
    if (hb !== null) {
      const content = [line];
      i++;
      // the starting line may already contain the end marker
      let done = false;
      if (hb.type === 1) {
        if (new RegExp(hb.endTag, 'i').test(line)) done = true;
      } else if (hb.type >= 2 && hb.type <= 5) {
        if (line.indexOf(hb.endTag) !== -1) done = true;
      }
      if (!done) {
        if (hb.type === 1) {
          const endRe = new RegExp(hb.endTag, 'i');
          while (i < end) {
            content.push(lines[i]);
            if (endRe.test(lines[i])) { i++; break; }
            i++;
          }
        } else if (hb.type >= 2 && hb.type <= 5) {
          while (i < end) {
            content.push(lines[i]);
            if (lines[i].indexOf(hb.endTag) !== -1) { i++; break; }
            i++;
          }
        } else {
          // type 6/7: ends at a blank line
          while (i < end && !lineInfo(lines[i]).blank) { content.push(lines[i]); i++; }
          // A whitespace-only line at the very end (no newline after
          // it) is not a blank line for marked's html regex, so it is
          // part of the block; a whitespace-only line followed by a
          // newline is a blank line and ends the block.
          if (i < end && i === end - 1 && !terminated && lines[i].length > 0 && lineInfo(lines[i]).blank) {
            content.push(lines[i]);
            i++;
          }
        }
      }
      // The block's text keeps the newline that terminates its last
      // line. For types 1-5 the newline is kept unless the next line
      // is truly empty (a whitespace-only line does not remove it, and
      // the whitespace itself is not part of the block); for types 6/7
      // it is kept unless the next line is blank at all.
      const trailNl = hb.type <= 5
        ? (i < end ? lines[i].length > 0 : terminated)
        : (i < end ? !lineInfo(lines[i]).blank : terminated);
      blocks.push({ k: 'html', text: content.join('\n'), trailNl });
      continue;
    }
    // blockquote
    if (fl.indent <= 3 && fl.start < line.length && line.charCodeAt(fl.start) === 62) {
      const q = collectQuote(lines, i, end);
      // A nested range's content string has no trailing newline, so an
      // HTML block at its end never keeps one.
      const kids = parseBlocks(q.lines, 0, q.lines.length, defs, false, inItem, true);
      blocks.push({ k: 'quote', kids });
      i = q.next;
      continue;
    }
    // list
    const lm = listMarker(line, fl);
    if (lm !== null) {
      const items = [];
      const ordered = lm.ordered;
      const startNum = lm.num;
      const bullet = ordered ? null : line[fl.start];
      const delim = ordered ? line.charAt(fl.start + lm.markerLen - 1) : null;
      let tight = true;
      while (i < end) {
        const li = lines[i];
        const linfo = lineInfo(li);
        if (linfo.blank) break;
        // a thematic break is never a list item
        if (isHr(li, linfo)) break;
        const m = listMarker(li, linfo);
        if (m === null) break;
        if (m.ordered !== ordered) break;
        if (!ordered && li[linfo.start] !== bullet) break;
        if (ordered && li.charAt(linfo.start + m.markerLen - 1) !== delim) break;
        // content of this item: the line from the content indent onward
        let firstContent;
        if (m.empty) firstContent = '';
        else firstContent = stripToCol(li, linfo.start + m.markerLen, linfo.indent + m.markerLen, m.contentIndent);
        const it = collectItem(lines, i, end, firstContent, m.contentIndent);
        if (it.blankSeen) tight = false;
        items.push({ k: 'item', lines: it.lines });
        i = it.next;
        // skip blank lines between items; a blank line between items
        // makes the list loose
        let blanks = 0;
        while (i < end && lineInfo(lines[i]).blank) { blanks++; i++; }
        if (blanks > 0 && i < end) {
          const nli = lineInfo(lines[i]);
          if (isHr(lines[i], nli)) break;
          const nm = listMarker(lines[i], nli);
          if (nm !== null && nm.ordered === ordered &&
              (ordered ? lines[i].charAt(nli.start + nm.markerLen - 1) === delim : lines[i][nli.start] === bullet)) {
            tight = false;
            continue;
          }
          break;
        }
        if (i >= end) break;
        const nli = lineInfo(lines[i]);
        if (isHr(lines[i], nli)) break;
        const nm = listMarker(lines[i], nli);
        if (nm === null || nm.ordered !== ordered) break;
        if (!ordered && lines[i][nli.start] !== bullet) break;
        if (ordered && lines[i].charAt(nli.start + nm.markerLen - 1) !== delim) break;
      }
      // marked trims trailing whitespace off the last item's text only
      if (items.length > 0) {
        const last = items[items.length - 1];
        if (last.lines.length > 0) last.lines[last.lines.length - 1] = last.lines[last.lines.length - 1].trimEnd();
      }
      for (const it of items) it.kids = parseBlocks(it.lines, 0, it.lines.length, defs, false, true, false);
      blocks.push({ k: 'list', ordered, start: startNum, tight, items });
      continue;
    }
    // indented code (no paragraph open)
    if (fl.indent >= 4) {
      const content = [];
      while (i < end) {
        const cl = lines[i];
        const ci = lineInfo(cl);
        if (ci.blank) {
          // a blank line is part of the code block only if followed by
          // another indented line; its spaces past the code indent are kept
          let k = i + 1;
          while (k < end && lineInfo(lines[k]).blank) k++;
          if (k < end && lineInfo(lines[k]).indent >= 4) {
            content.push(stripIndent(cl, 4));
            i++;
            continue;
          }
          break;
        }
        if (ci.indent < 4) break;
        content.push(stripIndent(cl, 4));
        i++;
      }
      blocks.push({ k: 'code', info: null, text: content.join('\n') });
      continue;
    }
    // paragraph line
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

// --- rendering ------------------------------------------------------------
// A task list item's first paragraph starts with `[ ] ` or `[x] `; the
// checkbox replaces that prefix (inside the <p> when the list is loose).
const TASK_RE = /^[ \t]*\[( |x|X)\][ \t]/;

function renderItem(it, defs, out, tight) {
  const kids = it.kids;
  if (kids.length > 0 && kids[0].k === 'para') {
    const src = kids[0].src;
    const m = TASK_RE.exec(src);
    if (m !== null) {
      const checked = m[1] !== ' ';
      const rest = src.slice(m[0].length);
      const box = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      if (tight) out.push(box, inline(rest, defs));
      else out.push('<p>', box, inline(rest, defs), '</p>\n');
      renderBlocks(kids.slice(1), defs, out, tight);
      return;
    }
  }
  renderBlocks(kids, defs, out, tight);
}

function renderBlocks(blocks, defs, out, tight) {
  for (const b of blocks) {
    switch (b.k) {
      case 'para': {
        if (tight) out.push(inline(b.src, defs));
        else out.push('<p>', inline(b.src, defs), '</p>\n');
        break;
      }
      case 'h':
        out.push('<h', String(b.level), '>', inline(b.src, defs), '</h', String(b.level), '>\n');
        break;
      case 'code': {
        if (b.info !== null && b.info !== '') {
          const lang = unescapeBackslashes(b.info.split(/\s+/)[0]);
          out.push('<pre><code class="language-', escapeAttr(lang), '">');
        } else out.push('<pre><code>');
        out.push(escapePlain(b.text));
        if (b.text !== '' && !b.text.endsWith('\n')) out.push('\n');
        out.push('</code></pre>\n');
        break;
      }
      case 'html':
        out.push(b.text);
        if (b.trailNl) out.push('\n');
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'quote':
        out.push('<blockquote>\n');
        renderBlocks(b.kids, defs, out, false);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        if (b.ordered) {
          if (b.start !== 1) out.push('<ol start="', String(b.start), '">\n');
          else out.push('<ol>\n');
        } else out.push('<ul>\n');
        for (const it of b.items) {
          out.push('<li>');
          renderItem(it, defs, out, b.tight);
          out.push('</li>\n');
        }
        out.push(b.ordered ? '</ol>\n' : '</ul>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let c = 0; c < b.head.length; c++) {
          const a = b.align[c];
          out.push('<th', a ? ' align="' + a + '"' : '', '>', inline(b.head[c].trim(), defs), '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let c = 0; c < b.head.length; c++) {
              const a = b.align[c];
              const cell = c < row.length ? row[c] : '';
              out.push('<td', a ? ' align="' + a + '"' : '', '>', inline(cell.trim(), defs), '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
}

// parse(markdown) -> the HTML marked 18.1.3 renders with default options.
function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const terminated = src.endsWith('\n');
  const lines = src.split('\n');
  // Drop the artifact empty line from a trailing newline (it is not a
  // real blank line).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const defs = new Map();
  docInLink = false;
  const blocks = parseBlocks(lines, 0, lines.length, defs, terminated, false, false);
  const out = [];
  renderBlocks(blocks, defs, out, false);
  return out.join('');
}

export { parse, inline };
