// parse.js — a fast, dependency-free Markdown -> HTML renderer whose output
// is byte-for-byte the HTML that marked 18.1.3 produces with its default
// options (gfm: true, breaks: false, pedantic: false).
//
// The pipeline mirrors marked's: a block pass over the source (same token
// boundaries, same merging rules, link reference definitions collected on
// the way), then an inline pass over each block's text (same token order,
// same emphasis/link scanning), then the same renderer strings. The hot
// paths are hand-written index scanners instead of anchored regexes over
// shrinking substrings, which is where the speed comes from. A few of
// marked's own rule patterns (emphasis delimiter scans, the link label
// pattern, the masking passes) are used as data — they are the GFM spec
// machinery marked implements, credited to marked (MIT, see README).
//
// No state is kept between calls: every call re-reads only its argument.

// ---------------------------------------------------------------- helpers

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESCAPE_ANY = /[&<>"']/;
const RE_ESCAPE_ANY_G = /[&<>"']/g;
const RE_ESCAPE_PLAIN = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESCAPE_PLAIN_G = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// marked's escapeHtml: with encode, every & < > " ' is escaped; without, an
// & that already begins an entity is left alone.
function escapeHtml(s, encode) {
  if (encode) {
    return RE_ESCAPE_ANY.test(s) ? s.replace(RE_ESCAPE_ANY_G, ch => ESCAPE_MAP[ch]) : s;
  }
  return RE_ESCAPE_PLAIN.test(s) ? s.replace(RE_ESCAPE_PLAIN_G, ch => ESCAPE_MAP[ch]) : s;
}

const RE_NUMREF = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const RE_NUMREF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// marked's unescape for inline text: resolve numeric character references,
// turn a bare & into &amp;, leave named entities alone.
function decodeNumericRefs(s) {
  if (!RE_NUMREF.test(s)) return s;
  return s.replace(RE_NUMREF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const v = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return '\uFFFD';
    if (v === 38) return '&amp;';
    return String.fromCodePoint(v);
  });
}

// marked's cleanUrl: encodeURI, undoing the %25 double-encoding; null when
// encodeURI throws (a lone surrogate in the href).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// marked's rtrim: strip trailing characters equal to ch.
function rtrimChar(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return n === s.length ? s : s.slice(0, n);
}

// marked's trimLines: drop trailing blank lines from a raw block, but keep
// the text untouched when at most one blank line trails.
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces with tab stops of 4, counting from column `col`
// (marked's expandTabs helper, applied to leading whitespace runs).
function expandTabs(s, col) {
  if (!s.includes('\t')) return s;
  let out = '';
  let t = col || 0;
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Link label normalisation: trim, collapse whitespace, case-fold.
function labelKey(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// marked's findClosingBracket: index of the closer that unbalances the
// opener, -1 when balanced with none left over, -2 when openers remain.
function findClosing(s, brackets) {
  if (s.indexOf(brackets[0]) === -1 && s.indexOf(brackets[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === brackets[0]) depth++;
    else if (s[i] === brackets[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// marked's splitCells for table rows: split on unescaped pipes, drop the
// empty edge cells, pad or truncate to `count`, trim, unescape pipes.
function splitCells(str, count) {
  // marked counts the backslashes immediately before each pipe in the
  // original string: an odd count leaves the pipe, an even count splits.
  let out = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '|') {
      let backslashes = 0;
      for (let p = i - 1; p >= 0 && str[p] === '\\'; p--) backslashes++;
      out += backslashes % 2 === 1 ? '|' : ' |';
    } else out += str[i];
  }
  const cells = out.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// ------------------------------------------------------- shared patterns

const PUNCT_SET = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const RE_ALNUM = /[\p{L}\p{N}]/u;

// marked's `punctuation` test: first char is whitespace/punctuation/symbol
// but not * or _.
function isPunctSpace(ch) {
  return ch !== '*' && ch !== '_' && ch !== '' && RE_PUNCT_OR_SPACE.test(ch);
}
// gfm emphasis punctuation: punctuation/symbol except ~.
function isEmPunct(ch) {
  return ch !== '~' && RE_PUNCT.test(ch);
}

// The delimiter-scan patterns of marked's inline rules (gfm set).
const RE_EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const RE_EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RE_EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RE_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const RE_DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
// Unanchored twins of the delim rules above, for scanning the full string
// from an offset instead of a sliced copy: LDelims as sticky (match exactly
// at lastIndex). Each RDelim splits in two: its first alternative is
// ^-anchored in marked (it may only match at the scan start), so it gets a
// sticky FIRST pattern tried once at the offset; the remaining alternatives
// (which carry all the capture groups — the first alternative has none)
// scan globally from there. The patterns contain no lookbehinds and their
// $ lookaheads sit at the same string end, so this is equivalent to marked
// exec'ing the anchored pattern over the sliced remainder.
const RE_EM_LDELIM_Y = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/uy;
const RE_EM_RDELIM_AST_FIRST = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/y;
const RE_EM_RDELIM_AST_G = /[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RE_EM_RDELIM_UND_FIRST = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/y;
const RE_EM_RDELIM_UND_G = /[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RE_DEL_LDELIM_Y = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/uy;
const RE_DEL_RDELIM_FIRST = /[^~]+(?=[^~])/y;
const RE_DEL_RDELIM_G = /(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const RE_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const RE_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const RE_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const RE_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const RE_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const RE_MASK_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const RE_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// ------------------------------------------------------------ line utils

function eolAt(s, i) {
  const j = s.indexOf('\n', i);
  return j === -1 ? s.length : j;
}

// Index of the first char that is not a space, or -1 (like search(/[^ ]/)).
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') return i;
  return -1;
}

function isBlankRange(s, a, b) {
  for (let i = a; i < b; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// Count of leading spaces, capped at 3: block patterns allow {0,3}, so a
// fourth space must leave the cursor on a space and fail the char tests.
function leadSpaces(s, i) {
  let n = 0;
  while (n < 3 && s[i + n] === ' ') n++;
  return n;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Does the line starting at ls begin an HTML block / interrupt, in the
// sense of marked's html-begin pattern (used by paragraphs, lists, rows)?
function isHtmlBegin(s, ls, le) {
  let i = ls + leadSpaces(s, ls);
  if (s[i] !== '<') return false;
  i++;
  const c = s[i];
  if (c === '!') {
    if (s.startsWith('!--', i)) return true;
    if (s.startsWith('![CDATA[', i)) return true;
    const n = s[i + 1];
    return (n >= 'a' && n <= 'z') || (n >= 'A' && n <= 'Z');
  }
  if (c === '?') return true;
  let j = i;
  const slash = s[j] === '/';
  if (slash) j++;
  // script/pre/style/textarea open (no closing slash allowed here):
  // name followed by whitespace, > or EOL
  const nameStart = j;
  while (j < le && /[a-zA-Z0-9-]/.test(s[j])) j++;
  const name = s.slice(nameStart, j).toLowerCase();
  if (!slash && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    if (j >= le) return true;
    const d = s[j];
    if (d === '>' || d === ' ' || d === '\t' || d === '\n') return true;
  }
  if (!BLOCK_TAGS.has(name)) return false;
  if (j >= le) return true; // tag name at end of line: the \n alternative
  const d = s[j];
  if (d === '>') return true;
  if (d === '/' && s[j + 1] === '>') return true;
  if (d === ' ') return true; // one or more spaces
  return false;
}

function isQuoteBegin(s, ls) {
  return s[ls + leadSpaces(s, ls)] === '>';
}

function isHeadingBegin(s, ls, le) {
  let i = ls + leadSpaces(s, ls);
  let h = 0;
  while (s[i + h] === '#') h++;
  if (h < 1 || h > 6) return false;
  const p = i + h;
  if (p >= le) return true;
  const c = s[p];
  return c === ' ' || c === '\t' || /\s/.test(c);
}

function isFenceBegin(s, ls, le) {
  let i = ls + leadSpaces(s, ls);
  const c = s[i];
  if (c !== '`' && c !== '~') return false;
  let n = 0;
  while (s[i + n] === c) n++;
  if (n < 3) return false;
  if (c === '~') return true;
  // backtick fence: the info string may not contain a backtick
  for (let p = i + n; p < le; p++) if (s[p] === '`') return false;
  return true;
}

// Full-line thematic break test on [ls, le).
function isHrLine(s, ls, le) {
  let i = ls + leadSpaces(s, ls);
  const c = s[i];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  for (let j = i; j < le; j++) {
    if (s[j] === c) count++;
    else if (s[j] !== ' ' && s[j] !== '\t') return false;
  }
  return count >= 3;
}

// Paragraph interruption by a list (gfm paragraph variant): a bullet, or
// an ordered marker that starts at 1, followed by space and real content.
function isListBeginPara(s, ls, le) {
  let i = ls + leadSpaces(s, ls);
  const c = s[i];
  if (c === '*' || c === '+' || c === '-') i++;
  else if (c === '1' && (s[i + 1] === '.' || s[i + 1] === ')')) i += 2;
  else return false;
  let spaces = 0;
  while (i < le && (s[i] === ' ' || s[i] === '\t')) { i++; spaces++; }
  if (spaces === 0) return false;
  return i < le; // a non-space, non-tab character remains on the line
}

// Paragraph interruption by a list (blockquote paragraph variant): any
// bullet or number, followed by space/tab or the end of the line.
function isListBeginQuote(s, ls, le) {
  let i = ls + leadSpaces(s, ls);
  const c = s[i];
  if (c === '*' || c === '+' || c === '-') i++;
  else if (c >= '0' && c <= '9') {
    let n = 0;
    while (n < 9 && s[i + n] >= '0' && s[i + n] <= '9') n++;
    if (n === 0 || (s[i + n] !== '.' && s[i + n] !== ')')) return false;
    i += n + 1;
  } else return false;
  if (i >= le) return true;
  return s[i] === ' ' || s[i] === '\t';
}

// ------------------------------------------------------- block scanners
// Each returns null when its construct does not start at pos, else an
// object with at least { end } — the position the block pass advances to
// (marked advances by the token's raw length, which for several tokens is
// the match with trailing newlines stripped).

function scanSpace(s, pos) {
  let p = pos;
  const len = s.length;
  while (p < len) {
    let q = p;
    while (q < len && (s[q] === ' ' || s[q] === '\t')) q++;
    if (q < len && s[q] === '\n') { p = q + 1; continue; }
    if (q === len) { p = q; break; }
    break;
  }
  return p > pos ? p : -1;
}

function indentPrefixLen(s, ls, le) {
  let k = 0;
  while (ls + k < le && s[ls + k] === ' ') k++;
  if (k >= 4) return 4;
  if (ls + k < le && s[ls + k] === '\t') return k + 1;
  return -1;
}

function scanIndentedCode(s, pos) {
  let p = pos;
  const len = s.length;
  for (;;) {
    const le = eolAt(s, p);
    const pre = indentPrefixLen(s, p, le);
    if (pre < 0 || le - p <= pre) break;
    if (le === len) { p = len; break; }
    let r = le + 1;
    for (;;) {
      if (r >= len) break;
      const ble = eolAt(s, r);
      if (!isBlankRange(s, r, ble)) break;
      if (ble === len) { r = len; break; }
      r = ble + 1;
    }
    p = r;
    if (p >= len) break;
  }
  if (p === pos) return null;
  const raw = trimBlankLines(s.slice(pos, p));
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { text, end: pos + raw.length };
}

function isFenceCloseLine(s, ls, le, ch, runLen) {
  let i = ls + leadSpaces(s, ls);
  if (s[i] !== ch) return false;
  let n = 0;
  while (s[i + n] === ch) n++;
  if (n < runLen) return false;
  for (let p = i + n; p < le; p++) if (s[p] !== ' ') return false;
  return true;
}

function fenceCompensate(raw, content) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (!m) return content;
  const indent = m[1].length;
  return content.split('\n').map(line => {
    const lm = /^\s+/.exec(line);
    if (!lm) return line;
    return line.slice(Math.min(lm[0].length, indent));
  }).join('\n');
}

function scanFences(s, pos) {
  const i = pos + leadSpaces(s, pos);
  const c = s[i];
  if (c !== '`' && c !== '~') return null;
  let runEnd = i;
  while (s[runEnd] === c) runEnd++;
  const runLen = runEnd - i;
  if (runLen < 3) return null;
  const le = eolAt(s, runEnd);
  const info = s.slice(runEnd, le);
  if (c === '`' && info.includes('`')) return null;
  const contentStart = le < s.length ? le + 1 : le;
  let closeStart = -1;
  let closeEnd = -1;
  let p = contentStart;
  while (p < s.length) {
    const lle = eolAt(s, p);
    if (isFenceCloseLine(s, p, lle, c, runLen)) { closeStart = p; closeEnd = lle; break; }
    if (lle === s.length) break;
    p = lle + 1;
  }
  let content;
  let rawEnd;
  if (closeStart >= 0) {
    content = closeStart === contentStart ? '' : s.slice(contentStart, closeStart - 1);
    rawEnd = closeEnd;
  } else {
    const rest = s.slice(contentStart);
    content = rest.endsWith('\n') ? rest.slice(0, -1) : rest;
    rawEnd = s.length;
  }
  const raw = s.slice(pos, rawEnd);
  const text = fenceCompensate(raw, content);
  const lang = info ? info.trim().replace(RE_ANY_PUNCT, '$1') : info;
  return { text, lang, end: rawEnd };
}

function scanHeading(s, pos) {
  let i = pos + leadSpaces(s, pos);
  let h = 0;
  while (s[i + h] === '#') h++;
  if (h < 1 || h > 6) return null;
  const after = i + h;
  if (after < s.length && !/\s/.test(s[after])) return null;
  const le = eolAt(s, after);
  let text = s.slice(after, le).trim();
  if (text.endsWith('#')) {
    const stripped = rtrimChar(text, '#');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { depth: h, text, end: le };
}

function scanHr(s, pos) {
  const le = eolAt(s, pos);
  return isHrLine(s, pos, le) ? { end: le } : null;
}

// Attempts the optional link-title suffix of a definition starting at q
// (just past the destination). Returns { titleRaw, end } or null.
function defTitleSuffix(s, q) {
  let p = q;
  let spaces = 0;
  while (s[p] === ' ') { p++; spaces++; }
  let nl = false;
  if (s[p] === '\n') { nl = true; p++; while (s[p] === ' ' || s[p] === '\t') p++; }
  if (spaces === 0 && !nl) return null;
  const qc = s[p];
  let titleEnd = -1;
  if (qc === '"') {
    let j = p + 1;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === '"') { titleEnd = j + 1; break; }
      j++;
    }
  } else if (qc === "'") {
    let j = p + 1;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === "'") { titleEnd = j + 1; break; }
      if (s[j] === '\n' && s[j + 1] === '\n') return null;
      j++;
    }
  } else if (qc === '(') {
    let j = p + 1;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === ')') { titleEnd = j + 1; break; }
      if (s[j] === '(') return null;
      j++;
    }
  } else return null;
  if (titleEnd < 0) return null;
  let r = titleEnd;
  while (s[r] === ' ') r++;
  if (r < s.length && s[r] !== '\n') return null;
  return { titleRaw: s.slice(p, titleEnd), end: r };
}

function scanDef(s, pos) {
  let i = pos + leadSpaces(s, pos);
  if (s[i] !== '[') return null;
  const labelStart = i + 1;
  {
    let q = labelStart;
    while (q < s.length && /\s/.test(s[q])) q++;
    if (s[q] === ']') return null;
  }
  let j = labelStart;
  let labelEnd = -1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === ']') { labelEnd = j; break; }
    if (c === '[') return null;
    if (c === '\n') {
      let q = j + 1;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q >= s.length || s[q] === '\n') return null;
      j++;
      continue;
    }
    j++;
  }
  if (labelEnd < 0 || labelEnd === labelStart) return null;
  const label = s.slice(labelStart, labelEnd);
  if (s[labelEnd + 1] !== ':') return null;
  let p = labelEnd + 2;
  while (s[p] === ' ') p++;
  if (s[p] === '\n') { p++; while (s[p] === ' ' || s[p] === '\t') p++; }
  let dest;
  let destEnd;
  if (s[p] === '<') {
    const gt = s.indexOf('>', p);
    const le = eolAt(s, p);
    if (gt < 0 || gt > le) return null;
    dest = s.slice(p, gt + 1);
    destEnd = gt + 1;
  } else {
    if (p >= s.length || s[p] === '<' || /\s/.test(s[p])) return null;
    let q = p;
    while (q < s.length && !/\s/.test(s[q])) q++;
    dest = s.slice(p, q);
    destEnd = q;
  }
  let titleRaw;
  let end;
  const t = defTitleSuffix(s, destEnd);
  if (t) {
    titleRaw = t.titleRaw;
    end = t.end;
  } else {
    let r = destEnd;
    while (s[r] === ' ') r++;
    if (r < s.length && s[r] !== '\n') return null;
    end = r;
  }
  if (!dest.startsWith('<') && findClosing(dest, '()') !== -1) return null;
  const href = dest.replace(/^<(.*)>$/, '$1').replace(RE_ANY_PUNCT, '$1');
  const title = titleRaw !== undefined ? titleRaw.slice(1, -1).replace(RE_ANY_PUNCT, '$1') : undefined;
  return { tag: labelKey(label), href, title, end };
}

// ------------------------------------------------------------- tables

function delimCellBody(s, p, le) {
  if (s[p] === ':') p++;
  let dashes = 0;
  while (p < le && s[p] === '-') { p++; dashes++; }
  if (dashes === 0) return -1;
  if (s[p] === ':') p++;
  while (p < le && s[p] === ' ') p++;
  return p;
}

// Matches a table delimiter line at ls; returns { text, end } or null.
function matchDelimLine(s, ls) {
  const le = eolAt(s, ls);
  let p = ls + leadSpaces(s, ls);
  if (s[p] === '|') { p++; while (p < le && s[p] === ' ') p++; }
  p = delimCellBody(s, p, le);
  if (p < 0) return null;
  while (p < le) {
    if (s[p] !== '|') return null;
    p++;
    while (p < le && s[p] === ' ') p++;
    if (p >= le) break;
    p = delimCellBody(s, p, le);
    if (p < 0) return null;
  }
  return p === le ? { text: s.slice(ls, le), end: le } : null;
}

// True when a table would start at line ls (used as a paragraph stop).
function tableStartsAt(s, ls) {
  let i = ls;
  while (s[i] === ' ') i++;
  if (i >= s.length || s[i] === '\n') return false;
  const hEnd = eolAt(s, ls);
  if (hEnd >= s.length) return false;
  return matchDelimLine(s, hEnd + 1) !== null;
}

function isTableRowStop(s, ls, le) {
  // The blank-row stop is ` *\n`: spaces only (a tab-only line is a row).
  let allSpaces = true;
  for (let i = ls; i < le; i++) if (s[i] !== ' ') { allSpaces = false; break; }
  if (allSpaces) return le < s.length;
  if (isHrLine(s, ls, le)) return true;
  if (isHeadingBegin(s, ls, le)) return true;
  if (isQuoteBegin(s, ls)) return true;
  {
    const pre = indentPrefixLen(s, ls, le);
    if (pre >= 0 && le - ls > pre) return true;
  }
  if (isFenceBegin(s, ls, le)) return true;
  {
    // list line: ` {0,3}(bullet)[ \t]`
    let i = ls + leadSpaces(s, ls);
    const c = s[i];
    let ok = false;
    if (c === '*' || c === '+' || c === '-') { i++; ok = true; }
    else if (c >= '0' && c <= '9') {
      let n = 0;
      while (n < 9 && s[i + n] >= '0' && s[i + n] <= '9') n++;
      if (n > 0 && (s[i + n] === '.' || s[i + n] === ')')) { i += n + 1; ok = true; }
    }
    if (ok && i < le && (s[i] === ' ' || s[i] === '\t')) return true;
  }
  if (isHtmlBegin(s, ls, le)) return true;
  return false;
}

function scanTable(s, pos) {
  let i = pos;
  while (s[i] === ' ') i++;
  if (i >= s.length || s[i] === '\n') return null;
  const hEnd = eolAt(s, pos);
  if (hEnd >= s.length) return null;
  const headerText = s.slice(i, hEnd);
  const dm = matchDelimLine(s, hEnd + 1);
  if (!dm) return null;
  if (!/[:|]/.test(dm.text)) return null;
  const header = splitCells(headerText);
  const delimCells = dm.text.replace(/^\||\| *$/g, '').split('|');
  if (header.length !== delimCells.length) return null;
  const aligns = delimCells.map(cell =>
    /^ *-+: *$/.test(cell) ? 'right'
      : /^ *:-+: *$/.test(cell) ? 'center'
        : /^ *:-+ *$/.test(cell) ? 'left' : null);
  let rowsText = '';
  let matchEnd;
  if (dm.end >= s.length) {
    matchEnd = s.length;
  } else {
    const rStart = dm.end + 1;
    let p = rStart;
    let rEnd = rStart;
    while (p < s.length) {
      const le = eolAt(s, p);
      if (isTableRowStop(s, p, le)) break;
      rEnd = le < s.length ? le + 1 : le;
      p = rEnd;
      if (le >= s.length) break;
    }
    rowsText = s.slice(rStart, rEnd);
    let q = rEnd;
    while (q < s.length && s[q] === '\n') q++;
    matchEnd = q;
  }
  const raw = rtrimChar(s.slice(pos, matchEnd), '\n');
  let rows = [];
  if (rowsText.trim()) {
    rows = rowsText.replace(/\n[ \t]*$/, '').split('\n').map(line => splitCells(line, header.length));
  }
  return { header, aligns, rows, end: pos + raw.length };
}

// ------------------------------------------------------------- lheading

function isSetextUnderline(line) {
  return /^ {0,3}(?:=+|-+)[ \t]*$/.test(line);
}

// Lines that may not appear as (first === true) or inside a setext
// heading's lazy content, mirroring marked's negative lookaheads.
function lheadingLineBlocked(s, ls, le, first) {
  const line = s.slice(ls, le);
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return true;
  if (first && indentPrefixLen(s, ls, le) >= 0) return true;
  if (isFenceBegin(s, ls, le)) return true;
  if (isQuoteBegin(s, ls)) return true;
  if (isHeadingBegin(s, ls, le)) return true;
  if (!first && isHrLine(s, ls, le)) return true;
  if (/^ {0,3}<[^>]+>$/.test(line) && le < s.length) return true;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(line) && le < s.length) return true;
  return false;
}

function scanLheading(s, pos) {
  const le0 = eolAt(s, pos);
  if (le0 === pos || isBlankRange(s, pos, le0)) return null;
  if (lheadingLineBlocked(s, pos, le0, true)) return null;
  const lines = [s.slice(pos, le0)];
  let p = le0;
  while (p < s.length) {
    const ls = p + 1;
    if (ls >= s.length) break;
    const le = eolAt(s, ls);
    const line = s.slice(ls, le);
    if (isSetextUnderline(line)) {
      const text = lines.join('\n').trim();
      const depth = line.trimStart().startsWith('=') ? 1 : 2;
      return { depth, text, end: le };
    }
    if (isBlankRange(s, ls, le)) break;
    if (lheadingLineBlocked(s, ls, le, false)) break;
    lines.push(line);
    p = le;
  }
  return null;
}

// ------------------------------------------------------------- paragraph

function paraStopLine(s, ls, le, variant) {
  if (isBlankRange(s, ls, le)) return le < s.length;
  if (isHrLine(s, ls, le)) return true;
  if (isHeadingBegin(s, ls, le)) return true;
  if (isQuoteBegin(s, ls)) return true;
  if (isFenceBegin(s, ls, le)) return true;
  if (variant === 'quote' ? isListBeginQuote(s, ls, le) : isListBeginPara(s, ls, le)) return true;
  if (isHtmlBegin(s, ls, le)) return true;
  if (variant === 'normal' && tableStartsAt(s, ls)) return true;
  return false;
}

// Returns the end (exclusive, before the trailing newline) of the
// paragraph starting at pos, or -1.
function scanParagraph(s, pos, variant) {
  const le0 = eolAt(s, pos);
  if (le0 === pos) return -1;
  let end = le0;
  let p = le0;
  while (p < s.length) {
    const ls = p + 1;
    if (ls >= s.length) break;
    const le = eolAt(s, ls);
    if (le === ls) break;
    if (paraStopLine(s, ls, le, variant)) break;
    end = le;
    p = le;
  }
  return end;
}

// ------------------------------------------------------------- html block

function isAsciiLetter(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// Transliteration of marked's block html rule: eight alternatives tried
// in order. Returns { text, pre, end } or null.
function scanHtmlBlock(s, pos) {
  const len = s.length;
  const i = pos + leadSpaces(s, pos);
  if (s[i] !== '<') return null;
  // Rest of the current line, then the run of bare newlines after it.
  const rol = (from) => {
    let q = eolAt(s, from);
    while (q < len && s[q] === '\n') q++;
    return q;
  };
  // Alternatives 6-8 tail: content runs to just after the first blank
  // line, or to EOF.
  const tail = () => {
    let p = i;
    while (p < len) {
      const le = eolAt(s, p);
      if (le >= len) break;
      const nls = le + 1;
      const nle = eolAt(s, nls);
      if (nle < len && isBlankRange(s, nls, nle)) return nle + 1;
      p = nls;
    }
    return len;
  };
  const finish = (matchEnd, pre) => {
    const text = trimBlankLines(s.slice(pos, matchEnd));
    return { text, pre, end: pos + text.length };
  };

  // 1. script / pre / style / textarea
  {
    let j = i + 1;
    while (j < len && isAsciiLetter(s[j])) j++;
    const name = s.slice(i + 1, j);
    const lower = name.toLowerCase();
    if ((lower === 'script' || lower === 'pre' || lower === 'style' || lower === 'textarea') &&
        j < len && (s[j] === '>' || /\s/.test(s[j]))) {
      const close = '</' + lower + '>';
      let matchEnd = len;
      let from = j;
      for (;;) {
        const idx = s.indexOf('</', from);
        if (idx < 0) break;
        if (s.slice(idx, idx + close.length).toLowerCase() === close) {
          matchEnd = rol(idx + close.length);
          break;
        }
        from = idx + 2;
      }
      return finish(matchEnd, name === 'pre' || name === 'script' || name === 'style');
    }
  }
  // 2. comment
  if (s.startsWith('<!--', i)) {
    let contentEnd;
    if (s.startsWith('<!-->', i)) contentEnd = i + 5;
    else if (s.startsWith('<!--->', i)) contentEnd = i + 6;
    else {
      const idx = s.indexOf('-->', i + 4);
      contentEnd = idx < 0 ? len : idx + 3;
    }
    return finish(rol(contentEnd), false);
  }
  // 3. processing instruction
  if (s.startsWith('<?', i)) {
    const idx = s.indexOf('?>', i + 2);
    return finish(idx < 0 ? len : rol(idx + 2), false);
  }
  // 4. declaration <![A-Z] ... >
  if (s[i + 1] === '!' && isAsciiLetter(s[i + 2])) {
    const idx = s.indexOf('>', i + 3);
    return finish(idx < 0 ? len : rol(idx + 1), false);
  }
  // 5. CDATA
  if (s.startsWith('<![CDATA[', i)) {
    const idx = s.indexOf(']]>', i + 9);
    return finish(idx < 0 ? len : rol(idx + 3), false);
  }
  // 6. block-level tag
  {
    let j = i + 1;
    if (s[j] === '/') j++;
    const nameStart = j;
    while (j < len && /[a-zA-Z0-9-]/.test(s[j])) j++;
    const name = s.slice(nameStart, j).toLowerCase();
    if (BLOCK_TAGS.has(name)) {
      const d = s[j];
      if (j >= len || d === '>' || d === '\n' || d === ' ' || d === '\t' ||
          (d === '/' && s[j + 1] === '>') || j >= eolAt(s, i)) {
        return finish(tail(), false);
      }
    }
  }
  // 7. any other open tag, alone on its line
  {
    let j = i + 1;
    const nameStart = j;
    while (j < len && /[a-zA-Z0-9-]/.test(s[j])) j++;
    const name = s.slice(nameStart, j);
    const lower = name.toLowerCase();
    let blocked = false;
    for (const w of ['script', 'pre', 'style', 'textarea']) {
      if (lower.startsWith(w)) {
        const after = s[nameStart + w.length];
        if (after === undefined || !/[a-z0-9-]/i.test(after)) blocked = true;
      }
    }
    if (name.length > 0 && isAsciiLetter(name[0]) && !blocked) {
      let p = j;
      let ok = true;
      for (;;) {
        let q = p;
        while (s[q] === ' ') q++;
        if (q === p) break;
        // attribute name
        if (!/[a-zA-Z:_]/.test(s[q] || '')) break;
        let a = q + 1;
        while (a < len && /[\w.:-]/.test(s[a])) a++;
        // optional value
        let v = a;
        while (s[v] === ' ') v++;
        if (s[v] === '=') {
          v++;
          while (s[v] === ' ') v++;
          const qc = s[v];
          if (qc === '"' || qc === "'") {
            const close = s.indexOf(qc, v + 1);
            if (close < 0 || close > eolAt(s, v)) { ok = false; break; }
            p = close + 1;
          } else {
            let u = v;
            while (u < len && !/[\s"'=<>`]/.test(s[u])) u++;
            if (u === v) { ok = false; break; }
            p = u;
          }
        } else {
          p = a;
        }
      }
      if (ok) {
        while (s[p] === ' ') p++;
        if (s[p] === '/') p++;
        if (s[p] === '>') {
          p++;
          let q = p;
          while (s[q] === ' ' || s[q] === '\t') q++;
          if (q >= len || s[q] === '\n') return finish(tail(), false);
        }
      }
    }
  }
  // 8. closing tag alone on its line
  if (s[i + 1] === '/') {
    let j = i + 2;
    const nameStart = j;
    while (j < len && /[a-zA-Z0-9-]/.test(s[j])) j++;
    if (j > nameStart && isAsciiLetter(s[nameStart])) {
      let p = j;
      while (p < len && /\s/.test(s[p])) p++;
      if (s[p] === '>') {
        p++;
        let q = p;
        while (s[q] === ' ' || s[q] === '\t') q++;
        if (q >= len || s[q] === '\n') return finish(tail(), false);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ parse state
// One parse() call at a time uses these, exactly mirroring marked's Lexer
// state: link definitions collected during the block pass, a queue of
// inline jobs filled after it, and the inline state flags.

let LINKS = null;   // tag -> { href, title }
let QUEUE = null;   // [{ src, tokens }] inline jobs, in creation order
let ST = null;      // { inLink, inRawBlock, linkEmitted, linkParenPossible, top }

function queueInline(text) {
  const tokens = [];
  QUEUE.push({ src: text, tokens });
  return tokens;
}

// ------------------------------------------------- list begin-tests (Rn)
// marked builds these per list item with indent n = clamp(R - 1, 0, 3):
// a line matches when it has at most n leading spaces and then the
// construct. All take a whole line string.

function indentClamp(R) {
  return Math.max(0, Math.min(3, R - 1));
}

function leadUpTo(line, n) {
  let k = 0;
  while (line[k] === ' ') k++;
  return k <= n ? k : -1;
}

function fencesBeginN(line, n) {
  const k = leadUpTo(line, n);
  if (k < 0) return false;
  return line.startsWith('```', k) || line.startsWith('~~~', k);
}

function headingBeginN(line, n) {
  const k = leadUpTo(line, n);
  if (k < 0) return false;
  let h = 0;
  while (line[k + h] === '#') h++;
  if (h < 1 || h > 6) return false;
  const p = k + h;
  return p >= line.length || /\s/.test(line[p]);
}

function hrBeginN(line, n) {
  const k = leadUpTo(line, n);
  if (k < 0) return false;
  const c = line[k];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  for (let j = k; j < line.length; j++) {
    if (line[j] === c) count++;
    else if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return count >= 3;
}

function quoteBeginN(line, n) {
  const k = leadUpTo(line, n);
  return k >= 0 && line[k] === '>';
}

function htmlBeginN(line, n) {
  const k = leadUpTo(line, n);
  if (k < 0 || line[k] !== '<') return false;
  return isHtmlBegin(line, k, line.length);
}

function nextBulletN(line, n) {
  const k = leadUpTo(line, n);
  if (k < 0) return false;
  const c = line[k];
  let i;
  if (c === '*' || c === '+' || c === '-') i = k + 1;
  else if (c >= '0' && c <= '9') {
    let d = 0;
    while (d < 9 && line[k + d] >= '0' && line[k + d] <= '9') d++;
    if (d === 0 || (line[k + d] !== '.' && line[k + d] !== ')')) return false;
    i = k + d + 1;
  } else return false;
  return i >= line.length || line[i] === ' ' || line[i] === '\t';
}

// Combined form of the *BeginN interrupt tests, sharing one lead scan.
// full=true: fences|heading|quote|nextBullet|hr|html (list continuation);
// full=false: fences|heading|hr|html (lazy continuation test).
function beginsInterrupt(line, n, full) {
  const k = leadUpTo(line, n);
  if (k < 0) return false;
  const c = line[k];
  if (c === '`' || c === '~') {
    if (line.startsWith('```', k) || line.startsWith('~~~', k)) return true;
  } else if (c === '#') {
    let h = 0;
    while (line[k + h] === '#') h++;
    if (h >= 1 && h <= 6) {
      const p = k + h;
      if (p >= line.length || /\s/.test(line[p])) return true;
    }
  } else if (c === '<') {
    if (isHtmlBegin(line, k, line.length)) return true;
  }
  if (full && c === '>') return true;
  if (c === '-' || c === '_' || c === '*') {
    let count = 0;
    for (let j = k; j < line.length; j++) {
      if (line[j] === c) count++;
      else if (line[j] !== ' ' && line[j] !== '\t') { count = -1; break; }
    }
    if (count >= 3) return true;
  }
  if (full) {
    let i = -1;
    if (c === '*' || c === '+' || c === '-') i = k + 1;
    else if (c >= '0' && c <= '9') {
      let d = 0;
      while (d < 9 && line[k + d] >= '0' && line[k + d] <= '9') d++;
      if (d > 0 && (line[k + d] === '.' || line[k + d] === ')')) i = k + d + 1;
    }
    if (i >= 0 && (i >= line.length || line[i] === ' ' || line[i] === '\t')) return true;
  }
  return false;
}

// ------------------------------------------------------------- blockquote

const RE_QUOTE_START = /^ {0,3}>/;
const RE_QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_QUOTE_STRIP = /^ {0,3}>[ \t]?/gm;

// The blockquote match: repetitions of (marker line + lazy paragraph
// continuations). Returns the matched lines and the end position.
function scanBlockquoteMatch(s, pos) {
  const lines = [];
  let p = pos;
  while (p < s.length) {
    const le = eolAt(s, p);
    let i = p + leadSpaces(s, p);
    if (s[i] !== '>') break;
    let r = i + 1;
    if (s[r] === ' ') r++;
    const restBlank = isBlankRange(s, r, le);
    lines.push(s.slice(p, le));
    p = le < s.length ? le + 1 : le;
    if (restBlank) continue;
    while (p < s.length) {
      const cle = eolAt(s, p);
      if (cle === p) break;
      if (paraStopLine(s, p, cle, 'quote')) break;
      lines.push(s.slice(p, cle));
      p = cle < s.length ? cle + 1 : cle;
    }
  }
  return lines.length > 0 ? { lines, end: p } : null;
}

function stripQuoteMarkers(h) {
  return h
    .replace(RE_QUOTE_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
    .replace(RE_QUOTE_SETEXT, '\n    $1')
    .replace(RE_QUOTE_STRIP, '');
}

// Full blockquote tokenizer on the remaining string; returns
// { token, rawLength } or null.
function blockquoteToken(str) {
  const m = scanBlockquoteMatch(str, 0);
  if (!m) return null;
  let rest = m.lines;
  let rawOut = '';
  let textOut = '';
  const tokens = [];
  while (rest.length > 0) {
    let anyStart = false;
    const group = [];
    let p = 0;
    for (; p < rest.length; p++) {
      if (RE_QUOTE_START.test(rest[p])) { group.push(rest[p]); anyStart = true; }
      else if (!anyStart) group.push(rest[p]);
      else break;
    }
    rest = rest.slice(p);
    const h = group.join('\n');
    const u = stripQuoteMarkers(h);
    rawOut = rawOut ? rawOut + '\n' + h : h;
    textOut = textOut ? textOut + '\n' + u : u;
    const savedTop = ST.top;
    ST.top = true;
    lexBlocks(u, tokens, true);
    ST.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' ||
                 last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const b = rest.join('\n');
      const mm = last.raw + '\n' + b.replace(RE_QUOTE_STRIP, '');
      const f = blockquoteToken(mm);
      tokens[tokens.length - 1] = f.token;
      const y = mm.substring(f.token.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? rest.slice(0, -R) : rest;
      if (A.length > 0) rawOut += '\n' + A.join('\n');
      textOut = textOut.substring(0, textOut.length - last.text.length) + f.token.text;
      rest = rest.slice(A.length);
      if (rest.length > 0 && RE_QUOTE_START.test(rest[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const b = last.raw + '\n' + rest.join('\n');
      const mm = listToken(b);
      tokens[tokens.length - 1] = mm.token;
      const f = mm.token.raw.length > last.raw.length
        ? b.slice(last.raw.length + 1, mm.token.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = rest.slice(0, f).join('\n');
        rawOut += '\n' + y;
        textOut += '\n' + y;
      }
      rest = rest.slice(f);
      continue;
    }
  }
  const token = { type: 'blockquote', raw: rawOut, text: textOut, tokens };
  return { token, rawLength: rawOut.length };
}

// ------------------------------------------------------------- list

const RE_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;

// Does s end with a blank line (…\n[ \t]*\n[ \t]*)? Same test as
// RE_DOUBLE_BLANK, scanned backwards from the end instead of by regex.
function endsWithDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}
const RE_ANY_LINE = /\n.*\n/;

// Gate for the list tokenizer on a line: ` {0,3}(bullet)` then a space,
// tab, or the end of the line.
function listGateAt(s, pos) {
  const i = pos + leadSpaces(s, pos);
  const c = s[i];
  if (c === '*' || c === '+' || c === '-') {
    const a = s[i + 1];
    return a === ' ' || a === '\t' || a === '\n' || a === undefined ? i + 1 : -1;
  }
  if (c >= '0' && c <= '9') {
    let d = 0;
    while (d < 9 && s[i + d] >= '0' && s[i + d] <= '9') d++;
    if (d === 0 || (s[i + d] !== '.' && s[i + d] !== ')')) return -1;
    const a = s[i + d + 1];
    return a === ' ' || a === '\t' || a === '\n' || a === undefined ? i + d + 1 : -1;
  }
  return -1;
}

// Matches one list-item line at epos against the list's own bullet
// pattern. Returns { group1Len, content, lineLen } or null.
function matchItemLine(str, epos, ordered, bulletChar, delim) {
  const le = eolAt(str, epos);
  let i = epos;
  let sp = 0;
  while (sp < 3 && str[i] === ' ') { i++; sp++; }
  if (ordered) {
    let d = 0;
    while (d < 9 && str[i + d] >= '0' && str[i + d] <= '9') d++;
    if (d === 0 || str[i + d] !== delim) return null;
    i += d + 1;
  } else {
    if (str[i] !== bulletChar) return null;
    i++;
  }
  const group1Len = i - epos;
  let content = '';
  if (i < le) {
    if (str[i] !== ' ' && str[i] !== '\t') return null;
    content = str.slice(i, le);
  }
  const lineLen = (le - epos) + (le < str.length ? 1 : 0);
  return { group1Len, content, lineLen };
}

// Full list tokenizer on the remaining string; returns
// { token, rawLength } or null.
function listToken(str) {
  const gateEnd = listGateAt(str, 0);
  if (gateEnd < 0) return null;
  const firstLine = str.slice(0, eolAt(str, 0));
  const bulletText = firstLine.slice(0, gateEnd).trim();
  const ordered = bulletText.length > 1;
  const bulletChar = ordered ? '' : bulletText;
  const delim = ordered ? bulletText[bulletText.length - 1] : '';
  const start = ordered ? +bulletText.slice(0, -1) : '';
  const list = { type: 'list', raw: '', ordered, start, loose: false, items: [] };
  let epos = 0;
  let prevBlank = false;
  while (epos < str.length) {
    const itemStart = epos;
    const lineEnd = eolAt(str, epos);
    if (isHrLine(str, epos, lineEnd)) break;
    const im = matchItemLine(str, epos, ordered, bulletChar, delim);
    if (!im) break;
    epos += im.lineLen;
    const b = im.group1Len;
    let m = (im.content[0] === ' ' || im.content[0] === '\t')
      ? im.content.replace(/^[ \t]+/, v => expandTabs(v, b))
      : im.content;
    let f = epos < str.length ? str.slice(epos, eolAt(str, epos)) : '';
    const y0 = !m.trim();
    let y = y0;
    let R;
    let d = '';
    if (y) {
      R = b + 1;
    } else {
      R = firstNonSpace(m);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    let u = false;
    if (y && /^[ \t]*$/.test(f)) {
      epos = Math.min(str.length, epos + f.length + 1);
      u = true;
    }
    if (!u) {
      const n = indentClamp(R);
      while (epos < str.length) {
        const U = str.slice(epos, eolAt(str, epos));
        f = U;
        const Z = (f[0] === ' ' || f[0] === '\t')
          ? f.replace(/^[ \t]+/, v => expandTabs(v, 0))
          : f;
        if (beginsInterrupt(f, n, true)) break;
        if (firstNonSpace(Z) >= R || !f.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || (m.includes('\t') ? firstNonSpace(m.replace(/\t/g, '    ')) : firstNonSpace(m)) >= 4 ||
              beginsInterrupt(m, n, false)) break;
          let qe = f;
          if (/^ {0,3}(?:=+|-+) *$/.test(f)) {
            const lh = scanLheading(m + '\n' + f, 0);
            if (lh && lh.end === m.length + 1 + f.length) qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        y = !f.trim();
        epos = Math.min(str.length, epos + U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = str.slice(itemStart, epos);
    if (!list.loose) {
      if (prevBlank) list.loose = true;
      else if (endsWithDoubleBlank(A)) prevBlank = true;
    }
    list.items.push({
      type: 'list_item', raw: A, task: RE_LIST_TASK.test(d),
      loose: false, text: d, tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = str.slice(0, epos).trimEnd();
  for (const item of list.items) {
    ST.top = false;
    item.tokens = lexBlocks(item.text, [], false);
    if (!list.loose) {
      let hasSpace = false, hasBlankSpace = false;
      for (const t of item.tokens) {
        if (t.type !== 'space') continue;
        hasSpace = true;
        if (RE_ANY_LINE.test(t.raw)) { hasBlankSpace = true; break; }
      }
      list.loose = hasSpace && hasBlankSpace;
    }
  }
  for (const item of list.items) {
    const d0 = item.tokens[0];
    if (item.task && d0 && (d0.type === 'text' || d0.type === 'paragraph')) {
      item.text = item.text.replace(RE_LIST_TASK_STRIP, '');
      d0.raw = d0.raw.replace(RE_LIST_TASK_STRIP, '');
      d0.text = d0.text.replace(RE_LIST_TASK_STRIP, '');
      for (let gi = QUEUE.length - 1; gi >= 0; gi--) {
        if (RE_LIST_TASK.test(QUEUE[gi].src)) {
          QUEUE[gi].src = QUEUE[gi].src.replace(RE_LIST_TASK_STRIP, '');
          break;
        }
      }
      const k = RE_LIST_CHECKBOX.exec(item.raw);
      if (k) {
        const cb = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        item.checked = cb.checked;
        if (list.loose) {
          const t0 = item.tokens[0];
          if (t0 && (t0.type === 'paragraph' || t0.type === 'text') && t0.tokens) {
            t0.raw = cb.raw + t0.raw;
            t0.text = cb.raw + t0.text;
            t0.tokens.unshift(cb);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: cb.raw, text: cb.raw, tokens: [cb] });
          }
        } else {
          item.tokens.unshift(cb);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return { token: list, rawLength: list.raw.length };
}

// ------------------------------------------------------------- block pass
// Mirrors marked's Lexer.blockTokens: same token order, same merging.
// Returns the tokens array it was given. On return, ST.top is true again
// (marked resets it at the end of every blockTokens call).

function lexBlocks(s, tokens, mergeParas) {
  let pos = 0;
  const len = s.length;
  let n = mergeParas;
  while (pos < len) {
    // space
    const spEnd = scanSpace(s, pos);
    if (spEnd > pos) {
      const rawLen = spEnd - pos;
      const prev = tokens[tokens.length - 1];
      if (rawLen === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push({ type: 'space', raw: s.slice(pos, spEnd) });
      pos = spEnd;
      continue;
    }
    // indented code
    const code = scanIndentedCode(s, pos);
    if (code) {
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + s.slice(pos, code.end);
        prev.text += '\n' + code.text;
        QUEUE[QUEUE.length - 1].src = prev.text;
      } else {
        tokens.push({ type: 'code', raw: s.slice(pos, code.end), text: code.text, codeBlockStyle: 'indented' });
      }
      pos = code.end;
      continue;
    }
    // fences
    const fence = scanFences(s, pos);
    if (fence) {
      tokens.push({ type: 'code', raw: s.slice(pos, fence.end), text: fence.text, lang: fence.lang });
      pos = fence.end;
      continue;
    }
    // heading
    const heading = scanHeading(s, pos);
    if (heading) {
      const tok = {
        type: 'heading', raw: s.slice(pos, heading.end), depth: heading.depth,
        text: heading.text, tokens: queueInline(heading.text),
      };
      tokens.push(tok);
      pos = heading.end;
      continue;
    }
    // hr
    const hr = scanHr(s, pos);
    if (hr) {
      tokens.push({ type: 'hr', raw: s.slice(pos, hr.end) });
      pos = hr.end;
      continue;
    }
    // blockquote
    if (isQuoteBegin(s, pos)) {
      const bq = blockquoteToken(s.slice(pos));
      if (bq) {
        tokens.push(bq.token);
        pos += bq.rawLength;
        continue;
      }
    }
    // list
    if (listGateAt(s, pos) >= 0) {
      const li = listToken(s.slice(pos));
      if (li) {
        tokens.push(li.token);
        pos += li.rawLength;
        continue;
      }
    }
    // html
    const html = scanHtmlBlock(s, pos);
    if (html) {
      tokens.push({ type: 'html', block: true, raw: html.text, text: html.text, pre: html.pre });
      pos = html.end;
      continue;
    }
    // def
    const def = scanDef(s, pos);
    if (def) {
      const raw = s.slice(pos, def.end);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
        QUEUE[QUEUE.length - 1].src = prev.text;
      } else {
        if (!Object.hasOwn(LINKS, def.tag)) LINKS[def.tag] = { href: def.href, title: def.title };
        tokens.push({ type: 'def', tag: def.tag, raw, href: def.href, title: def.title });
      }
      pos = def.end;
      continue;
    }
    // table
    const table = scanTable(s, pos);
    if (table) {
      const tok = { type: 'table', raw: s.slice(pos, table.end), header: [], align: table.aligns, rows: [] };
      for (let ci = 0; ci < table.header.length; ci++) {
        tok.header.push({ text: table.header[ci], tokens: queueInline(table.header[ci]), header: true, align: table.aligns[ci] });
      }
      for (const row of table.rows) {
        tok.rows.push(row.map((cell, ci) => ({ text: cell, tokens: queueInline(cell), header: false, align: table.aligns[ci] })));
      }
      tokens.push(tok);
      pos = table.end;
      continue;
    }
    // lheading
    const lh = scanLheading(s, pos);
    if (lh) {
      const tok = {
        type: 'heading', raw: s.slice(pos, lh.end), depth: lh.depth,
        text: lh.text, tokens: queueInline(lh.text),
      };
      tokens.push(tok);
      pos = lh.end;
      continue;
    }
    // paragraph (top level only) or text
    if (ST.top) {
      const pEnd = scanParagraph(s, pos, 'normal');
      if (pEnd > pos) {
        const text = s.slice(pos, pEnd);
        const prev = tokens[tokens.length - 1];
        const tok = { type: 'paragraph', raw: text, text, tokens: queueInline(text) };
        if (n && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + text;
          prev.text += '\n' + text;
          QUEUE.pop();
          QUEUE[QUEUE.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        n = false;
        pos = pEnd;
        continue;
      }
    }
    // text: a single line
    const tEnd = eolAt(s, pos);
    if (tEnd > pos) {
      const text = s.slice(pos, tEnd);
      const prev = tokens[tokens.length - 1];
      const tok = { type: 'text', raw: text, text, tokens: queueInline(text) };
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + text;
        prev.text += '\n' + text;
        QUEUE.pop();
        QUEUE[QUEUE.length - 1].src = prev.text;
      } else {
        tokens.push(tok);
      }
      pos = tEnd;
      continue;
    }
    // Unreachable in practice (a non-empty remainder always matches one
    // of the branches); advance one char to guarantee progress.
    pos++;
  }
  ST.top = true;
  return tokens;
}

// ------------------------------------------------------------- inline pass

const RE_CODE_INLINE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_START_ANGLE = /^</;

let MASKTOP = null;
const NO_CLOSERS_EM = Object.freeze({ '*': -1, '_': -1 });

// marked's fe(): for each run of *, _ or ~ in the masked source, remember
// the run's start index as the last possible closer when the character
// before the run is not blank-ish.
function computeClosers(a) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const len = a.length;
  for (let s = 0; s < len; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    while (i < len && a[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Early-exit variant of computeClosers: is there any recorded closer?
function hasAnyCloser(a) {
  const len = a.length;
  for (let s = 0; s < len; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    while (i < len && a[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') return true;
    s = i - 1;
  }
  return false;
}

function emCloser(masked, ch) {
  const top = MASKTOP;
  if (top && top.maskedSrc === masked) return top.em[ch];
  return computeClosers(masked).em[ch];
}

function delCloser(masked) {
  const top = MASKTOP;
  if (top && top.maskedSrc === masked) return top.del;
  return computeClosers(masked).del;
}

// marked's linkInText: does this label text itself contain a link?
function linkInText(e) {
  if (!e.includes('[')) return false;
  for (const m of e.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(m[0]) && e.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of e.matchAll(RE_REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(LINKS, labelKey(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1)))) return true;
  }
  return false;
}

function maskReflink(r) {
  const o = r.lastIndexOf('[');
  if (!Object.hasOwn(LINKS, labelKey(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(inner)) {
      return '[' + inner.replace(RE_REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

// marked's masking pass over an inline source before emphasis scanning.
// Each replace is skipped when the source cannot contain a match.
function maskSrc(src) {
  let t = src;
  if (LINKS && src.includes('[')) t = t.replace(RE_REFLINK_SEARCH, maskReflink);
  if (src.includes('`') || src.includes('\\')) {
    t = t.replace(RE_MASK_CODE, (n, s, r) => r
      ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(RE_BLOCK_SKIP, n => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  }
  return t;
}

// marked's Be(): true when the label contains a tag or autolink that
// extends past the label's end (which kills the link).
function labelHasLongTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = RE_CODE_INLINE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(offset + s);
    const o = RE_TAG.exec(r) || RE_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// marked's De(): tokenize a link/image label; a non-image link whose
// label itself emitted a link fails (returns undefined).
function outputLink(match, href, title, raw) {
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = ST.inLink;
  const savedEmitted = ST.linkEmitted;
  const savedRaw = ST.inRawBlock;
  ST.inLink = true;
  ST.linkEmitted = false;
  const tokens = inlineTokens(text, []);
  const emitted = ST.linkEmitted;
  ST.linkEmitted = savedEmitted;
  ST.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ST.inRawBlock = savedRaw;
      return undefined;
    }
    ST.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title: title || null, text, tokens };
}

function tryEscape(src, pos) {
  if (src[pos + 1] !== undefined && PUNCT_SET.has(src[pos + 1])) {
    return { type: 'escape', raw: src.slice(pos, pos + 2), text: src[pos + 1] };
  }
  return undefined;
}

function tryBr(src, pos) {
  let q;
  if (src[pos] === '\\') {
    q = pos + 1;
  } else {
    q = pos;
    while (src[q] === ' ') q++;
    if (q - pos < 2) return undefined;
  }
  if (src[q] !== '\n') return undefined;
  // The pattern's (?!\s*$) lookahead: some non-whitespace must follow.
  let hasContent = false;
  for (let p = q + 1; p < src.length; p++) {
    if (!/\s/.test(src[p])) { hasContent = true; break; }
  }
  if (!hasContent) return undefined;
  let end = q + 1;
  while (src[end] === ' ' || src[end] === '\t') end++;
  return { type: 'br', raw: src.slice(pos, end) };
}

function tryTag(src, pos) {
  const m = RE_TAG.exec(src.slice(pos));
  if (!m) return undefined;
  const raw = m[0];
  if (!ST.inLink && RE_START_A.test(raw)) ST.inLink = true;
  else if (ST.inLink && RE_END_A.test(raw)) ST.inLink = false;
  if (!ST.inRawBlock && RE_START_PRE.test(raw)) ST.inRawBlock = true;
  else if (ST.inRawBlock && RE_END_PRE.test(raw)) ST.inRawBlock = false;
  return { type: 'html', raw, text: raw, block: false };
}

function tryAutolink(src, pos) {
  const m = RE_AUTOLINK.exec(src.slice(pos));
  if (!m) return undefined;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tryLink(src, pos) {
  if (ST.linkParenPossible === false) return undefined;
  const rest = src.slice(pos);
  const m = RE_LINK.exec(rest);
  if (!m) return undefined;
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasLongTag(rest, m[1], offset)) return undefined;
  const match = [m[0], m[1], m[2], m[3]];
  const s = match[2].trim();
  if (RE_START_ANGLE.test(s)) {
    if (!/>$/.test(s)) return undefined;
    const l = rtrimChar(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return undefined;
  } else {
    const l = findClosing(match[2], '()');
    if (l === -2) return undefined;
    if (l > -1) {
      const h = (match[0].indexOf('!') === 0 ? 5 : 4) + match[1].length + l;
      match[2] = match[2].substring(0, l);
      match[0] = match[0].substring(0, h).trim();
      match[3] = '';
    }
  }
  const r = rtrimChar(match[0].slice(0, -1), '\\');
  if ((match[0].length - r.length) % 2 === 0) return undefined;
  let href = match[2].trim();
  if (RE_START_ANGLE.test(href)) href = href.slice(1, -1);
  const title = match[3] ? match[3].slice(1, -1) : '';
  return outputLink(match, href && href.replace(RE_ANY_PUNCT, '$1'), title && title.replace(RE_ANY_PUNCT, '$1'), match[0]);
}

function tryReflink(src, pos) {
  const rest = src.slice(pos);
  const m = RE_REFLINK.exec(rest) || RE_NOLINK.exec(rest);
  if (!m) return undefined;
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasLongTag(rest, m[1], offset)) return undefined;
  const def = LINKS[labelKey(m[2] || m[1])];
  if (!def) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return outputLink(m, def.href, def.title, m[0]);
}

// Code-point count of s (like [...s].length) without allocating.
function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) i++;
    n++;
  }
  return n;
}

// Code-unit length of the first code point of s (1 or 2).
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF && s.length > 1 ? 2 : 1;
}

function lastCodePoint(str) {
  if (str === '') return '';
  const c = str.charCodeAt(str.length - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && str.length >= 2) {
    const c2 = str.charCodeAt(str.length - 2);
    if (c2 >= 0xD800 && c2 <= 0xDBFF) return str.slice(str.length - 2);
  }
  return str[str.length - 1];
}

function tryEmStrong(src, pos, masked, prevChar) {
  RE_EM_LDELIM_Y.lastIndex = pos;
  const s = RE_EM_LDELIM_Y.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return undefined;
  const r = s[0][0];
  const wasDelim = prevChar === r;
  let l = pos;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = lastCodePoint(masked.slice(Math.max(0, l - 2), l));
  const h = p === '*' || p === '_' || isPunctSpace(p);
  let n = prevChar;
  if (l < pos) n = p;
  const u = l < pos ? h : isPunctSpace(n);
  if (s[4] && RE_ALNUM.test(n)) return undefined;
  const d = s[1] || s[3] || '';
  if (!(!d || !n || u)) return undefined;
  if (r !== '*' && r !== '_') return undefined;
  const k = cpLen(s[0]) - 1;
  let bal = k;
  let f = 0;
  const y = pos - l + k;
  const R = !!p.trim() && (!!d || (r === '*' && !h));
  const RD = r === '*' ? RE_EM_RDELIM_AST_G : RE_EM_RDELIM_UND_G;
  const RDF = r === '*' ? RE_EM_RDELIM_AST_FIRST : RE_EM_RDELIM_UND_FIRST;
  const v = emCloser(masked, r);
  const Q = pos + k;
  if (v < Q) return undefined;
  const ee = v - Q;
  let scanFrom = Q;
  RDF.lastIndex = Q;
  const fm = RDF.exec(masked);
  if (fm) scanFrom = Q + fm[0].length;
  RD.lastIndex = scanFrom;
  let m;
  while ((m = RD.exec(masked)) !== null && !(m.index - Q > ee)) {
    const rel = m.index - Q;
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    let b = g.length;
    if (m[3] || m[4]) { bal += b; continue; }
    if (m[5] || m[6] || R) {
      if (wasDelim && (m[5] || m[6])) break;
      if (y % 3 && !((y + b) % 3)) { f += b; continue; }
    }
    bal -= b;
    if (bal > 0) continue;
    b = Math.min(b, b + bal + f);
    const te = firstCpLen(m[0]);
    const raw = src.slice(pos, pos + k + rel + te + b);
    if (Math.min(k, b) % 2) {
      const inner = raw.slice(1, -1);
      return { type: 'em', raw, text: inner, tokens: inlineTokens(inner, []) };
    }
    const inner = raw.slice(2, -2);
    return { type: 'strong', raw, text: inner, tokens: inlineTokens(inner, []) };
  }
  return undefined;
}

function tryDel(src, pos, masked, prevChar) {
  RE_DEL_LDELIM_Y.lastIndex = pos;
  const s = RE_DEL_LDELIM_Y.exec(src);
  if (!s) return undefined;
  if (!(!(s[1] || '') || !prevChar || isPunctSpace(prevChar))) return undefined;
  const o = cpLen(s[0]) - 1;
  let p = o;
  const u = delCloser(masked);
  const d = pos + o;
  if (u < d) return undefined;
  const k = u - d;
  let scanFrom = d;
  RE_DEL_RDELIM_FIRST.lastIndex = d;
  const fm = RE_DEL_RDELIM_FIRST.exec(masked);
  if (fm) scanFrom = d + fm[0].length;
  RE_DEL_RDELIM_G.lastIndex = scanFrom;
  let m;
  while ((m = RE_DEL_RDELIM_G.exec(masked)) !== null && !(m.index - d > k)) {
    const rel = m.index - d;
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    let l = g.length;
    if (l !== o) continue;
    if (m[3] || m[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const g0 = firstCpLen(m[0]);
    const raw = src.slice(pos, pos + o + rel + g0 + l);
    const inner = raw.slice(o, raw.length - o);
    return { type: 'del', raw, text: inner, tokens: inlineTokens(inner, []) };
  }
  return undefined;
}

function tryCodespan(src, pos) {
  let runEnd = pos;
  while (src[runEnd] === '`') runEnd++;
  if (runEnd >= src.length || src[runEnd] === '`') return undefined;
  const runLen = runEnd - pos;
  let q = runEnd;
  while (q < src.length) {
    const idx = src.indexOf('`', q);
    if (idx < 0) return undefined;
    let re = idx;
    while (src[re] === '`') re++;
    if (re - idx === runLen && idx > runEnd) {
      const content = src.slice(runEnd, idx);
      let text = content.replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
        text = text.substring(1, text.length - 1);
      }
      return { type: 'codespan', raw: src.slice(pos, re), text };
    }
    q = re;
  }
  return undefined;
}

function tryUrl(src, pos) {
  const m = RE_URL.exec(src.slice(pos));
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    for (;;) {
      const prev = cur;
      const bp = RE_BACKPEDAL.exec(cur);
      cur = bp ? bp[0] : '';
      if (prev === cur) break;
    }
    text = cur;
    if (!text) return undefined;
    href = m[1] === 'www.' ? 'http://' + text : text;
  }
  return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

// ------------------------------------------------------- inline text scan

function isAlnumCh(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

// marked's gfm inline text rule as a scanner: returns the end position
// of the text run starting at pos.
// marked's gfm inline text rule (the ^ anchor is dropped; the sticky flag
// anchors the match at lastIndex instead). One exec finds the whole text
// run: the first unit plus the lazy run up to the next position where
// another inline construct, an autolink start, or a hard break can begin.
const RE_TEXT_RUN = /(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/y;

function scanInlineText(src, pos) {
  RE_TEXT_RUN.lastIndex = pos;
  const m = RE_TEXT_RUN.exec(src);
  return m ? pos + m[0].length : pos + 1;
}

// ---------------------------------------------------------- inline driver

function inlineTokens(src, out) {
  const savedParen = ST.linkParenPossible;
  ST.linkParenPossible = savedParen && src.includes(')');
  const savedTop = MASKTOP;
  try {
    let masked = src;
    const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
    if (!hasDelim) {
      MASKTOP = { maskedSrc: masked, em: NO_CLOSERS_EM, del: -1 };
    } else {
      // Masking only ever removes delimiter runs (code spans, links, tags
      // and escapes become '+'/'a' runs) and never makes a run's preceding
      // character blank, so closers present in the masked source are a
      // subset of the raw ones: when the raw source has no closer at all,
      // emphasis can never form and masking can be skipped outright.
      if (!hasAnyCloser(src)) {
        MASKTOP = { maskedSrc: masked, em: NO_CLOSERS_EM, del: -1 };
      } else {
        masked = maskSrc(src);
        MASKTOP = { maskedSrc: masked, ...computeClosers(masked) };
      }
    }
    inlineLoop(src, masked, out);
  } finally {
    MASKTOP = savedTop;
    ST.linkParenPossible = savedParen;
  }
  return out;
}

function inlineLoop(src, masked, out) {
  let pos = 0;
  const len = src.length;
  let prevChar = '';
  let textFlag = false;
  while (pos < len) {
    if (!textFlag) prevChar = '';
    textFlag = false;
    const c = src[pos];
    let tok;
    if (c === '\\') {
      tok = tryEscape(src, pos) || tryBr(src, pos);
    } else if (c === '<') {
      tok = tryTag(src, pos) || tryAutolink(src, pos);
    } else if (c === '[' || c === '!') {
      tok = tryLink(src, pos);
      if (tok === undefined) {
        tok = tryReflink(src, pos);
        if (tok && tok.type === 'text') {
          const prev = out[out.length - 1];
          if (prev && prev.type === 'text') {
            prev.raw += tok.raw;
            prev.text += tok.text;
          } else {
            out.push(tok);
          }
          pos += tok.raw.length;
          continue;
        }
      }
    } else if (c === '*' || c === '_') {
      tok = tryEmStrong(src, pos, masked, prevChar);
    } else if (c === '`') {
      tok = tryCodespan(src, pos);
    } else if (c === '~') {
      tok = tryDel(src, pos, masked, prevChar);
    } else if (c === ' ') {
      tok = tryBr(src, pos);
    }
    if (tok === undefined && !ST.inLink && isUrlStartChar(c)) {
      tok = tryUrl(src, pos);
    }
    if (tok !== undefined) {
      out.push(tok);
      pos += tok.raw.length;
      continue;
    }
    const end = scanInlineText(src, pos);
    const raw = src.slice(pos, end);
    const inRaw = ST.inRawBlock;
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text') {
      prev.raw += raw;
      prev.text += inRaw ? raw : decodeNumericRefs(raw);
    } else {
      out.push({ type: 'text', raw, text: inRaw ? raw : decodeNumericRefs(raw), escaped: inRaw });
    }
    if (raw.charAt(raw.length - 1) !== '_') prevChar = raw.charAt(raw.length - 1);
    textFlag = true;
    pos = end;
  }
  return out;
}

function isUrlStartChar(c) {
  return isAlnumCh(c) || c === '.' || c === '_' || c === '+' || c === '-';
}

// ------------------------------------------------------------- rendering
// A pure walk of the token tree producing marked's exact strings. The
// textMode flag renders with marked's TextRenderer (used for image alt
// text): tags stripped, inner text kept.

function renderInline(tokens, textMode) {
  let out = '';
  for (const t of tokens) out += renderInlineToken(t, textMode);
  return out;
}

function renderInlineToken(t, textMode) {
  switch (t.type) {
    case 'escape':
      return textMode ? t.text : escapeHtml(t.text, false);
    case 'html':
      return t.text;
    case 'link': {
      if (textMode) return t.tokens ? renderInline(t.tokens, true) : t.text;
      const inner = t.autolink ? escapeHtml(t.text, true) : renderInline(t.tokens, false);
      const clean = cleanUrl(t.href);
      if (clean === null) return inner;
      let out = '<a href="' + escapeHtml(clean, t.autolink ? true : false) + '"';
      if (t.title) out += ' title="' + escapeHtml(t.title, false) + '"';
      return out + '>' + inner + '</a>';
    }
    case 'image': {
      const alt = t.tokens ? renderInline(t.tokens, true) : t.text;
      if (textMode) return alt;
      const clean = cleanUrl(t.href);
      if (clean === null) return escapeHtml(alt, false);
      let out = '<img src="' + escapeHtml(clean, false) + '" alt="' + escapeHtml(alt, false) + '"';
      if (t.title) out += ' title="' + escapeHtml(t.title, false) + '"';
      return out + '>';
    }
    case 'strong':
      return textMode ? renderInline(t.tokens, true) : '<strong>' + renderInline(t.tokens, false) + '</strong>';
    case 'em':
      return textMode ? renderInline(t.tokens, true) : '<em>' + renderInline(t.tokens, false) + '</em>';
    case 'del':
      return textMode ? renderInline(t.tokens, true) : '<del>' + renderInline(t.tokens, false) + '</del>';
    case 'codespan':
      return textMode ? t.text : '<code>' + escapeHtml(t.text, true) + '</code>';
    case 'br':
      return textMode ? '' : '<br>';
    case 'checkbox':
      return textMode ? t.raw
        : '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'text': {
      if (t.tokens) return renderInline(t.tokens, textMode);
      if (textMode) return t.text;
      return t.escaped ? t.text : escapeHtml(t.text, false);
    }
  }
  return '';
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + renderInline(cell.tokens, false) + '</' + tag + '>\n';
}

function renderBlocks(tokens) {
  let out = '';
  for (const t of tokens) out += renderBlock(t);
  return out;
}

function renderBlock(t) {
  switch (t.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return '<h' + t.depth + '>' + renderInline(t.tokens, false) + '</h' + t.depth + '>\n';
    case 'code': {
      const word = /^\S*/.exec(t.lang || '')[0];
      const body = t.text ? escapeHtml(t.text.replace(/\n$/, '') + '\n', true) : '';
      return word
        ? '<pre><code class="language-' + escapeHtml(word, false) + '">' + body + '</code></pre>\n'
        : '<pre><code>' + body + '</code></pre>\n';
    }
    case 'table': {
      let head = '';
      for (const cell of t.header) head += renderCell(cell);
      let body = '';
      for (const row of t.rows) {
        let r = '';
        for (const cell of row) r += renderCell(cell);
        body += '<tr>\n' + r + '</tr>\n';
      }
      return '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
        (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
    }
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(t.tokens) + '</blockquote>\n';
    case 'list': {
      let items = '';
      for (const item of t.items) items += '<li>' + renderBlocks(item.tokens) + '</li>\n';
      const tag = t.ordered ? 'ol' : 'ul';
      const startAttr = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
      return '<' + tag + startAttr + '>\n' + items + '</' + tag + '>\n';
    }
    case 'checkbox':
      return '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'html':
      return t.text;
    case 'paragraph':
      return '<p>' + renderInline(t.tokens, false) + '</p>\n';
    case 'text':
      return renderInlineToken(t, false);
  }
  return '';
}

// ------------------------------------------------------------- entry point

export function parse(markdown) {
  const rawSrc = String(markdown);
  const src = rawSrc.includes('\r') ? rawSrc.replace(/\r\n|\r/g, '\n') : rawSrc;
  LINKS = Object.create(null);
  QUEUE = [];
  ST = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  MASKTOP = null;
  const tokens = lexBlocks(src, [], false);
  for (let i = 0; i < QUEUE.length; i++) {
    const job = QUEUE[i];
    ST.inRawBlock = false;
    inlineTokens(job.src, job.tokens);
  }
  QUEUE = null;
  LINKS = null;
  return renderBlocks(tokens);
}
