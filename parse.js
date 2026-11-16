// A dependency-free drop-in for marked 18.1.3's parse(), written from scratch.
// It renders exactly the HTML marked produces with its default options
// (gfm on, breaks off, pedantic off, async off), for any Markdown string.
//
// Design: a block parser builds a small tree of block nodes (containers are
// matched line by line, the way the CommonMark spec describes), and an
// inline parser turns each block's text into HTML with a delimiter stack
// for emphasis, strikethrough and link brackets.

'use strict';

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isAsciiPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}

function isUnicodePunct(ch) {
  if (!ch) return false;
  return isAsciiPunct(ch) || /\p{P}/u.test(ch) || /\p{S}/u.test(ch);
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0';
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAlnum(ch) {
  return isAlpha(ch) || isDigit(ch);
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------
// marked escapes text with its "no encode" form: < > " ' are always escaped,
// and & is escaped only when it does not already look like a character
// reference (&word; or &#123; or &#x1a;). Code spans and code blocks use the
// full form, where & is always escaped.

const AMP_ENTITY_RE = /&(?!(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);)/g;

function escText(s) {
  // Escape &, <, >, ", ' -- with & left alone when it starts something that
  // already looks like an entity reference.
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      // Does an entity-like tail follow? &word; &#123; &#x1a;
      let j = i + 1;
      if (s[j] === '#') {
        j++;
        if (s[j] === 'x' || s[j] === 'X') {
          j++;
          let k = j;
          while (k < n && /[0-9a-fA-F]/.test(s[k])) k++;
          if (k > j && k - j <= 6 && s[k] === ';') { out += s.slice(i, k + 1); i = k + 1; continue; }
        } else {
          let k = j;
          while (k < n && isDigit(s[k])) k++;
          if (k > j && k - j <= 7 && s[k] === ';') { out += s.slice(i, k + 1); i = k + 1; continue; }
        }
      } else {
        let k = j;
        while (k < n && /[A-Za-z0-9]/.test(s[k])) k++;
        if (k > j && s[k] === ';') { out += s.slice(i, k + 1); i = k + 1; continue; }
      }
      out += '&amp;';
      i++;
    } else if (ch === '<') { out += '&lt;'; i++; }
    else if (ch === '>') { out += '&gt;'; i++; }
    else if (ch === '"') { out += '&quot;'; i++; }
    else if (ch === "'") { out += '&#39;'; i++; }
    else { out += ch; i++; }
  }
  return out;
}

function escFull(s) {
  // Escape every & < > " ' (used for code spans, code blocks, attribute
  // values that must not keep entity references).
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Character references
// ---------------------------------------------------------------------------
// Named references are passed through verbatim (marked never decodes them to
// characters; it only leaves "&word;" alone when escaping). Numeric
// references are decoded to the character, with 0 and surrogates and values
// above the Unicode range becoming U+FFFD. A decoded character is plain text:
// it never becomes a delimiter, a bracket or anything else.

function decodeNumericEntity(s, i) {
  // s[i] === '&'. Returns [decodedChar, nextIndex] or null.
  const n = s.length;
  if (s[i + 1] !== '#') return null;
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  if (hex) {
    while (j < n && /[0-9a-fA-F]/.test(s[j])) j++;
    if (j === start || j - start > 6 || s[j] !== ';') return null;
  } else {
    while (j < n && isDigit(s[j])) j++;
    if (j === start || j - start > 7 || s[j] !== ';') return null;
  }
  let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [String.fromCodePoint(cp), j + 1];
}

// ---------------------------------------------------------------------------
// Link labels
// ---------------------------------------------------------------------------
// Labels are compared after collapsing every run of whitespace (spaces,
// tabs, newlines) to one space, trimming the ends, and Unicode case folding.
// Backslash escapes inside a label are NOT resolved: the raw text is what
// is compared. A label may not contain an unescaped [ or ], and may not be
// empty or longer than 999 characters.

const FOLD_EXTRA = {
  '\u00df': 'ss', '\u1e9e': 'ss',
  '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl',
  '\ufb05': 'st', '\ufb06': 'st', '\u0130': 'i\u0307',
};

function foldCase(s) {
  let out = '';
  for (const ch of s) {
    const rep = FOLD_EXTRA[ch];
    out += rep !== undefined ? rep : ch.toLowerCase();
  }
  return out;
}

function normalizeLabel(raw) {
  return foldCase(raw.replace(/[ \t\r\n]+/g, ' ').trim());
}

function validLabel(raw) {
  if (raw.length === 0 || raw.length > 999) return false;
  // A label that is only whitespace normalizes to empty and is not a
  // label at all (e.g. `[\n ]` is literal text, not a link).
  if (normalizeLabel(raw).length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '[' || ch === ']') return false;
    if (ch === '\\') i++; // an escaped bracket is fine
  }
  return true;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
// A link destination is cleaned the way marked does: the URL is trimmed,
// dangerous schemes are refused, and the rest is percent-encoded with
// encodeURI (spaces, quotes, backslashes, brackets and non-ASCII become
// %XX), leaving % sequences, & and the usual URI characters alone. The
// result is then HTML-escaped when written into an attribute.

function cleanUrl(href) {
  if (href === null || href === undefined) return null;
  let u = href.trim();
  // Refuse javascript:, vbscript: and data: (other than image data), after
  // stripping control characters and whitespace, case-insensitively.
  const probe = u.replace(/[\x00-\x20\x7f]+/g, '').toLowerCase();
  if (
    probe.startsWith('javascript:') ||
    probe.startsWith('vbscript:') ||
    (probe.startsWith('data:') && !probe.startsWith('data:image/'))
  ) {
    return null;
  }
  try {
    // encodeURI escapes % too; turn %25 back into % so an existing
    // escape (foo%20b) survives while other characters are encoded.
    u = encodeURI(u).replace(/%25/g, '%');
  } catch (_e) {
    return null;
  }
  return u;
}

// ---------------------------------------------------------------------------
// Small entity table, only for the extended-autolink trailing-semicolon
// rule: a trailing "&xxx;" is kept when xxx names a real entity.
// ---------------------------------------------------------------------------

const KNOWN_ENTITIES = new Set([
  'amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'copy', 'reg', 'trade', 'hellip',
  'mdash', 'ndash', 'lsquo', 'rsquo', 'ldquo', 'rdquo', 'laquo', 'raquo',
  'middot', 'bull', 'permil', 'prime', 'Prime', 'oline', 'frasl', 'euro',
  'pound', 'curren', 'yen', 'cent', 'sect', 'uml', 'ordf', 'ordm', 'para',
  'iexcl', 'iquest', 'szlig', 'agrave', 'aacute', 'acirc', 'atilde', 'auml',
  'aring', 'aelig', 'ccedil', 'egrave', 'eacute', 'ecirc', 'euml', 'igrave',
  'iacute', 'icirc', 'iuml', 'eth', 'ntilde', 'ograve', 'oacute', 'ocirc',
  'otilde', 'ouml', 'oslash', 'ugrave', 'uacute', 'ucirc', 'uuml', 'yacute',
  'yuml', 'thorn', 'yuml', 'AElig', 'Dcaron', 'HilbertSpace', 'DifferentialD',
  'ClockwiseContourIntegral', 'ngE', 'frac34', 'frac12', 'frac14', 'ouml',
  'auml', 'euml', 'iuml', 'uuml', 'yuml', 'Ouml', 'Auml', 'Euml', 'Iuml',
  'Uuml', 'Yuml', 'sup1', 'sup2', 'sup3', 'deg', 'plusmn', 'micro', 'times',
  'divide', 'minus', 'lowast', 'radic', 'infin', 'cap', 'cup', 'int', 'sim',
  'cong', 'asymp', 'ne', 'equiv', 'le', 'ge', 'sub', 'sup', 'nsub', 'sube',
  'supe', 'oplus', 'otimes', 'perp', 'sdot', 'lceil', 'rceil', 'lfloor',
  'rfloor', 'lang', 'rang', 'loz', 'spades', 'clubs', 'hearts', 'diams',
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'Alpha', 'Beta',
  'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa',
  'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau',
  'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega', 'thetasym', 'upsih', 'piv',
  'bull', 'hellip', 'prime', 'Prime', 'oline', 'frasl', 'weierp', 'image',
  'real', 'alefsym', 'larr', 'uarr', 'rarr', 'darr', 'harr', 'crarr',
  'lArr', 'uArr', 'rArr', 'dArr', 'hArr', 'forall', 'part', 'exist',
  'empty', 'nabla', 'isin', 'notin', 'ni', 'prod', 'sum',
]);

/* ===========================================================================
   Inline parsing
   =========================================================================== */

// Node kinds used while scanning one inline run:
//   {k:'t', s}            plain text (already unescaped where needed)
//   {k:'d', ch, len, canOpen, canClose}  emphasis / strikethrough delimiter
//   {k:'c', s}            code span (s is fully escaped HTML)
//   {k:'h', s}            raw inline HTML (passed through)
//   {k:'b'}               hard break  -> <br>\n
//   {k:'s'}               soft break  -> \n
//   {k:'a', href, title, kids}   link
//   {k:'i', href, title, alt}    image (alt is plain text, escaped)
//   {k:'e', tag, kids}    em / strong / del, made by emphasis resolution
//   {k:'[', image, pos}   an unmatched '[' (renders as '[' unless a link forms)

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// --- code spans -----------------------------------------------------------

function scanCodeSpan(s, i, runLen) {
  // s[i] starts a run of runLen backticks. Find the next run of exactly
  // runLen backticks. Returns [content, nextIndex] or null.
  const n = s.length;
  let j = i + runLen;
  while (j < n) {
    if (s[j] === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      if (k - j === runLen) {
        let content = s.slice(i + runLen, j);
        content = content.replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content[0] === ' ' &&
          content[content.length - 1] === ' ' &&
          /[^ ]/.test(content)
        ) {
          content = content.slice(1, -1);
        }
        return [content, k];
      }
      j = k;
    } else {
      j++;
    }
  }
  return null;
}

// --- inline HTML and autolinks --------------------------------------------

function scanHtmlTag(s, i) {
  // Try to read an inline HTML construct at s[i] === '<'.
  // Returns [html, nextIndex] or null.
  const n = s.length;
  if (s[i + 1] === '!') {
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are abruptly-closed comments: they end at
      // the first > rather than at a later -->.
      if (s.startsWith('<!-->', i)) return [s.slice(i, i + 5), i + 5];
      if (s.startsWith('<!--->', i)) return [s.slice(i, i + 6), i + 6];
      const end = s.indexOf('-->', i + 4);
      if (end === -1) return null;
      return [s.slice(i, end + 3), end + 3];
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return [s.slice(i, end + 3), end + 3];
    }
    // Declaration <!A ...> : letter after !, up to the next >
    if (/[A-Za-z]/.test(s[i + 2] || '')) {
      const end = s.indexOf('>', i + 2);
      if (end === -1) return null;
      return [s.slice(i, end + 1), end + 1];
    }
    return null;
  }
  if (s[i + 1] === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return [s.slice(i, end + 2), end + 2];
  }
  // Open or closing tag.
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (!/[A-Za-z]/.test(s[j] || '')) return null;
  const nameStart = j;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  const name = s.slice(nameStart, j).toLowerCase();
  void name;
  // A closing tag takes no attributes: `</a href="foo">` is text.
  // Whitespace before the `>` is allowed (`</a >` is a tag).
  if (closing) {
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '>') return [s.slice(i, k + 1), k + 1];
    return null;
  }
  // Attributes: space-separated name[=value] where value is unquoted,
  // single- or double-quoted. An attribute must be preceded by
  // whitespace: `<a href='bar'title=title>` is not a tag (no space
  // between the attributes), and neither is `<m:abc>` (no space
  // between the tag name and what follows it).
  while (j < n) {
    // Skip whitespace (spaces, tabs, newlines).
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k >= n) return null;
    const ch = s[k];
    if (ch === '>') return [s.slice(i, k + 1), k + 1];
    if (ch === '/' && s[k + 1] === '>') return [s.slice(i, k + 2), k + 2];
    // An attribute name, which needs whitespace before it. Attribute
    // names may start with a letter, _ or :.
    if (k === j) return null;
    if (!/[A-Za-z_:]/.test(ch) && ch !== '/') return null;
    if (ch === '/') return null;
    j = k;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    if (j === k) return null;
    // Optional =value.
    let m = j;
    while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
    if (s[m] === '=') {
      m++;
      while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
      const q = s[m];
      if (q === '"' || q === "'") {
        m++;
        const close = s.indexOf(q, m);
        if (close === -1) return null;
        j = close + 1;
      } else {
        // Unquoted value: up to whitespace, ", ', =, <, >, `.
        let v = m;
        while (v < n && !/[ \t\n"'=<>\`]/.test(s[v])) v++;
        if (v === m) return null;
        j = v;
      }
    } else {
      // No value: leave j at the end of the attribute name, so the
      // whitespace that separates it from the next attribute is still
      // there for the next pass to skip (and to require).
    }
  }
  return null;
}

function scanAutolink(s, i) {
  // <scheme:...> or <email>. Returns {href, text, next} or null.
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  // Email: local@domain (no spaces, no < >).
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}: then anything but space, <, >.
  let k = j;
  while (k < n && /[A-Za-z0-9+.\-_]/.test(s[k])) k++;
  if (k > j && s[k] === ':' && k - j >= 2 && /[A-Za-z]/.test(s[j])) {
    // Scheme autolink: scheme must be 2..32 chars.
    if (k - j > 32) return null;
    let m = k + 1;
    while (m < n && s[m] !== '>' && s[m] !== ' ' && s[m] !== '\n' && s[m] !== '<') m++;
    if (m >= n || s[m] !== '>') return null;
    const text = s.slice(j, m);
    if (text.length === 0) return null;
    return { href: text, text, next: m + 1 };
  }
  // Email form: scan to '>' for an address with exactly one @.
  let m = j;
  let at = -1;
  while (m < n && s[m] !== '>' && s[m] !== ' ' && s[m] !== '\n' && s[m] !== '<') {
    if (s[m] === '@') at = m;
    m++;
  }
  if (m >= n || s[m] !== '>' || at === -1) return null;
  const addr = s.slice(j, m);
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(addr)) {
    return null;
  }
  return { href: 'mailto:' + addr, text: addr, next: m + 1 };
}

// --- GFM extended autolinks -----------------------------------------------

function trimGfmUrl(u) {
  // Trim trailing punctuation from an extended autolink, per the GFM rules:
  // trailing ? ! . , : ; * _ ~ are dropped; trailing ) is dropped while the
  // parens are unbalanced; a trailing ; drops the whole &xxx; when xxx is
  // not a real entity; a trailing & ends the link before the &.
  let end = u.length;
  while (end > 0) {
    const ch = u[end - 1];
    if (ch === ';') {
      // Find the & that starts this ; sequence.
      let a = end - 2;
      while (a >= 0 && /[A-Za-z0-9#]/.test(u[a])) a--;
      if (a >= 0 && u[a] === '&') {
        const name = u.slice(a + 1, end - 1);
        if (KNOWN_ENTITIES.has(name) || /^#\d{1,7}$/.test(name) || /^#[Xx][0-9a-fA-F]{1,6}$/.test(name)) {
          break; // a real entity: keep it
        }
        end = a; // drop the whole &xxx;
        continue;
      }
      end--;
      continue;
    }
    if (ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === '*' || ch === '_' || ch === '~') {
      end--;
      continue;
    }
    if (ch === ')') {
      // Count parens in the kept part; drop ) while it would unbalance.
      let open = 0, close = 0;
      for (let p = 0; p < end; p++) {
        if (u[p] === '(') open++;
        else if (u[p] === ')') close++;
      }
      if (close > open) { end--; continue; }
      break;
    }
    if (ch === '&') { end--; continue; }
    break;
  }
  return u.slice(0, end);
}

function scanGfmAutolink(s, i) {
  // www. / scheme:// / scheme:email / email autolinks, starting at s[i].
  // Returns {href, text, next} or null.
  const n = s.length;
  const rest = s.slice(i);
  // A scheme followed by an email (mailto:foo@bar.baz, xmpp:foo@bar.baz)
  // links as a whole, scheme included, with an optional path after the
  // email (xmpp:foo@bar.baz/txt). The word boundary and the trailing
  // -/_ rules are the same as for a bare email.
  const sm = rest.match(/^([A-Za-z][A-Za-z0-9+.-]{1,31}):([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?:\/[^/\s<]+)?)/);
  if (sm) {
    let cand = trimGfmUrl(sm[0]);
    if (cand.length === 0) return null;
    const last = cand[cand.length - 1];
    if (last === '-' || last === '_') return null;
    const after = rest[cand.length];
    if (after === '-' || after === '_') return null;
    if (i > 0) {
      const prev = s[i - 1];
      if (/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(prev)) return null;
    }
    return { href: cand, text: cand, next: i + cand.length };
  }
  // Email first (it can start with a letter, so check the word shape).
  let m = rest.match(/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/);
  if (m) {
    const cand = m[0];
    const last = cand[cand.length - 1];
    // A trailing - or _ kills the autolink entirely, whether it is the
    // last character matched or the very next character after the
    // match (the domain regex stops before a trailing - or _).
    if (last === '-' || last === '_') return null;
    const after = rest[cand.length];
    if (after === '-' || after === '_') return null;
    // The char before must be a word boundary (start, whitespace or punctuation
    // that is not part of an email, e.g. '(').
    if (i > 0) {
      const prev = s[i - 1];
      if (/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(prev)) return null;
    }
    return { href: 'mailto:' + cand, text: cand, next: i + cand.length };
  }
  // www. or scheme://
  let scheme = null;
  let start = -1;
  if (rest.startsWith('www.')) {
    scheme = 'http://';
    start = i + 4;
  } else {
    const sm = rest.match(/^[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\//);
    if (sm) {
      scheme = '';
      start = i + sm[0].length;
    }
  }
  if (start === -1) return null;
  // The domain must contain a dot, and the character before the match must
  // not be a letter/digit (word boundary).
  if (i > 0) {
    const prev = s[i - 1];
    if (/[A-Za-z0-9]/.test(prev)) return null;
    if (scheme === 'http://' && prev === '/') return null;
  }
  // Consume the URL: up to whitespace or '<'.
  let j = start;
  while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '<') j++;
  let raw = s.slice(i, j);
  // Trim trailing punctuation first: a trailing dot is not part of the
  // host (www.commonmark.org. links to www.commonmark.org), so the
  // host check below must see the trimmed form.
  const trimmed = trimGfmUrl(raw);
  if (trimmed.length === 0) return null;
  // The domain part (up to the first /, ?, # or end, after the scheme)
  // must contain a dot whose following part has a letter, and must not
  // end with a dot.
  const hostStart = scheme === 'http://' ? 4 : trimmed.indexOf('://') + 3;
  const afterHost = trimmed.slice(hostStart);
  const hostEndRel = afterHost.search(/[\/?#]/);
  const host = hostEndRel === -1 ? afterHost : afterHost.slice(0, hostEndRel);
  if (!/\./.test(host)) return null;
  const labels = host.split('.');
  if (labels.some((l) => l.length === 0)) return null;
  const tld = labels[labels.length - 1];
  if (!/[A-Za-z]/.test(tld)) return null;
  // Re-derive the end after trimming.
  const end = i + trimmed.length;
  const href = (scheme === 'http://' ? 'http://' : '') + trimmed;
  return { href, text: trimmed, next: end };
}

// --- link destinations and titles -----------------------------------------

function parseLinkDestination(s, i) {
  // Parse a link destination at s[i] (after the '('). Returns
  // {href, next} where next is the index just past the destination, or null.
  const n = s.length;
  let j = i;
  if (s[j] === '<') {
    j++;
    let k = j;
    while (k < n && s[k] !== '>') {
      if (s[k] === '\n' || s[k] === '<') return null;
      if (s[k] === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) k += 2;
      else k++;
    }
    if (k >= n) return null;
    let href = s.slice(j, k);
    href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    return { href, next: k + 1 };
  }
  // Bare destination: no spaces, no control chars; balanced parens.
  let depth = 0;
  let k = j;
  while (k < n) {
    const ch = s[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    if (ch === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { k += 2; continue; }
    if (ch === '(') { depth++; k++; continue; }
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
      k++;
      continue;
    }
    if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) break;
    k++;
  }
  if (k === j || depth !== 0) return null;
  let href = s.slice(j, k);
  href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  return { href, next: k };
}

function parseLinkTitle(s, i) {
  // Parse a link title at s[i] (after the destination and whitespace).
  // Returns {title, next} or null. A title may span lines.
  const n = s.length;
  let j = i;
  const q = s[j];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  j++;
  let out = '';
  while (j < n) {
    const ch = s[j];
    if (ch === close) return { title: out, next: j + 1 };
    if (ch === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    out += ch;
    j++;
  }
  return null;
}

function skipInlineWhitespace(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
  return j;
}

// Try to parse "(dest title)" starting at s[i] === '('. Returns
// {href, title, next} or null.
function parseInlineLinkTail(s, i) {
  if (s[i] !== '(') return null;
  const n = s.length;
  let j = i + 1;
  j = skipInlineWhitespace(s, j);
  if (j >= n) return null;
  // An empty destination, (), is a link to the empty URL.
  if (s[j] === ')') return { href: '', title: null, next: j + 1 };
  const dest = parseLinkDestination(s, j);
  if (!dest) return null;
  let href = dest.href;
  let next = dest.next;
  let title = null;
  // Optional whitespace then an optional title, then optional whitespace
  // and the closing ')'.
  let k = skipInlineWhitespace(s, next);
  if (k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const t = parseLinkTitle(s, k);
    if (!t) return null;
    title = t.title;
    k = skipInlineWhitespace(s, t.next);
  }
  if (k >= n || s[k] !== ')') return null;
  return { href, title, next: k + 1 };
}

// Find the end of a bracketed label starting at s[i] === '['.
// A label may not hold an unescaped '[' or ']' (escaped ones and code
// spans are skipped). Returns the index of the closing ']' or -1.
function findLabelEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < n) { j += 2; continue; }
    if (ch === '`') {
      let k = j;
      while (k < n && s[k] === '`') k++;
      const span = scanCodeSpan(s, j, k - j);
      if (span) { j = span[1]; continue; }
      j = k;
      continue;
    }
    if (ch === '[') return -1;
    if (ch === ']') return j;
    j++;
  }
  return -1;
}

// --- flanking (for emphasis delimiters) ------------------------------------

function flank(s, runStart, runEnd, ch) {
  // runStart..runEnd is a delimiter run in s. Returns [leftFlanking,
  // rightFlanking, beforeIsPunct, afterIsPunct].
  //
  // For `_` the start and the end of the run count as whitespace in
  // both formulas: an opening `_` at the very start must not be
  // right-flanking, or its canOpen (left and not right) would be false.
  //
  // For `*` and `~` the edges are asymmetric: the start counts as
  // whitespace for the left-flanking formula but not for the
  // right-flanking one, and the end counts as whitespace for the
  // right-flanking formula but not for the left-flanking one. That
  // makes a `*` at the very start both left- and right-flanking (so
  // the rule of 3 fires for `**a*b**`), while a `*` at the start
  // followed by punctuation is still left-flanking (so `*(*foo*)*`
  // opens its outer emphasis).
  const before = runStart > 0 ? s[runStart - 1] : '';
  const after = runEnd < s.length ? s[runEnd] : '';
  const atStart = runStart === 0;
  const atEnd = runEnd === s.length;
  const beforePunct = before !== '' && isUnicodePunct(before);
  const afterPunct = after !== '' && isUnicodePunct(after);
  let beforeWsL, afterWsL, beforeWsR, afterWsR;
  if (ch === '_') {
    beforeWsL = beforeWsR = atStart ? true : /\s/.test(before);
    afterWsL = afterWsR = atEnd ? true : /\s/.test(after);
  } else {
    beforeWsL = atStart ? true : /\s/.test(before);
    afterWsL = atEnd ? true : /\s/.test(after);
    beforeWsR = atStart ? false : /\s/.test(before);
    afterWsR = atEnd ? true : /\s/.test(after);
  }
  const leftFlanking =
    !afterWsL && (!afterPunct || beforeWsL || beforePunct);
  const rightFlanking =
    !beforeWsR && (!beforePunct || afterWsR || afterPunct);
  return [leftFlanking, rightFlanking, beforePunct, afterPunct];
}

// --- the inline scanner -----------------------------------------------------

function scanInline(src, refs, allowLinks, allowImages = allowLinks) {
  // Scans src into a node list (emphasis not yet resolved). Returns the
  // node list; callers run resolveEmphasis on it and then render it.
  // allowLinks gates [...] links; allowImages gates ![...] images. A
  // link's text is scanned with images only (a link may hold an image
  // but not another link); an image's alt is scanned with both.
  const n = src.length;
  const nodes = [];
  const delims = []; // delimiter nodes, in document order
  const brackets = []; // {nodeIdx, image, pos}
  let buf = '';
  let i = 0;

  function flush() {
    if (buf.length > 0) {
      nodes.push({ k: 't', s: buf });
      buf = '';
    }
  }

  function dropRangeNodes(fromIdx) {
    // Remove nodes[fromIdx..] from the list (they are being re-parsed as
    // the inside of a link/image), and drop their delimiters and brackets.
    const removed = nodes.splice(fromIdx);
    if (removed.length > 0) {
      const gone = new Set(removed);
      for (let d = delims.length - 1; d >= 0; d--) {
        if (gone.has(delims[d])) delims.splice(d, 1);
      }
    }
    for (let b = brackets.length - 1; b >= 0; b--) {
      if (brackets[b].nodeIdx >= fromIdx) brackets.splice(b, 1);
    }
  }

  function tryFormLink(bracket, closeIdx) {
    // bracket is the top opener; closeIdx is the index of ']'.
    // Returns the index to continue scanning from, or -1 when no link forms.
    const labelRaw = src.slice(bracket.pos + 1, closeIdx);
    // A link may not contain another link; an image may hold links and
    // images (their text becomes the alt).
    if (!bracket.image) {
      for (let x = bracket.nodeIdx + 1; x < nodes.length; x++) {
        const nd = nodes[x];
        if (nd.k === 'a' && nd.br) return -1;
      }
    }
    let href = null;
    let title = null;
    let next = -1;
    const tail = parseInlineLinkTail(src, closeIdx + 1);
    if (tail) {
      href = tail.href;
      title = tail.title;
      next = tail.next;
    } else if (labelRaw.length > 0 && src[closeIdx + 1] === '[') {
      const end = findLabelEnd(src, closeIdx + 1);
      if (end !== -1) {
        const lab = src.slice(closeIdx + 2, end);
        if (validLabel(lab)) {
          const ref = refs.get(normalizeLabel(lab));
          if (ref) {
            href = ref.href;
            title = ref.title;
            next = end + 1;
          } else {
            // A full reference link was attempted ([foo][bar]) but its
            // label is not defined: the text is literal, and it must
            // not fall back to a shortcut link. ([foo][bar][baz] leaves
            // [foo] literal and links [bar][baz].)
            return -1;
          }
        }
      }
    }
    if (href === null && src[closeIdx + 1] === '[' && src[closeIdx + 2] === ']') {
      const ref = refs.get(normalizeLabel(labelRaw));
      if (ref) {
        href = ref.href;
        title = ref.title;
        next = closeIdx + 3;
      }
    }
    if (href === null) {
      if (validLabel(labelRaw)) {
        const ref = refs.get(normalizeLabel(labelRaw));
        if (ref) {
          href = ref.href;
          title = ref.title;
          next = closeIdx + 1;
        }
      }
    }
    if (href === null) return -1;
    const clean = cleanUrl(href);
    if (clean === null) return -1;
    // A link's text holds images but not links; an image's alt holds both.
    const kids = bracket.image
      ? scanInline(labelRaw, refs, true, true)
      : scanInline(labelRaw, refs, false, true);
    resolveEmphasis(kids);
    // The text buffer holds the link text, which the link node now
    // carries: drop it with the range nodes. For an image, the '!'
    // just before the bracket is part of the opener: drop it too.
    buf = '';
    let dropIdx = bracket.nodeIdx;
    if (bracket.image) {
      const prev = nodes[dropIdx - 1];
      if (prev && prev.k === 't' && prev.s.endsWith('!')) {
        prev.s = prev.s.slice(0, -1);
        if (prev.s === '') {
          nodes.splice(dropIdx - 1, 1);
          dropIdx -= 1;
        }
      }
    }
    dropRangeNodes(dropIdx);
    if (bracket.image) {
      const alt = stripNodes(kids);
      nodes.push({ k: 'i', href: clean, title, alt });
    } else {
      nodes.push({ k: 'a', href: clean, title, kids, br: true });
    }
    return next;
  }

  while (i < n) {
    const ch = src[i];

    // Backslash escapes and hard breaks.
    if (ch === '\\') {
      if (i + 1 < n && src[i + 1] === '\n') {
        flush();
        nodes.push({ k: 'b' });
        i += 2;
        // A hard break drops the next line's leading spaces too.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(src[i + 1])) {
        // An escaped & is a literal ampersand, not the start of an
        // entity: it must render as &amp; even when `&word;` follows,
        // so it goes out as already-escaped raw text rather than
        // through the buffer (whose escaper would leave it alone).
        if (src[i + 1] === '&') {
          flush();
          nodes.push({ k: 'h', s: '&amp;' });
        } else {
          buf += src[i + 1];
        }
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }

    // Code spans.
    if (ch === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      const span = scanCodeSpan(src, i, run);
      if (span) {
        flush();
        nodes.push({ k: 'c', s: span[0] });
        i = span[1];
        continue;
      }
      buf += src.slice(i, j);
      i = j;
      continue;
    }

    // Character references: numeric ones decode, named ones pass through.
    if (ch === '&') {
      const dec = decodeNumericEntity(src, i);
      if (dec) {
        buf += dec[0];
        i = dec[1];
        continue;
      }
      buf += '&';
      i++;
      continue;
    }

    // Autolinks and inline HTML.
    if (ch === '<') {
      const auto = scanAutolink(src, i);
      if (auto) {
        const clean = cleanUrl(auto.href);
        if (clean !== null) {
          flush();
          nodes.push({
            k: 'a',
            href: clean,
            title: null,
            kids: [{ k: 't', s: auto.text }],
            br: false,
          });
          i = auto.next;
          continue;
        }
      }
      const tag = scanHtmlTag(src, i);
      if (tag) {
        flush();
        nodes.push({ k: 'h', s: tag[0] });
        i = tag[1];
        continue;
      }
      buf += '<';
      i++;
      continue;
    }

    // Emphasis / strikethrough delimiters.
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i;
      while (j < n && src[j] === ch) j++;
      const len = j - i;
      if (ch === '~' && len >= 3) {
        buf += src.slice(i, j);
        i = j;
        continue;
      }
      const fl = flank(src, i, j, ch);
      const left = fl[0];
      const right = fl[1];
      const beforePunct = fl[2];
      const afterPunct = fl[3];
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = left && (!right || beforePunct);
        canClose = right && (!left || afterPunct);
      } else {
        canOpen = left;
        canClose = right;
      }
      flush();
      const nd = { k: 'd', ch, len, canOpen, canClose };
      nodes.push(nd);
      delims.push(nd);
      i = j;
      continue;
    }

    // Brackets: links and images.
    if (ch === '[' && allowLinks) {
      flush();
      const nd = { k: '[', image: false, pos: i };
      brackets.push({ nodeIdx: nodes.length, image: false, pos: i });
      nodes.push(nd);
      i++;
      continue;
    }
    if (ch === '!' && src[i + 1] === '[' && allowImages) {
      // The '!' is text unless the image forms; keep it in the stream
      // so a failed image leaves it behind as a literal '!'.
      buf += '!';
      flush();
      const nd = { k: '[', image: true, pos: i + 1 };
      brackets.push({ nodeIdx: nodes.length, image: true, pos: i + 1 });
      nodes.push(nd);
      i += 2;
      continue;
    }
    if (ch === ']' && (allowLinks || allowImages) && brackets.length > 0) {
      const bracket = brackets[brackets.length - 1];
      const next = tryFormLink(bracket, i);
      if (next !== -1) {
        // tryFormLink already dropped this opener (and everything inside
        // it) from the stack when the link formed.
        i = next;
        continue;
      }
      // No link: the bracket becomes literal text and leaves the stack.
      brackets.pop();
      buf += ']';
      i++;
      continue;
    }

    // Hard breaks: two or more spaces before a newline. The next
    // line's leading spaces are dropped after a hard break (but not
    // after a soft break).
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j - i >= 2 && src[j] === '\n') {
        flush();
        nodes.push({ k: 'b' });
        i = j + 1;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      buf += src.slice(i, j);
      i = j;
      continue;
    }

    // Soft breaks.
    if (ch === '\n') {
      flush();
      nodes.push({ k: 's' });
      i++;
      continue;
    }

    // GFM extended autolinks at word starts.
    if (
      (ch === 'w' && src.startsWith('www.', i)) ||
      (isAlnum(ch) && (i === 0 || !isAlnum(src[i - 1])))
    ) {
      const g = scanGfmAutolink(src, i);
      if (g) {
        const clean = cleanUrl(g.href);
        if (clean !== null) {
          flush();
          nodes.push({
            k: 'a',
            href: clean,
            title: null,
            kids: [{ k: 't', s: g.text }],
            br: false,
          });
          i = g.next;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return nodes;
}

// Plain text of an inline node list, for image alt text: emphasis and
// links contribute their text, a nested image contributes its own alt,
// raw HTML stays as text, a soft break is a newline, and a hard break
// contributes nothing.
function stripNodes(list) {
  let out = '';
  for (const nd of list) {
    switch (nd.k) {
      case 't':
      case 'c':
      case 'h':
        out += nd.s;
        break;
      case 'e':
      case 'a':
        out += stripNodes(nd.kids);
        break;
      case 'i':
        out += nd.alt;
        break;
      case 'd':
        out += nd.ch.repeat(nd.len);
        break;
      case '[':
        out += '[';
        break;
      case 's':
        out += '\n';
        break;
      default:
        // 'b' (hard break) contributes nothing.
        break;
    }
  }
  return out;
}

// --- emphasis resolution ----------------------------------------------------
// The CommonMark delimiter algorithm: walk the delimiter nodes in document
// order; for each one that can close, look back for the nearest opener of
// the same character that can open (skipping pairs the odd-match rule
// forbids), and wrap the nodes between them in em / strong / del.

function resolveEmphasis(nodes) {
  // Link the delimiter nodes into a doubly linked list, in document order.
  let first = null;
  let last = null;
  for (const nd of nodes) {
    if (nd.k === 'd') {
      nd.dp = last;
      nd.dn = null;
      if (last) last.dn = nd;
      else first = nd;
      last = nd;
    }
  }
  let current = first;
  while (current) {
    if (!current.canClose) {
      current = current.dn;
      continue;
    }
    const ch = current.ch;
    // Find the nearest opener before current. The search always runs
    // back to the start of the list: a delimiter that the rule of 3
    // blocked for one closer can still open for a later one (e.g. in
    // `**a*b*c**` the opening `**` is blocked for the inner `*` but
    // pairs with the closing `**`), so no bottom pointer is kept.
    //
    // When the nearest opener is ambiguous -- it can both open and
    // close -- a closer prefers a farther opener of the same length
    // (a full match, never blocked by the rule of 3, whose sum is
    // even): marked pairs `**a*b**` as strong rather than letting the
    // inner `*` steal the closer, and `*foo**bar*` as em. But when
    // the nearest opener can only open (it cannot close), the closer
    // pairs with it directly, e.g. `**foo *bar** baz*` pairs the
    // `*` before `bar` with the `**` after it.
    let opener = current.dp;
    let nearest = null;
    while (opener) {
      if (opener.ch === ch && opener.canOpen) { nearest = opener; break; }
      opener = opener.dp;
    }
    let found = null;
    if (nearest && nearest.canClose && nearest.len !== current.len) {
      opener = nearest.dp;
      while (opener) {
        if (opener.ch === ch && opener.canOpen && opener.len === current.len) {
          found = opener;
          break;
        }
        opener = opener.dp;
      }
    }
    if (!found) {
      opener = current.dp;
      while (opener) {
        if (opener.ch === ch && opener.canOpen) {
          const bothWays = opener.canClose && current.canOpen;
          if (!(bothWays && (opener.len + current.len) % 2 === 1)) {
            found = opener;
            break;
          }
        }
        opener = opener.dp;
      }
    }
    if (!found) {
      current = current.dn;
      continue;
    }
    const use = found.len >= 2 && current.len >= 2 ? 2 : 1;
    const tag = ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const oi = nodes.indexOf(found);
    const ci = nodes.indexOf(current);
    const kids = nodes.slice(oi + 1, ci);
    const emNode = { k: 'e', tag, kids };
    // Unlink every delimiter strictly between opener and closer: those
    // nodes now live inside the new emphasis node.
    let d = found.dn;
    while (d && d !== current) {
      const nx = d.dn;
      d.dp = null;
      d.dn = null;
      d = nx;
    }
    const before = found.dp;
    const after = current.dn;
    found.len -= use;
    current.len -= use;
    // Rebuild the node slice: a leftover opener, the emphasis node, and a
    // leftover closer.
    const replacement = [];
    if (found.len > 0) replacement.push(found);
    replacement.push(emNode);
    if (current.len > 0) replacement.push(current);
    nodes.splice(oi, ci - oi + 1, ...replacement);
    // Relink the delimiter list around the wrapped range.
    if (found.len > 0) {
      found.dp = before;
      found.dn = current.len > 0 ? current : after;
      if (before) before.dn = found;
      else first = found;
    } else {
      if (before) before.dn = current.len > 0 ? current : after;
      else first = current.len > 0 ? current : after;
    }
    if (current.len > 0) {
      current.dp = found.len > 0 ? found : before;
      current.dn = after;
      if (after) after.dp = current;
      else last = current;
    } else {
      if (after) after.dp = found.len > 0 ? found : before;
      else last = found.len > 0 ? found : before;
    }
    // A wrap may have removed the node an openers-bottom pointer named.
    if (current.len === 0) {
      current = after;
    }
    // Otherwise current keeps its remaining length and is considered again.
  }
  // Any delimiter left over is literal text.
  for (const nd of nodes) {
    if (nd.k === 'd') {
      nd.k = 't';
      nd.s = nd.ch.repeat(nd.len);
      delete nd.ch;
      delete nd.len;
      delete nd.canOpen;
      delete nd.canClose;
      delete nd.dp;
      delete nd.dn;
    }
  }
}

// --- rendering inline nodes -------------------------------------------------

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 't':
        out += escText(nd.s);
        break;
      case 'c':
        out += '<code>' + escFull(nd.s) + '</code>';
        break;
      case 'h':
        out += nd.s;
        break;
      case 'b':
        out += '<br>';
        break;
      case 's':
        out += '\n';
        break;
      case 'd':
        out += escText(nd.ch.repeat(nd.len));
        break;
      case '[':
        out += '[';
        break;
      case 'a': {
        out += '<a href="' + escText(nd.href) + '"';
        if (nd.title !== null && nd.title !== undefined) {
          out += ' title="' + escText(nd.title) + '"';
        }
        out += '>' + renderNodes(nd.kids) + '</a>';
        break;
      }
      case 'i': {
        // The alt text is already escaped HTML with its tags stripped, so
        // it only needs the no-encode escape (a & that already starts an
        // entity reference stays as it is).
        out += '<img src="' + escText(nd.href) + '" alt="' + escText(nd.alt) + '"';
        if (nd.title !== null && nd.title !== undefined) {
          out += ' title="' + escText(nd.title) + '"';
        }
        out += '>';
        break;
      }
      case 'e':
        out += '<' + nd.tag + '>' + renderNodes(nd.kids) + '</' + nd.tag + '>';
        break;
      default:
        break;
    }
  }
  return out;
}

// Parse one inline run (a paragraph's text, a heading's text, a table
// cell) into HTML. refs maps normalized labels to {href, title}.
function inlineToHtml(src, refs) {
  const nodes = scanInline(src, refs, true);
  resolveEmphasis(nodes);
  return renderNodes(nodes);
}

/* ===========================================================================
   Block parsing
   =========================================================================== */

// --- line cursor helpers ----------------------------------------------------
// Lines are raw strings. A "column" counts a tab as advancing to the next
// multiple of four. When a tab is only partly consumed by an indentation
// strip, the line is rewritten with the tab turned into spaces.

function colOf(line, idx) {
  let col = 0;
  for (let p = 0; p < idx && p < line.length; p++) {
    if (line[p] === '\t') col += 4 - (col % 4);
    else col++;
  }
  return col;
}

// Advance (pos, col) over spaces and tabs until col >= target (or the line
// ends). Returns [line, pos, col]; the line may be rewritten when a tab is
// only partly consumed.
function advanceTo(line, pos, col, target) {
  while (pos < line.length && col < target) {
    const ch = line[pos];
    if (ch === ' ') {
      pos++;
      col++;
    } else if (ch === '\t') {
      const next = col + (4 - (col % 4));
      if (next > target) {
        const spaces = next - col;
        line = line.slice(0, pos) + ' '.repeat(spaces) + line.slice(pos + 1);
        pos += target - col;
        col = target;
        return [line, pos, col];
      }
      pos++;
      col = next;
    } else {
      break;
    }
  }
  return [line, pos, col];
}

// Skip spaces and tabs from (pos, col); returns [pos, col].
function skipSpaces(line, pos, col) {
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === ' ') {
      pos++;
      col++;
    } else if (ch === '\t') {
      pos++;
      col += 4 - (col % 4);
    } else {
      break;
    }
  }
  return [pos, col];
}

function isBlankLine(line, pos) {
  for (let p = pos; p < line.length; p++) {
    if (line[p] !== ' ' && line[p] !== '\t') return false;
  }
  return true;
}

// --- link reference definitions -------------------------------------------
// A paragraph may open with reference definitions. Each one is
//   [label]: destination "optional title"
// with the destination and the title each allowed on a following line.
// The first definition of a label wins. A definition consumes its lines;
// what is left becomes the paragraph's text.

function parseRefDefAt(text, i, refs) {
  const n = text.length;
  let j = i;
  let spaces = 0;
  while (j < n && text[j] === ' ' && spaces < 3) {
    j++;
    spaces++;
  }
  if (j < n && (text[j] === ' ' || text[j] === '\t')) return null;
  if (text[j] !== '[') return null;
  const end = findLabelEnd(text, j);
  if (end === -1) return null;
  const labelRaw = text.slice(j + 1, end);
  if (!validLabel(labelRaw)) return null;
  let k = end + 1;
  if (text[k] !== ':') return null;
  k++;
  k = skipInlineWhitespace(text, k);
  if (k >= n) return null;
  let href;
  if (text[k] === '<') {
    let m = k + 1;
    while (m < n && text[m] !== '>') {
      if (text[m] === '\n' || text[m] === '<') return null;
      if (text[m] === '\\' && m + 1 < n && isAsciiPunct(text[m + 1])) m += 2;
      else m++;
    }
    if (m >= n) return null;
    href = text.slice(k + 1, m).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    k = m + 1;
  } else {
    const d = parseLinkDestination(text, k);
    if (!d) return null;
    href = d.href;
    k = d.next;
  }
  // After the destination, an optional title may follow, but only when
  // separated from the destination by whitespace: a title glued to the
  // destination, like <bar>(baz), is not a title at all, and the line is
  // not a definition. The title may sit on the next line. Without a
  // title the definition ends at the next line break, so a paragraph can
  // hold several definitions, one per line. When a title-like thing is
  // followed by junk on its line (`"title" ok`), the title is dropped
  // but the definition itself still stands, ending at the destination.
  const afterDest = k;
  const ahead = skipInlineWhitespace(text, afterDest);
  let title = null;
  let consumed = -1;
  // The no-title end: just past the destination's line.
  let e0 = afterDest;
  while (e0 < n && (text[e0] === ' ' || text[e0] === '\t')) e0++;
  let noTitleEnd = -1;
  if (e0 === n) noTitleEnd = n;
  else if (text[e0] === '\n') noTitleEnd = e0 + 1;
  if (
    ahead > afterDest &&
    ahead < n &&
    (text[ahead] === '"' || text[ahead] === "'" || text[ahead] === '(')
  ) {
    const t = parseLinkTitle(text, ahead);
    if (t) {
      title = t.title;
      let e = t.next;
      while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
      if (e === n) consumed = n;
      else if (text[e] === '\n') consumed = e + 1;
    }
    // A title followed by junk is dropped; the definition ends at the
    // destination instead of failing outright.
    if (consumed === -1 && noTitleEnd !== -1) {
      title = null;
      consumed = noTitleEnd;
    }
  } else {
    consumed = noTitleEnd;
  }
  if (consumed === -1) return null;
  const key = normalizeLabel(labelRaw);
  if (!refs.has(key)) refs.set(key, { href, title });
  return consumed;
}

function extractRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const r = parseRefDefAt(text, pos, refs);
    if (r === null) break;
    pos = r;
  }
  return text.slice(pos);
}

// --- table rows ---------------------------------------------------------------

function splitTableRow(s) {
  // Split a table row on unescaped pipes outside code spans. Leading and
  // trailing empty cells (from edge pipes) are dropped.
  const cells = [];
  let cur = '';
  let i = 0;
  const n = s.length;
  let inCode = 0; // length of the open backtick run, 0 when not in code
  while (i < n) {
    const ch = s[i];
    if (ch === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const run = j - i;
      if (inCode === 0) {
        // A run only opens a code span when a matching run closes it
        // later in the row; an unclosed run is literal text, so a pipe
        // after it still separates cells.
        let k = j;
        let found = false;
        while (k < n) {
          if (s[k] === '`') {
            let m = k;
            while (m < n && s[m] === '`') m++;
            if (m - k === run) {
              found = true;
              break;
            }
            k = m;
          } else {
            k++;
          }
        }
        if (found) inCode = run;
      } else if (inCode === run) {
        inCode = 0;
      }
      cur += s.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '\\' && i + 1 < n && s[i + 1] === '|') {
      // An escaped pipe is a literal pipe in the cell, not a separator.
      // The table level consumes the backslash even inside a code span:
      // `a \| b` in a cell renders as code containing `a | b`.
      cur += '|';
      i += 2;
      continue;
    }
    if (ch === '|' && inCode === 0) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur);
  // Drop a leading and a trailing empty cell (edge pipes).
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function parseTableDelimiter(s) {
  // Returns the alignment array, or null when s is not a delimiter row.
  const cells = splitTableRow(s);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    const m = /^:?-+:?$/.test(c);
    if (!m) return null;
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

// --- block-start detectors --------------------------------------------------
// Each takes (line, pos, col): pos is the first non-space character, col
// its column. indent is the whitespace width before it, already known to
// be at most 3 for these checks.

function matchAtx(line, pos) {
  if (line[pos] !== '#') return null;
  let j = pos;
  while (j < line.length && line[j] === '#') j++;
  const level = j - pos;
  if (level > 6) return null;
  if (j < line.length && line[j] !== ' ' && line[j] !== '\t') return null;
  // Skip the space(s) after the hashes.
  let k = j;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  let text = line.slice(k);
  // A closing sequence of #'s preceded by a space is stripped, and a
  // heading whose whole content is #'s (e.g. `### ###`) is empty: the
  // #'s are the closing sequence.
  text = text.replace(/ +#+ *$/, '').replace(/ +$/, '');
  if (/^#+$/.test(text)) text = '';
  return { level, text };
}

function matchFence(line, pos) {
  const ch = line[pos];
  if (ch !== '`' && ch !== '~') return null;
  let j = pos;
  while (j < line.length && line[j] === ch) j++;
  const len = j - pos;
  if (len < 3) return null;
  let info = line.slice(j).trim();
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len, info };
}

// HTML block start conditions. Returns {type, end} where type is 1..7 and
// end is the string that ends the block (for types 1-5), or null.
function matchHtmlBlock(line, pos) {
  const rest = line.slice(pos);
  const m1 = rest.match(/^<(script|pre|style|textarea)(?:[ \t>]|\/>|$)/i);
  if (m1) return { type: 1, end: '</' + m1[1].toLowerCase() };
  if (/^<!--/.test(rest)) return { type: 2, end: '-->' };
  if (/^<\?/.test(rest)) return { type: 3, end: '?>' };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4, end: '>' };
  if (/^<!\[CDATA\[/.test(rest)) return { type: 5, end: ']]>' };
  const m6 = rest.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|\/>|$)/);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6, end: null };
  // Type 7: a complete open tag or closing tag alone on the line. A
  // closing tag takes no attributes, so `</a href="foo">` is not one.
  if (/^<\/[A-Za-z][A-Za-z0-9-]*\s*>$/.test(rest)) {
    return { type: 7, end: null };
  }
  if (/^<[A-Za-z][A-Za-z0-9-]*(\s+[A-Za-z_:][A-Za-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>$/.test(rest)) {
    return { type: 7, end: null };
  }
  return null;
}

function matchThematic(line, pos) {
  // Only *, -, _ and spaces, with at least three of one marker.
  const rest = line.slice(pos);
  const m = rest.match(/^(?:[ \t]*([*\-_])[ \t]*\1[ \t]*\1(?:[ \t]*\1)*[ \t]*)$/);
  if (!m) return null;
  return m[1];
}

function matchSetext(line, pos) {
  const rest = line.slice(pos);
  if (/^=+[ \t]*$/.test(rest)) return 1;
  if (/^-+[ \t]*$/.test(rest)) return 2;
  return null;
}

function matchListMarker(line, pos, col) {
  const ch = line[pos];
  let markerLen = 0;
  let ordered = false;
  let start = 0;
  let delim = '';
  if (ch === '-' || ch === '+' || ch === '*') {
    markerLen = 1;
    // The bullet character is the delimiter: a list may not change it.
    delim = ch;
  } else if (isDigit(ch)) {
    let j = pos;
    while (j < line.length && isDigit(line[j])) j++;
    if (j - pos > 9) return null;
    if (line[j] !== '.' && line[j] !== ')') return null;
    ordered = true;
    start = parseInt(line.slice(pos, j), 10);
    delim = line[j];
    markerLen = j - pos + 1;
  } else {
    return null;
  }
  const after = line[pos + markerLen];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  // Whitespace after the marker.
  let p = pos + markerLen;
  let c = col + markerLen;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    if (line[p] === ' ') {
      p++;
      c++;
    } else {
      p++;
      c += 4 - (c % 4);
    }
  }
  const wsCols = c - (col + markerLen);
  const empty = p >= line.length;
  let contentCol;
  if (empty) contentCol = col + markerLen + 1;
  else if (wsCols >= 1 && wsCols <= 4) contentCol = c;
  else contentCol = col + markerLen + 1;
  return {
    ordered,
    start,
    delim,
    markerLen,
    contentPos: p,
    contentCol,
    empty,
    canInterrupt: !empty && (!ordered || start === 1),
  };
}

// --- the block parser ---------------------------------------------------------

// --- the block parser ---------------------------------------------------------

function parseBlocks(src, refs) {
  const normalized = src.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // The input's last line has a terminator only when the input ends with
  // one; a trailing empty element after the final newline is not a line.
  const inputEndsWithNewline = normalized.endsWith('\n');
  const realLineCount = inputEndsWithNewline ? lines.length - 1 : lines.length;
  const root = { t: 'doc', children: [] };
  const stack = [root]; // open containers, then optionally one leaf
  // Whether a blank line is waiting to separate two blocks, and the
  // innermost container it occurred in. A list is loose when a blank
  // line separates two of its items, or two blocks directly inside one
  // of its items; the blank only counts for the list it occurred in.
  let pendingBlank = false;
  let blankNode = null;

  function isAncestorOrSelf(anc, node) {
    let cur = node;
    while (cur) {
      if (cur === anc) return true;
      cur = cur.parent;
    }
    return false;
  }

  // Called when a new block or item is added under parent: a pending
  // blank line makes the list loose when the new block sits where the
  // blank fell.
  function markLooseFor(parent, node) {
    if (!pendingBlank) return;
    if (node.t === 'item') {
      if (isAncestorOrSelf(parent, blankNode)) parent.tight = false;
    } else if (parent.t === 'item') {
      if (isAncestorOrSelf(parent, blankNode)) parent.parent.tight = false;
    }
    pendingBlank = false;
  }
  const isLeaf = (b) => b.t === 'para' || b.t === 'code' || b.t === 'html' || b.t === 'table';
  const tip = () => stack[stack.length - 1];
  const container = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!isLeaf(stack[i])) return stack[i];
    }
    return root;
  };

  function closeTo(idx) {
    while (stack.length > idx) finalize(stack.pop());
  }

  function finalize(b) {
    if (b.t === 'para') {
      const text = extractRefDefs(b.lines.join('\n'), refs);
      if (text.trim() === '') {
        const parent = b.parent;
        const at = parent.children.indexOf(b);
        if (at !== -1) parent.children.splice(at, 1);
        return;
      }
      b.text = text;
      delete b.lines;
    } else if (b.t === 'code') {
      // An indented block drops all trailing blank lines. A fenced
      // block drops only the one immediately before the closing fence;
      // earlier blank lines are content (cm-318).
      if (b.fenced) {
        if (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      } else {
        while (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
      b.text = b.lines.length === 0 ? '' : b.lines.join('\n') + '\n';
      delete b.lines;
    } else if (b.t === 'html') {
      // The block's last line keeps its newline in the source, unless
      // the block is followed by a blank line, or it is the input's last
      // line and the input has no final newline.
      let text = b.lines.join('\n');
      const nextIdx = (b.lastLineIdx ?? 0) + 1;
      let trailing = true;
      if (nextIdx < realLineCount && lines[nextIdx] === '') trailing = false;
      else if (nextIdx >= realLineCount && !inputEndsWithNewline) trailing = false;
      if (trailing) text += '\n';
      b.text = text;
      delete b.lines;
    }
  }

  function openBlock(node) {
    node.parent = container();
    node.parent.children.push(node);
    markLooseFor(node.parent, node);
    stack.push(node);
    return node;
  }

  function matchQuote(line, pos, col) {
    let p = pos;
    let c = col;
    let spaces = 0;
    while (p < line.length && spaces < 3) {
      if (line[p] === ' ') {
        p++;
        c++;
        spaces++;
      } else if (line[p] === '\t') {
        const next = c + (4 - (c % 4));
        if (next - col > 3) break;
        p++;
        c = next;
        spaces = next - col;
      } else {
        break;
      }
    }
    if (line[p] !== '>') return null;
    p++;
    c++;
    if (line[p] === ' ') {
      p++;
      c++;
    } else if (line[p] === '\t') {
      const r = advanceTo(line, p, c, c + 1);
      line = r[0];
      p = r[1];
      c = r[2];
    }
    return { line, pos: p, col: c };
  }

  function matchItem(item, line, pos, col, baseCol) {
    // Consume only up to the item's content indent. Any further
    // whitespace belongs to the content: a paragraph keeps it, and a
    // fenced code block has only the fence's indent stripped from it.
    let p = pos;
    let c = col;
    const target = baseCol + item.contentIndent;
    while (p < line.length && c < target && (line[p] === ' ' || line[p] === '\t')) {
      if (line[p] === ' ') {
        p++;
        c++;
      } else {
        const next = c + (4 - (c % 4));
        if (next > target) {
          const spaces = next - c;
          line = line.slice(0, p) + ' '.repeat(spaces) + line.slice(p + 1);
          p += target - c;
          c = target;
          return { line, pos: p, col: c };
        }
        p++;
        c = next;
      }
    }
    if (p >= line.length) return { line, pos: p, col: c };
    if (c < target) return null;
    return { line, pos: p, col: c };
  }

  // Whether a line begins a new block. Used when a container failed to
  // match: a line that begins a block does not lazily continue the
  // paragraph inside the failed container. Unlike interruptsParagraph,
  // any list marker counts here: once a container has failed, the
  // paragraph inside it is already detached, so a list marker starts a
  // new list whatever number it starts with.
  function beginsBlock(line, pos, col) {
    if (line[pos] === '#') return !!matchAtx(line, pos);
    if (line[pos] === '`' || line[pos] === '~') return !!matchFence(line, pos);
    if (line[pos] === '<') {
      const h = matchHtmlBlock(line, pos);
      return !!h && h.type >= 1 && h.type <= 6;
    }
    if (line[pos] === '*' || line[pos] === '-' || line[pos] === '_') {
      if (matchThematic(line, pos)) return true;
    }
    if (line[pos] === '>') return true;
    if (matchListMarker(line, pos, col)) return true;
    return false;
  }

  function interruptsParagraph(line, pos, col) {
    if (line[pos] === '#') return !!matchAtx(line, pos);
    if (line[pos] === '`' || line[pos] === '~') return !!matchFence(line, pos);
    if (line[pos] === '<') {
      const h = matchHtmlBlock(line, pos);
      return !!h && h.type >= 1 && h.type <= 6;
    }
    if (line[pos] === '*' || line[pos] === '-' || line[pos] === '_') {
      if (matchThematic(line, pos)) return true;
    }
    if (line[pos] === '>') return true;
    const lm = matchListMarker(line, pos, col);
    if (lm && lm.canInterrupt) return true;
    return false;
  }

  // Start a new block from the remainder of a line. st is
  // {line, pos, col, baseCol}. Returns a new state to process again (after
  // opening a blockquote, whose remainder still needs a block), or null
  // when the line is done.
  function startBlock(st) {
    let { line, pos, col, baseCol } = st;
    const li = st.li;
    let cpos = pos;
    let ccol = col;
    const skipped = skipSpaces(line, cpos, ccol);
    cpos = skipped[0];
    ccol = skipped[1];
    const indent = ccol - baseCol;
    if (cpos >= line.length) return null;

    if (indent >= 4) {
      const r = advanceTo(line, pos, col, baseCol + 4);
      openBlock({ t: 'code', fenced: false, info: '', lines: [r[0].slice(r[1])] });
      return null;
    }
    const fence = matchFence(line, cpos);
    if (fence) {
      openBlock({
        t: 'code',
        fenced: true,
        info: fence.info,
        fenceChar: fence.ch,
        fenceLen: fence.len,
        fenceIndent: indent,
        lines: [],
      });
      return null;
    }
    const atx = matchAtx(line, cpos);
    if (atx) {
      openBlock({ t: 'heading', level: atx.level, text: atx.text });
      closeTo(stack.length - 1);
      return null;
    }
    const html = matchHtmlBlock(line, cpos);
    if (html) {
      const node = {
        t: 'html',
        htmlType: html.type,
        endMarker: html.end,
        lines: [line.slice(pos)],
        lastLineIdx: st.li,
      };
      openBlock(node);
      // Types 1-5 close on the same line when the end marker is there.
      // Types 6 and 7 run on until a blank line.
      if (html.type <= 5 && line.slice(pos).toLowerCase().includes(html.end)) {
        closeTo(stack.length - 1);
      }
      return null;
    }
    if (matchThematic(line, cpos)) {
      openBlock({ t: 'hr' });
      closeTo(stack.length - 1);
      return null;
    }
    const lm = matchListMarker(line, cpos, ccol);
    if (lm) {
      let list = null;
      const top = tip();
      if (top.t === 'list' && top.ordered === lm.ordered && top._delim === lm.delim) {
        list = top;
      }
      if (!list) {
        list = {
          t: 'list',
          ordered: lm.ordered,
          start: lm.start,
          _delim: lm.delim,
          tight: true,
          children: [],
        };
        openBlock(list);
      }
      const item = {
        t: 'item',
        contentIndent: lm.contentCol - baseCol,
        task: null,
        children: [],
      };
      item.parent = list;
      list.children.push(item);
      markLooseFor(list, item);
      stack.push(item);
      if (lm.empty) return null;
      // Whether the first line's content is an indented code block is
      // judged from where the content starts after the marker, before
      // any task checkbox is stripped: a checkbox is content, not
      // indentation, so `- [ ] foo` is a paragraph, not code.
      const itemIndent = colOf(line, lm.contentPos) - lm.contentCol;
      if (itemIndent >= 4) {
        // Advance from just after the marker, not from the content:
        // the code starts four columns past the content indent, which
        // can sit inside the whitespace after the marker.
        const r = advanceTo(line, cpos + lm.markerLen, ccol + lm.markerLen, lm.contentCol + 4);
        openBlock({ t: 'code', fenced: false, info: '', lines: [r[0].slice(r[1])] });
        return null;
      }
      let contentStart = lm.contentPos;
      const content = line.slice(lm.contentPos);
      const tm = content.match(/^\[([ xX])\](?:[ \t]+|$)/);
      if (tm) {
        item.task = tm[1] === ' ' ? 'unchecked' : 'checked';
        const afterBox = lm.contentPos + tm[0].length;
        const r = skipSpaces(line, afterBox, colOf(line, afterBox));
        contentStart = r[0];
      }
      if (contentStart >= line.length) return null;
      // Let the content start its own block (fence, heading, paragraph,
      // nested list, ...) in a fresh pass, with the content edge as its
      // base, so a fenced code block or a heading inside an item works.
      return {
        line,
        pos: contentStart,
        col: colOf(line, contentStart),
        baseCol: colOf(line, contentStart),
        li,
      };
    }
    if (line[cpos] === '>') {
      const q = matchQuote(line, cpos, ccol);
      if (q) {
        openBlock({ t: 'quote', children: [] });
        return { line: q.line, pos: q.pos, col: q.col, baseCol: q.col, li };
      }
    }
    openBlock({ t: 'para', lines: [line.slice(pos)] });
    return null;
  }

  for (let li = 0; li < realLineCount; li++) {
    let line = lines[li];

    // -- Phase 1: match the open containers. --
    let pos = 0;
    let col = 0;
    let baseCol = 0;
    let failIdx = -1;
    let matchedContainer = false;
    let si = 1;
    while (si < stack.length) {
      const b = stack[si];
      if (b.t === 'quote') {
        const r = matchQuote(line, pos, col);
        if (!r) {
          failIdx = si;
          break;
        }
        matchedContainer = true;
        line = r.line;
        pos = r.pos;
        col = r.col;
        baseCol = col;
      } else if (b.t === 'list') {
        // A list matches when its item does; the item is next. If the
        // item was closed (e.g. an empty item ended by a blank line),
        // the list only matches a new item marker for itself; other
        // content falls outside the list (cm-280).
        if (si + 1 >= stack.length || stack[si + 1].t !== 'item') {
          const lm = matchListMarker(line, pos, col);
          const indentOk = col - baseCol <= 3;
          if (!lm || !indentOk || lm.ordered !== b.ordered || lm.delim !== b._delim) {
            failIdx = si;
            break;
          }
        }
      } else if (b.t === 'item') {
        const r = matchItem(b, line, pos, col, baseCol);
        if (!r) {
          failIdx = si;
          break;
        }
        matchedContainer = true;
        line = r.line;
        pos = r.pos;
        col = r.col;
        baseCol = baseCol + b.contentIndent;
      } else {
        break; // a leaf: containers end here
      }
      si++;
    }

    let leaf = stack.length > 1 && isLeaf(tip()) ? tip() : null;

    const restPos = () => {
      let p = pos;
      let c = col;
      while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
        if (line[p] === ' ') {
          p++;
          c++;
        } else {
          p++;
          c += 4 - (c % 4);
        }
      }
      return [p, c];
    };
    let rp = restPos();
    let cpos = rp[0];
    let ccol = rp[1];
    let indent = ccol - baseCol;
    // A line is blank when there is nothing after its containers. When
    // a container matched, anything left (even a single space) is
    // content: `>  ` continues the paragraph with one space. When no
    // container matched, only a non-space character counts as content,
    // so a whitespace-only line is blank.
    let blank = matchedContainer ? pos >= line.length : cpos >= line.length;

    // -- A container failed to match. --
    if (failIdx !== -1) {
      // A line that is a list marker for the list of the failed item
      // starts a new item there. That beats lazy paragraph continuation:
      // `1. foo` followed by `2. bar` is two items, even though an
      // ordered list starting at 2 cannot interrupt a paragraph. But a
      // thematic break is not a list item, even when it starts with a
      // marker character (`* * *` ends the list and becomes an <hr>).
      let newItem = false;
      const failed = stack[failIdx];
      if (failed.t === 'item') {
        const list = failed.parent;
        const lm = matchListMarker(line, cpos, ccol);
        // A list marker indented four or more spaces is not a new item
        // at all (it is paragraph text or an indented code block).
        if (lm && indent <= 3 && list.ordered === lm.ordered && list._delim === lm.delim && !matchThematic(line, cpos)) {
          newItem = true;
        }
      }
      if (!newItem && leaf && leaf.t === 'para' && !blank) {
        // A lazy line can never be a setext heading underline: the
        // underline has to sit inside the paragraph's own containers.
        // (`> Foo` followed by a bare `---` closes the quote and the
        // `---` becomes a thematic break; a bare `===` just stays in
        // the paragraph as text.)
        if (leaf.lines.length === 1) {
          const aligns = parseTableDelimiter(line.slice(cpos));
          const headCells = splitTableRow(leaf.lines[0]);
          if (aligns && headCells.length === aligns.length && leaf.lines[0].includes('|')) {
            const table = {
              t: 'table',
              head: headCells,
              align: aligns,
              rows: [],
              parent: leaf.parent,
            };
            const at = leaf.parent.children.indexOf(leaf);
            leaf.parent.children[at] = table;
            closeTo(failIdx);
            stack.push(table);
            continue;
          }
        }
        // A line indented four or more spaces cannot begin a block, so
        // a lazy line that indented stays in the paragraph as text
        // (e.g. `> foo` followed by `    - bar` keeps `- bar` in the
        // paragraph; a nested `- e` indented past its item stays too).
        // A lazy line indented four or more is dedented by exactly
        // four (the code-block indent), so `    - bar` joins as
        // `- bar` and `     bar` as ` bar`; a line indented fewer than
        // four keeps its spaces.
        if (indent >= 4 || !beginsBlock(line, cpos, ccol)) {
          if (indent >= 4) {
            const r = advanceTo(line, pos, col, col + 4);
            leaf.lines.push(r[0].slice(r[1]));
          } else {
            leaf.lines.push(line.slice(pos));
          }
          continue;
        }
      }
      closeTo(failIdx);
      leaf = null;
      // If the line did not start a new item, a list left open above the
      // failed item ends here too: the line does not belong to it, and a
      // paragraph may not be a direct child of a list.
      if (!newItem && tip().t === 'list') {
        closeTo(stack.length - 1);
      }
      rp = restPos();
      cpos = rp[0];
      ccol = rp[1];
      indent = ccol - baseCol;
      blank = cpos >= line.length;
    }

    // -- Blank lines. --
    if (blank) {
      if (leaf && leaf.t === 'code') {
        // A whitespace-only line inside a code block keeps the spaces
        // past the block's indent: an indented block drops four
        // columns, a fenced block drops its fence indent (a tab counts
        // as one character there, as for content lines).
        if (leaf.fenced) {
          let p = pos;
          let n = leaf.fenceIndent || 0;
          while (p < line.length && n > 0 && (line[p] === ' ' || line[p] === '\t')) {
            p++;
            n--;
          }
          leaf.lines.push(line.slice(p));
        } else {
          const r = advanceTo(line, pos, col, baseCol + 4);
          leaf.lines.push(r[0].slice(r[1]));
        }
      } else if (leaf && leaf.t === 'html' && leaf.htmlType <= 5) {
        // Types 1-5 run through blank lines: the blank is content of
        // the block, not its end.
        leaf.lines.push('');
        leaf.lastLineIdx = li;
      } else {
        // A real separator: remember where it fell for loose/tight.
        pendingBlank = true;
        blankNode = container();
        if (leaf) {
          closeTo(stack.length - 1);
          leaf = null;
        }
        // An empty list item is closed by a blank line: later indented
        // content falls outside the list (cm-280). A non-empty item
        // stays open.
        while (stack.length > 1 && tip().t === 'item' && tip().children.length === 0) {
          stack.pop();
        }
      }
      continue;
    }

    // -- An open leaf continues, or a new block starts. --
    if (leaf && leaf.t === 'code' && leaf.fenced) {
      if (indent <= 3) {
        const fence = matchFence(line, cpos);
        if (fence && fence.ch === leaf.fenceChar && fence.len >= leaf.fenceLen) {
          const after = line.slice(cpos + fence.len);
          if (/^[ \t]*$/.test(after)) {
            closeTo(stack.length - 1);
            continue;
          }
        }
      }
      // A content line has the fence's indentation stripped from it. The
      // strip counts characters, not columns: a tab counts as one, so a
      // leading tab is dropped whole even when the fence was indented
      // three spaces (marked's behaviour, verified against its output).
      let p = pos;
      let n = leaf.fenceIndent || 0;
      while (p < line.length && n > 0 && (line[p] === ' ' || line[p] === '\t')) {
        p++;
        n--;
      }
      leaf.lines.push(line.slice(p));
      continue;
    }
    if (leaf && leaf.t === 'code' && !leaf.fenced) {
      if (indent >= 4) {
        const r = advanceTo(line, pos, col, baseCol + 4);
        leaf.lines.push(r[0].slice(r[1]));
        continue;
      }
      closeTo(stack.length - 1);
      leaf = null;
    }
    if (leaf && leaf.t === 'html') {
      leaf.lines.push(line.slice(pos));
      leaf.lastLineIdx = li;
      if (leaf.htmlType <= 5 && leaf.endMarker && line.slice(pos).toLowerCase().includes(leaf.endMarker)) {
        closeTo(stack.length - 1);
      }
      continue;
    }
    if (leaf && leaf.t === 'table') {
      const endsTable =
        (line[cpos] === '#' && matchAtx(line, cpos)) ||
        line[cpos] === '>' ||
        ((line[cpos] === '`' || line[cpos] === '~') && matchFence(line, cpos)) ||
        (line[cpos] === '<' && matchHtmlBlock(line, cpos)) ||
        matchThematic(line, cpos) ||
        matchListMarker(line, cpos, ccol);
      if (endsTable) {
        closeTo(stack.length - 1);
        leaf = null;
      } else {
        leaf.rows.push(splitTableRow(line.slice(cpos)));
        continue;
      }
    }
    if (leaf && leaf.t === 'para') {
      // A setext underline may be indented at most three spaces: four
      // or more makes it paragraph text (or an indented code block).
      const setext = indent <= 3 ? matchSetext(line, cpos) : null;
      if (setext) {
        const parent = leaf.parent;
        const at = parent.children.indexOf(leaf);
        // Link reference definitions are extracted before the heading
        // is formed, so a def on an earlier line does not end up in
        // the heading text (cm-215). If nothing is left after the
        // definitions, there is no heading: the underline is ordinary
        // paragraph text (cm-216).
        const body = extractRefDefs(leaf.lines.join('\n'), refs);
        if (body.trim() === '') {
          leaf.lines.push(line.slice(pos));
          continue;
        }
        const heading = {
          t: 'heading',
          level: setext,
          text: body.trim(),
          parent,
        };
        parent.children[at] = heading;
        closeTo(stack.length - 1);
        continue;
      }
      if (leaf.lines.length === 1) {
        const aligns = parseTableDelimiter(line.slice(cpos));
        const headCells = splitTableRow(leaf.lines[0]);
        if (aligns && headCells.length === aligns.length && leaf.lines[0].includes('|')) {
          const table = {
            t: 'table',
            head: headCells,
            align: aligns,
            rows: [],
            parent: leaf.parent,
          };
          const at = leaf.parent.children.indexOf(leaf);
          leaf.parent.children[at] = table;
          closeTo(stack.length - 1);
          stack.push(table);
          continue;
        }
      }
      // A line indented four or more spaces cannot interrupt a
      // paragraph (an indented code block never interrupts one): it
      // continues the paragraph as text, leading spaces included.
      if (indent < 4 && interruptsParagraph(line, cpos, ccol)) {
        closeTo(stack.length - 1);
        leaf = null;
      } else {
        leaf.lines.push(line.slice(pos));
        continue;
      }
    }

    // -- No open leaf: start one or more new blocks. --
    let st = { line, pos, col, baseCol, li };
    let depth = 0;
    while (st && depth++ < 10) st = startBlock(st);
  }

  closeTo(1);
  return root;
}

/* ===========================================================================
   Rendering
   =========================================================================== */

function checkboxHtml(checked) {
  return checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

function renderBlocks(node, refs, tightList) {
  switch (node.t) {
    case 'doc':
      return node.children.map((c) => renderBlocks(c, refs, false)).join('');
    case 'para': {
      const html = inlineToHtml(node.text, refs);
      if (tightList) return html;
      return '<p>' + html + '</p>\n';
    }
    case 'heading':
      return '<h' + node.level + '>' + inlineToHtml(node.text, refs) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const body = escFull(node.text);
      if (node.fenced && node.info) {
        // Backslash escapes in the info string are resolved: the
        // language of ``` foo\+bar is foo+bar.
        const lang = node.info.split(/\s+/)[0].replace(/\\([!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        return '<pre><code class="language-' + escText(lang) + '">' + body + '</code></pre>\n';
      }
      return '<pre><code>' + body + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'quote':
      return '<blockquote>\n' + node.children.map((c) => renderBlocks(c, refs, false)).join('') + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of node.children) out += renderBlocks(item, refs, node.tight);
      out += '</' + tag + '>\n';
      return out;
    }
    case 'item': {
      const box = node.task ? checkboxHtml(node.task === 'checked') : null;
      let inner = '';
      node.children.forEach((child, idx) => {
        if (child.t === 'para') {
          const html = inlineToHtml(child.text, refs);
          const lead = idx === 0 && box ? box + ' ' : '';
          if (tightList) inner += lead + html;
          else inner += '<p>' + lead + html + '</p>\n';
        } else {
          const lead = idx === 0 && box ? box + ' ' : '';
          inner += lead + renderBlocks(child, refs, false);
        }
      });
      if (node.children.length === 0 && box) inner = box;
      return '<li>' + inner + '</li>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.head.length; i++) {
        const align = node.align[i];
        out += '<th' + (align ? ' align="' + align + '"' : '') + '>' + inlineToHtml(node.head[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let i = 0; i < node.head.length; i++) {
            const cell = i < row.length ? row[i] : '';
            const align = node.align[i];
            out += '<td' + (align ? ' align="' + align + '"' : '') + '>' + inlineToHtml(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

// The entry point: render one Markdown string exactly as marked 18.1.3
// does with its default options.
export function parse(src) {
  const refs = new Map();
  const root = parseBlocks(src, refs);
  return renderBlocks(root, refs, false);
}
