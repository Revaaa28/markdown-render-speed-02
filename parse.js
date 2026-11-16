// FastMark — a dependency-free Markdown-to-HTML parser whose output is
// byte-identical to marked 18.1.3 with default options (GFM on, breaks and
// pedantic off), built for speed.
//
// Strategy: mirror the reference pipeline (block lexer with the same
// tokenizer order and merge rules, then a queued inline lexer with the same
// rule order and delimiter masking, then the same renderer strings), but
// scan with an index cursor over the full source string using sticky
// regular expressions instead of slicing a fresh suffix string for every
// tokenizer attempt.
//
// The rule tables in this first section are grammar data: they state what
// the reference grammar matches. Every decision about how to scan, merge,
// mask and render is made by the hand-written code that follows them.

const RB = {
  blockquote: new RegExp("^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+", ""),
  code: new RegExp("^((?: {4}| {0,3}\\t)[^\\n]+(?:\\n(?:[ \\t]*(?:\\n|$))*)?)+", ""),
  def: new RegExp("^ {0,3}\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)", ""),
  fences: new RegExp("^ {0,3}(`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})([^\\n]*)(?:\\n|$)(?:|([\\s\\S]*?)(?:\\n|$))(?: {0,3}(?:(?=`)\\1`*|(?=~)\\1~*) *(?=\\n|$)|$)", ""),
  heading: new RegExp("^ {0,3}(#{1,6})(?=\\s|$)(.*)(?:\\n+|$)", ""),
  hr: new RegExp("^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)", ""),
  html: new RegExp("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i"),
  lheading: new RegExp("^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)", ""),
  list: new RegExp("^( {0,3}(?:[*+-]|\\d{1,9}[.)]))([ \\t][^\\n]*?)?(?:\\n|$)", ""),
  newline: new RegExp("^(?:[ \\t]*(?:\\n|$))+", ""),
  paragraph: new RegExp("^([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)", ""),
  table: new RegExp("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)", ""),
  text: new RegExp("^[^\\n]+", ""),
};
const RI = {
  _backpedal: new RegExp("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+", ""),
  anyPunctuation: new RegExp("\\\\([\\p{P}\\p{S}])", "gu"),
  anyPunctuationOutsideCode: new RegExp("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", "gu"),
  autolink: new RegExp("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>", ""),
  blockSkip: new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g"),
  br: new RegExp("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*", ""),
  code: new RegExp("^(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)", ""),
  del: new RegExp("^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)", ""),
  delLDelim: new RegExp("^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])", "u"),
  delRDelim: new RegExp("^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])", "gu"),
  emStrongLDelim: new RegExp("^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?", "u"),
  emStrongRDelimAst: new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu"),
  emStrongRDelimUnd: new RegExp("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])", "gu"),
  escape: new RegExp("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])", ""),
  link: new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)", ""),
  nolink: new RegExp("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?", ""),
  punctuation: new RegExp("^((?![*_])[\\s\\p{P}\\p{S}])", "u"),
  reflink: new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]", ""),
  reflinkSearch: new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g"),
  tag: new RegExp("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", ""),
  text: new RegExp("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))", ""),
  url: new RegExp("^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])", ""),
};
const RO = {
  codeRemoveIndent: new RegExp("^(?: {0,3}\\t| {1,4})", "gm"),
  outputLinkReplace: new RegExp("\\\\([\\[\\]])", "g"),
  indentCodeCompensation: new RegExp("^(\\s+)(?:```)", ""),
  beginningSpace: new RegExp("^\\s+", ""),
  endingHash: new RegExp("#$", ""),
  startingSpaceChar: new RegExp("^ ", ""),
  endingSpaceChar: new RegExp(" $", ""),
  endingSpaceTabChar: new RegExp("[ \\t]$", ""),
  nonSpaceChar: new RegExp("[^ ]", ""),
  newLineCharGlobal: new RegExp("\\n", "g"),
  tabCharGlobal: new RegExp("\\t", "g"),
  leadingSpaceTab: new RegExp("^[ \\t]+", ""),
  multipleSpaceGlobal: new RegExp("\\s+", "g"),
  blankLine: new RegExp("^[ \\t]*$", ""),
  doubleBlankLine: new RegExp("\\n[ \\t]*\\n[ \\t]*$", ""),
  blockquoteStart: new RegExp("^ {0,3}>", ""),
  blockquoteSetextReplace: new RegExp("\\n {0,3}((?:=+|-+)[ \\t]*)(?=\\n|$)", "g"),
  blockquoteSetextReplace2: new RegExp("^ {0,3}>[ \\t]?", "gm"),
  blockquoteMarkerWhitespace: new RegExp("^( {0,3}>)([ \\t]+)", "gm"),
  listReplaceNesting: new RegExp("^ {1,4}(?=( {4})*[^ ])", "g"),
  listIsTask: new RegExp("^\\[[ xX]\\][ \\t]+\\S", ""),
  listReplaceTask: new RegExp("^\\[[ xX]\\][ \\t]+", ""),
  listTaskCheckbox: new RegExp("\\[[ xX]\\]", ""),
  anyLine: new RegExp("\\n.*\\n", ""),
  hrefBrackets: new RegExp("^<(.*)>$", ""),
  tableDelimiter: new RegExp("[:|]", ""),
  tableAlignChars: new RegExp("^\\||\\| *$", "g"),
  tableRowBlankLine: new RegExp("\\n[ \\t]*$", ""),
  tableAlignRight: new RegExp("^ *-+: *$", ""),
  tableAlignCenter: new RegExp("^ *:-+: *$", ""),
  tableAlignLeft: new RegExp("^ *:-+ *$", ""),
  startATag: new RegExp("^<a ", "i"),
  endATag: new RegExp("^<\\/a>", "i"),
  startPreScriptTag: new RegExp("^<(pre|code|kbd|script)(\\s|>)", "i"),
  endPreScriptTag: new RegExp("^<\\/(pre|code|kbd|script)(\\s|>)", "i"),
  startAngleBracket: new RegExp("^<", ""),
  endAngleBracket: new RegExp(">$", ""),
  pedanticHrefTitle: new RegExp("^([^'\"]*[^\\s])\\s+(['\"])(.*)\\2", ""),
  unicodeAlphaNumeric: new RegExp("[\\p{L}\\p{N}]", "u"),
  numericCharacterReference: new RegExp("&#(?:(\\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));", ""),
  numericCharacterReferenceOrAmpersand: new RegExp("&#(?:(\\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", "g"),
  escapeTest: new RegExp("[&<>\"']", ""),
  escapeReplace: new RegExp("[&<>\"']", "g"),
  escapeTestNoEncode: new RegExp("[<>\"']|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", ""),
  escapeReplaceNoEncode: new RegExp("[<>\"']|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", "g"),
  caret: new RegExp("(^|[^\\[])\\^", "g"),
  percentDecode: new RegExp("%25", "g"),
  findPipe: new RegExp("\\|", "g"),
  splitPipe: new RegExp(" \\|", ""),
  slashPipe: new RegExp("\\\\\\|", "g"),
  carriageReturn: new RegExp("\\r\\n|\\r", "g"),
  spaceLine: new RegExp("^ +$", "gm"),
  notSpaceStart: new RegExp("^\\S*", ""),
  endingNewline: new RegExp("\\n$", ""),
};

// ---------------------------------------------------------------------------
// Scanning machinery
// ---------------------------------------------------------------------------

// Sticky twin of an anchored rule: the ^ anchors at the start of the
// pattern and at the start of each top-level alternative are dropped and
// the sticky flag added, so the match is attempted exactly at lastIndex
// against the full string. ($ assertions inside the patterns still mean
// end of the whole string, which is exactly the end of the
// not-yet-consumed suffix.)
function anchored(re) {
  const src = re.source;
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      out += c + src[i + 1];
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '^' && !inClass && (out === '' || out.endsWith('|') || out.endsWith('('))) continue;
    out += c;
  }
  return new RegExp(out, re.flags + 'y');
}

function execAt(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

const SB = {
  newline: anchored(RB.newline),
  code: anchored(RB.code),
  fences: anchored(RB.fences),
  heading: anchored(RB.heading),
  hr: anchored(RB.hr),
  blockquote: anchored(RB.blockquote),
  list: anchored(RB.list),
  html: anchored(RB.html),
  def: anchored(RB.def),
  table: anchored(RB.table),
  lheading: anchored(RB.lheading),
  paragraph: anchored(RB.paragraph),
  text: anchored(RB.text),
};

const SI = {
  escape: anchored(RI.escape),
  tag: anchored(RI.tag),
  link: anchored(RI.link),
  reflink: anchored(RI.reflink),
  nolink: anchored(RI.nolink),
  emStrongLDelim: anchored(RI.emStrongLDelim),
  code: anchored(RI.code),
  br: anchored(RI.br),
  delLDelim: anchored(RI.delLDelim),
  autolink: anchored(RI.autolink),
  url: anchored(RI.url),
  text: anchored(RI.text),
};

// Parameterized line-start rules used by the list tokenizer. The reference
// caches one regex per clamped indent width; do the same.
function clampedFactory(build) {
  const cache = [undefined, undefined, undefined, undefined];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    if (cache[i] === undefined) cache[i] = build(i);
    return cache[i];
  };
}

const HTML_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const nextBulletRegex = clampedFactory((a) => new RegExp('^ {0,' + a + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'));
const hrRegex = clampedFactory((a) => new RegExp('^ {0,' + a + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'));
const fencesBeginRegex = clampedFactory((a) => new RegExp('^ {0,' + a + '}(?:```|~~~)'));
const headingBeginRegex = clampedFactory((a) => new RegExp('^ {0,' + a + '}#{1,6}(?:\\s|$)'));
const htmlBeginRegex = clampedFactory((a) => new RegExp('^ {0,' + a + '}(?:</?(?:' + HTML_TAGS + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));
const blockquoteBeginRegex = clampedFactory((a) => new RegExp('^ {0,' + a + '}>'));

const listItemCache = new Map();
function listItemRegex(bullet) {
  let re = listItemCache.get(bullet);
  if (re === undefined) {
    re = new RegExp('^( {0,3}' + bullet + ')((?:[\t ][^\\n]*)?(?:\\n|$))');
    listItemCache.set(bullet, re);
  }
  return re;
}

// ---------------------------------------------------------------------------
// Small pure helpers (string surgery shared by tokenizers and renderer)
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(str, encode) {
  if (encode) {
    if (RO.escapeTest.test(str)) return str.replace(RO.escapeReplace, (c) => ESCAPE_MAP[c]);
  } else if (RO.escapeTestNoEncode.test(str)) {
    return str.replace(RO.escapeReplaceNoEncode, (c) => ESCAPE_MAP[c]);
  }
  return str;
}

// Decode numeric character references; a bare & that cannot start a valid
// reference becomes &amp;.
function unescapeEntities(str) {
  if (!RO.numericCharacterReference.test(str)) return str;
  return str.replace(RO.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(RO.percentDecode, '%');
  } catch {
    return null;
  }
}

// Remove trailing occurrences of ch (or, with invert, trailing chars != ch).
function rtrimChar(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let s = 0;
  while (s < n) {
    const r = str.charAt(n - s - 1);
    if (r === ch && !invert) s++;
    else if (r !== ch && invert) s++;
    else break;
  }
  return str.slice(0, n - s);
}

// Cap a run of trailing blank lines so at most one blank line remains.
function capTrailingBlankLines(str) {
  const lines = str.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && RO.blankLine.test(lines[t])) t--;
  return lines.length - t <= 2 ? str : lines.slice(0, t + 1).join('\n');
}

function resolveId(str) {
  return str.trim().replace(RO.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the closer matching the bracket pair in str: index, -1 when there is
// no bracket at all or they balance, -2 when an opener is left unclosed.
function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < str.length; n++) {
    if (str[n] === '\\') n++;
    else if (str[n] === pair[0]) depth++;
    else if (str[n] === pair[1] && --depth < 0) return n;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tab stops every 4 columns from startCol.
function expandTabs(str, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const pad = 4 - (col % 4);
      out += ' '.repeat(pad);
      col += pad;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row on unescaped pipes, then normalize the cell list to the
// optional expected count.
function splitCells(row, count) {
  const spaced = row.replace(RO.findPipe, (m, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(RO.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(RO.slashPipe, '|');
  return cells;
}

// Remove the indentation a fenced code block's content inherited from an
// indented opening fence.
function indentCompensation(raw, content) {
  const m = raw.match(RO.indentCodeCompensation);
  if (m === null) return content;
  const indent = m[1];
  return content
    .split('\n')
    .map((line) => {
      const lead = line.match(RO.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Lexer state (one per parse call)
// ---------------------------------------------------------------------------

let L = null;

function queueInline(text) {
  const tokens = [];
  L.inlineQueue.push({ src: text, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the full source and a cursor position and
// returns a token or undefined; the caller advances by token.raw.length.
// ---------------------------------------------------------------------------

function spaceToken(src, pos) {
  const m = execAt(SB.newline, src, pos);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  return undefined;
}

function indentedCodeToken(src, pos) {
  const m = execAt(SB.code, src, pos);
  if (!m) return undefined;
  const raw = capTrailingBlankLines(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RO.codeRemoveIndent, '') };
}

function fencesToken(src, pos) {
  const m = execAt(SB.fences, src, pos);
  if (!m) return undefined;
  return {
    type: 'code',
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(RI.anyPunctuation, '$1') : m[2],
    text: indentCompensation(m[0], m[3] || ''),
  };
}

function headingToken(src, pos) {
  const m = execAt(SB.heading, src, pos);
  if (!m) return undefined;
  let text = m[2].trim();
  if (RO.endingHash.test(text)) {
    const stripped = rtrimChar(text, '#');
    if (!stripped || RO.endingSpaceTabChar.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: rtrimChar(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(text) };
}

function hrToken(src, pos) {
  const m = execAt(SB.hr, src, pos);
  if (!m) return undefined;
  return { type: 'hr', raw: rtrimChar(m[0], '\n') };
}

function blockquoteToken(src, pos) {
  const cap = execAt(SB.blockquote, src, pos);
  if (!cap) return undefined;
  let lines = rtrimChar(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    // One chunk: lines with > markers, plus any lazy continuation lines
    // that precede the first marker line of the next chunk.
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RO.blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        hasMarker = true;
      } else if (!hasMarker) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const chunkStr = chunk.join('\n');
    const inner = chunkStr
      .replace(RO.blockquoteMarkerWhitespace, (m, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RO.blockquoteSetextReplace, '\n    $1')
      .replace(RO.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + chunkStr : chunkStr;
    text = text ? text + '\n' + inner : inner;
    const topSaved = L.state.top;
    L.state.top = true;
    blockTokens(inner, tokens, true);
    L.state.top = topSaved;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      // The inner quote continues: re-lex it together with the rest.
      const merged = last.raw + '\n' + lines.join('\n').replace(RO.blockquoteSetextReplace2, '');
      const ntok = blockquoteToken(merged, 0);
      tokens[tokens.length - 1] = ntok;
      const after = merged.substring(ntok.raw.length).replace(/^\n/, '');
      const restCount = after ? after.split('\n').length : 0;
      const taken = restCount ? lines.slice(0, -restCount) : lines;
      if (taken.length > 0) raw += '\n' + taken.join('\n');
      text = text.substring(0, text.length - last.text.length) + ntok.text;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && RO.blockquoteStart.test(lines[0])) continue;
      break;
    }
    if (last?.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const ntok = listToken(combined, 0);
      tokens[tokens.length - 1] = ntok;
      const used = ntok.raw.length > last.raw.length
        ? combined.slice(last.raw.length + 1, ntok.raw.length).split('\n').length
        : 0;
      if (used > 0) {
        const y = lines.slice(0, used).join('\n');
        raw += '\n' + y;
        text += '\n' + y;
      }
      lines = lines.slice(used);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

// Does the string end with a blank line (the doubleBlankLine rule)?
function endsWithDoubleBlank(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  if (i < 0 || s[i] !== '\n') return false;
  i--;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i >= 0 && s[i] === '\n';
}

// First line of a string without allocating a split array.
function firstLine(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Index of the first character that is not a space, or -1.
function firstNonSpaceIdx(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') return i;
  return -1;
}

// Like firstNonSpaceIdx but on the string with each tab widened to four
// spaces (the width the loose-list checks measure with).
function expandedFirstNonSpaceIdx(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4;
    else return col;
  }
  return -1;
}

// Expand the leading whitespace run of a line, when there is one.
function expandLeading(line, startCol) {
  const c = line[0];
  if (c !== ' ' && c !== '\t') return line;
  return line.replace(RO.leadingSpaceTab, (s) => expandTabs(s, startCol));
}

function listToken(src, pos) {
  const cap = execAt(SB.list, src, pos);
  if (!cap) return undefined;
  const orig = src.slice(pos);
  let e = orig;
  const consumed = () => orig.length - e.length;
  const bullet = cap[1].trim();
  const isOrdered = bullet.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered: isOrdered,
    start: isOrdered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bulletRe = isOrdered ? '\\d{1,9}\\' + bullet.slice(-1) : '\\' + bullet;
  const itemRe = listItemRegex(bulletRe);
  let looseSeen = false;
  while (e) {
    let endEarly = false;
    let itemText = '';
    const m = itemRe.exec(e);
    if (!m || RB.hr.test(e)) break;
    const itemStart = consumed();
    e = e.substring(m[0].length);
    const firstContent = firstLine(m[2]);
    const bulletLen = m[1].length;
    const expanded = expandLeading(firstContent, bulletLen);
    let nextLine = firstLine(e);
    const blankFirst = !expanded.trim();
    let indent = 0;
    if (blankFirst) {
      indent = bulletLen + 1;
    } else {
      indent = firstNonSpaceIdx(expanded);
      if (indent > 4) indent = 1;
      itemText = expanded.slice(indent);
      indent += bulletLen;
    }
    if (blankFirst && RO.blankLine.test(nextLine)) {
      e = e.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBullet = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesBegin = fencesBeginRegex(indent);
      const headingBegin = headingBeginRegex(indent);
      const htmlBegin = htmlBeginRegex(indent);
      const bqBegin = blockquoteBeginRegex(indent);
      let prevContent = expanded;
      let wasBlank = blankFirst;
      while (e) {
        const line = firstLine(e);
        nextLine = line;
        const expandedLine = expandLeading(line, 0);
        if (fencesBegin.test(line) || headingBegin.test(line) || htmlBegin.test(line) || bqBegin.test(line) || nextBullet.test(line) || hrRe.test(line)) break;
        if (firstNonSpaceIdx(expandedLine) >= indent || !line.trim()) {
          itemText += '\n' + expandedLine.slice(indent);
        } else {
          if (wasBlank || expandedFirstNonSpaceIdx(prevContent) >= 4 || fencesBegin.test(prevContent) || headingBegin.test(prevContent) || htmlBegin.test(prevContent) || hrRe.test(prevContent)) break;
          const isSetext = /^ {0,3}(?:=+|-+) *$/.test(line) && RB.lheading.test(prevContent + '\n' + line);
          itemText += '\n' + (isSetext ? '    ' + expandedLine.replace(/^ {0,3}/, '') : line);
        }
        wasBlank = !line.trim();
        e = e.substring(line.length + 1);
        prevContent = expandedLine.slice(indent);
      }
    }
    const itemRaw = orig.slice(itemStart, consumed());
    if (!list.loose) {
      if (looseSeen) list.loose = true;
      else if (endsWithDoubleBlank(itemRaw)) looseSeen = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: RO.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return undefined;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = orig.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    L.state.top = false;
    item.tokens = blockTokens(item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((t) => RO.anyLine.test(t.raw));
    }
  }
  // Task-list checkboxes: strip the marker from the first text/paragraph
  // token (and its queued inline source) and splice in a checkbox token.
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(RO.listReplaceTask, '');
      first.raw = first.raw.replace(RO.listReplaceTask, '');
      first.text = first.text.replace(RO.listReplaceTask, '');
      for (let g = L.inlineQueue.length - 1; g >= 0; g--) {
        if (RO.listIsTask.test(L.inlineQueue[g].src)) {
          L.inlineQueue[g].src = L.inlineQueue[g].src.replace(RO.listReplaceTask, '');
          break;
        }
      }
      const cb = RO.listTaskCheckbox.exec(item.raw);
      if (cb) {
        const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (item.tokens[0] && (item.tokens[0].type === 'paragraph' || item.tokens[0].type === 'text') && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
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
  return list;
}

function htmlToken(src, pos) {
  const m = execAt(SB.html, src, pos);
  if (!m) return undefined;
  const raw = capTrailingBlankLines(m[0]);
  return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
}

function defToken(src, pos) {
  const m = execAt(SB.def, src, pos);
  if (!m) return undefined;
  if (!RO.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return undefined;
  return {
    type: 'def',
    tag: resolveId(m[1]),
    raw: rtrimChar(m[0], '\n'),
    href: m[2] ? m[2].replace(RO.hrefBrackets, '$1').replace(RI.anyPunctuation, '$1') : '',
    title: m[3] ? m[3].substring(1, m[3].length - 1).replace(RI.anyPunctuation, '$1') : m[3],
  };
}

function tableToken(src, pos) {
  const m = execAt(SB.table, src, pos);
  if (!m || !RO.tableDelimiter.test(m[2])) return undefined;
  const headerCells = splitCells(m[1]);
  const alignRow = m[2].replace(RO.tableAlignChars, '').split('|');
  const rowLines = m[3]?.trim() ? m[3].replace(RO.tableRowBlankLine, '').split('\n') : [];
  const table = { type: 'table', raw: rtrimChar(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length !== alignRow.length) return undefined;
  for (const cell of alignRow) {
    table.align.push(
      RO.tableAlignRight.test(cell) ? 'right'
        : RO.tableAlignCenter.test(cell) ? 'center'
          : RO.tableAlignLeft.test(cell) ? 'left'
            : null,
    );
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({ text: headerCells[i], tokens: queueInline(headerCells[i]), header: true, align: table.align[i] });
  }
  for (const rowLine of rowLines) {
    table.rows.push(splitCells(rowLine, table.header.length).map((cell, j) => ({
      text: cell,
      tokens: queueInline(cell),
      header: false,
      align: table.align[j],
    })));
  }
  return table;
}

function lheadingToken(src, pos) {
  const m = execAt(SB.lheading, src, pos);
  if (!m) return undefined;
  const text = m[1].trim();
  return { type: 'heading', raw: rtrimChar(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(text) };
}

function paragraphToken(src, pos) {
  SB.paragraph.lastIndex = pos;
  const m = SB.paragraph.exec(src);
  if (!m) return undefined;
  let text = m[1];
  if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(text) };
}

function blockTextToken(src, pos) {
  const m = execAt(SB.text, src, pos);
  if (!m) return undefined;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(m[0]) };
}

// ---------------------------------------------------------------------------
// Block dispatch guards: cheap necessary conditions so the expensive
// anchored rules only run when they can possibly match.
// ---------------------------------------------------------------------------

// A table needs a delimiter row (only | : - and spaces, with a dash) as its
// second line.
function tablePossible(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return false;
  let end = src.indexOf('\n', nl + 1);
  if (end === -1) end = src.length;
  let dashes = 0;
  for (let i = nl + 1; i < end; i++) {
    const c = src[i];
    if (c === '-') dashes++;
    else if (c !== '|' && c !== ':' && c !== ' ') return false;
  }
  return dashes > 0;
}

// A setext heading needs an underline line (=+ or -+ after up to 3 spaces)
// on some line before the next blank line.
function lheadingPossible(src, pos) {
  let lineStart = src.indexOf('\n', pos);
  if (lineStart === -1) return false;
  lineStart++;
  while (lineStart < src.length) {
    let end = src.indexOf('\n', lineStart);
    if (end === -1) end = src.length;
    let i = lineStart;
    let sp = 0;
    while (i < end && src[i] === ' ' && sp < 4) {
      i++;
      sp++;
    }
    if (i < end && sp <= 3 && (src[i] === '=' || src[i] === '-')) {
      const ch = src[i];
      while (i < end && src[i] === ch) i++;
      while (i < end && (src[i] === ' ' || src[i] === '\t')) i++;
      if (i === end) return true;
    }
    let blank = true;
    for (let j = lineStart; j < end; j++) {
      if (src[j] !== ' ' && src[j] !== '\t') {
        blank = false;
        break;
      }
    }
    if (blank || end === src.length) return false;
    lineStart = end + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The block lexer: marked's tokenizer order and merge rules, driven by an
// index cursor instead of suffix slicing.
// ---------------------------------------------------------------------------

function blockTokens(src, tokens, inBlockquote) {
  let pos = 0;
  const len = src.length;
  let mergePara = inBlockquote;
  let lastRem = Infinity;
  while (pos < len) {
    const rem = len - pos;
    if (rem < lastRem) lastRem = rem;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    const ch = src[pos];
    // Character after up to 3 leading spaces (the block rules' prefix).
    let ind = pos;
    let nsp = 0;
    while (nsp < 3 && src[ind] === ' ') {
      ind++;
      nsp++;
    }
    const ic = src[ind];
    let tok;

    if (ch === '\n' || ch === ' ' || ch === '\t') {
      tok = spaceToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
    }

    let sp = 0;
    while (sp < 4 && src[pos + sp] === ' ') sp++;
    if (sp === 4 || src[pos + sp] === '\t') {
      tok = indentedCodeToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        const last = tokens[tokens.length - 1];
        if (last !== undefined && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        continue;
      }
    }

    if ((ic === '`' || ic === '~') && src[ind + 1] === ic && src[ind + 2] === ic) {
      tok = fencesToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (ic === '#') {
      tok = headingToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (ic === '-' || ic === '_' || ic === '*') {
      tok = hrToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (ic === '>') {
      tok = blockquoteToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (ic === '*' || ic === '+' || ic === '-' || (ic >= '0' && ic <= '9')) {
      tok = listToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (ic === '<') {
      tok = htmlToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (ic === '[') {
      tok = defToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        const last = tokens[tokens.length - 1];
        if (last !== undefined && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
        } else {
          L.links[tok.tag] || (L.links[tok.tag] = { href: tok.href, title: tok.title });
          tokens.push(tok);
        }
        continue;
      }
    }

    if (tablePossible(src, pos)) {
      tok = tableToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (lheadingPossible(src, pos)) {
      tok = lheadingToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }

    if (L.state.top) {
      tok = paragraphToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        const last = tokens[tokens.length - 1];
        if (mergePara && last !== undefined && last.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          L.inlineQueue.pop();
          L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
        } else tokens.push(tok);
        mergePara = false;
        continue;
      }
    }

    tok = blockTextToken(src, pos);
    if (tok) {
      pos += tok.raw.length;
      const last = tokens[tokens.length - 1];
      if (last !== undefined && last.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        L.inlineQueue.pop();
        L.inlineQueue[L.inlineQueue.length - 1].src = last.text;
      } else tokens.push(tok);
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  L.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline layer: delimiter masking, the closer scan, tokenizers, and the
// inline loop (marked's rule order, dispatched on the current character).
// ---------------------------------------------------------------------------

// Scan a masked source once and record the last index at which each
// emphasis delimiter could close (a run whose preceding character is not
// whitespace). Lets emStrong/del bail out without scanning at all when no
// closer exists. The scan runs lazily, the first time a delimiter
// tokenizer actually asks for it.
function scanDelims(a) {
  const last = { '*': -1, '_': -1 };
  let tilde = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    while (i < n && a[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') tilde = s;
      else last[r] = s;
    }
    s = i - 1;
  }
  return { masked: a, star: last['*'], und: last['_'], tilde };
}

function lastCloser(masked, ch) {
  const top = L.delimStack[L.delimStack.length - 1];
  if (top && top.masked === masked) {
    if (top.data === null) top.data = scanDelims(masked);
    return ch === '~' ? top.data.tilde : ch === '*' ? top.data.star : top.data.und;
  }
  const e = scanDelims(masked);
  return ch === '~' ? e.tilde : ch === '*' ? e.star : e.und;
}

// Code-point length of a short string, with the spread fast path avoided
// for the common all-BMP case.
function cpLen(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDFFF) return [...s].length;
  }
  return s.length;
}

// The code point immediately before index l ('' when l is 0), matching
// [...slice(max(0, l - 2), l)].at(-1).
function codePointBefore(str, l) {
  if (l === 0) return '';
  const c = str.charCodeAt(l - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && l >= 2) {
    const hi = str.charCodeAt(l - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return str.slice(l - 2, l);
  }
  return str[l - 1];
}

// UTF-16 length of the first code point of a match.
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF ? 2 : 1;
}

// Does this text contain a real link? Used to decide masking and to keep
// link labels free of nested link-looking constructs.
function linkInText(str) {
  if (!str.includes('[')) return false;
  for (const m of str.matchAll(RI.blockSkip)) {
    if (RI.link.test(m[0]) && str.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of str.matchAll(RI.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(L.links, resolveId(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1)))) return true;
  }
  return false;
}

// Produce the masked twin of an inline source: resolvable reference links,
// escaped punctuation outside code, and link/code/html spans are rewritten
// to same-length placeholders so delimiter scans are not fooled by them.
function maskSrc(src) {
  let t = src;
  if (L.linkCount > 0 && src.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(L.links, resolveId(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner)) return '[' + inner.replace(RI.reflinkSearch, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(RI.reflinkSearch, maskRef);
  }
  // The punctuation pass can only change something when the source holds a
  // backslash escape or a code span; the span pass needs a [, ` or <.
  if (src.includes('\\') || src.includes('`')) {
    t = t.replace(RI.anyPunctuationOutsideCode, (n, s, r) => (r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n));
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    t = t.replace(RI.blockSkip, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}

// A link label must not contain a tag or autolink that spills past its end.
function hasBadLinkLabel(src, offset, label) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = RI.code.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const m = RI.tag.exec(rest) || RI.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Shared tail of link/reflink: lex the label, suppress the token when a
// nested link was emitted inside a non-image label.
function outputLink(m, dest, raw) {
  const href = dest.href;
  const title = dest.title || null;
  const text = m[1].replace(RO.outputLinkReplace, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = L.state.inLink;
  const savedEmitted = L.state.linkEmitted;
  const savedRaw = L.state.inRawBlock;
  L.state.inLink = true;
  L.state.linkEmitted = false;
  const tokens = inlineTokens(text, []);
  const emittedInside = L.state.linkEmitted;
  L.state.linkEmitted = savedEmitted;
  L.state.inLink = savedInLink;
  if (!isImage) {
    if (emittedInside) {
      L.state.inRawBlock = savedRaw;
      return undefined;
    }
    L.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function escapeToken(src, pos) {
  const m = execAt(SI.escape, src, pos);
  if (!m) return undefined;
  return { type: 'escape', raw: m[0], text: m[1] };
}

function tagToken(src, pos) {
  const m = execAt(SI.tag, src, pos);
  if (!m) return undefined;
  if (!L.state.inLink && RO.startATag.test(m[0])) L.state.inLink = true;
  else if (L.state.inLink && RO.endATag.test(m[0])) L.state.inLink = false;
  if (!L.state.inRawBlock && RO.startPreScriptTag.test(m[0])) L.state.inRawBlock = true;
  else if (L.state.inRawBlock && RO.endPreScriptTag.test(m[0])) L.state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: L.state.inLink, inRawBlock: L.state.inRawBlock, block: false, text: m[0] };
}

function linkToken(src, pos) {
  if (L.state.linkParenPossible === false) return undefined;
  const m = execAt(SI.link, src, pos);
  if (!m) return undefined;
  const label = m[1];
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasBadLinkLabel(src, pos + offset, label)) return undefined;
  let raw = m[0];
  let hrefRaw = m[2];
  let titleRaw = m[3];
  const hrefTrim = hrefRaw.trim();
  if (RO.startAngleBracket.test(hrefTrim)) {
    if (!RO.endAngleBracket.test(hrefTrim)) return undefined;
    const stripped = rtrimChar(hrefTrim.slice(0, -1), '\\');
    if ((hrefTrim.length - stripped.length) % 2 === 0) return undefined;
  } else {
    const close = findClosingBracket(hrefRaw, '()');
    if (close === -2) return undefined;
    if (close > -1) {
      const h = (raw.indexOf('!') === 0 ? 5 : 4) + label.length + close;
      hrefRaw = hrefRaw.substring(0, close);
      raw = raw.substring(0, h).trim();
      titleRaw = '';
    }
  }
  const tail = rtrimChar(raw.slice(0, -1), '\\');
  if ((raw.length - tail.length) % 2 === 0) return undefined;
  let href = hrefRaw.trim();
  const title = titleRaw ? titleRaw.slice(1, -1) : '';
  if (RO.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(m, {
    href: href && href.replace(RI.anyPunctuation, '$1'),
    title: title && title.replace(RI.anyPunctuation, '$1'),
  }, raw);
}

function reflinkToken(src, pos) {
  const m = execAt(SI.reflink, src, pos) || execAt(SI.nolink, src, pos);
  if (!m) return undefined;
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasBadLinkLabel(src, pos + offset, m[1])) return undefined;
  const dest = L.links[resolveId(m[2] || m[1])];
  if (!dest) {
    const c = m[0].charAt(0);
    return { type: 'text', raw: c, text: c };
  }
  return outputLink(m, dest, m[0]);
}

function emStrongToken(src, pos, masked, prevChar) {
  const s0 = execAt(SI.emStrongLDelim, src, pos);
  if (!s0 || (!s0[1] && !s0[2] && !s0[3] && !s0[4])) return undefined;
  const delim = s0[0][0];
  const sameDelimPrev = prevChar === delim;
  let l = pos;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = codePointBefore(masked, l);
  const pIsPunct = p === '*' || p === '_' || !!RI.punctuation.exec(p);
  if (l < pos) prevChar = p;
  const prevIsPunct = l < pos ? pIsPunct : !!RI.punctuation.exec(prevChar);
  if (s0[4] && prevChar.match(RO.unicodeAlphaNumeric)) return undefined;
  const d = s0[1] || s0[3] || '';
  if (!d || !prevChar || prevIsPunct) {
    const k = cpLen(s0[0]) - 1;
    let need = k;
    let skipped = 0;
    const runLen = pos - l + k;
    const canClose = !!p.trim() && (!!d || (delim === '*' && !pIsPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const rdelim = delim === '*' ? RI.emStrongRDelimAst : RI.emStrongRDelimUnd;
    const last = lastCloser(masked, delim);
    const scanFrom = pos + k;
    if (last < scanFrom) return undefined;
    const scanStr = masked.slice(scanFrom);
    const lastRel = last - scanFrom;
    rdelim.lastIndex = 0;
    let s;
    while ((s = rdelim.exec(scanStr)) !== null && !(s.index > lastRel)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let b = g.length;
      if (s[3] || s[4]) {
        need += b;
        continue;
      }
      if (s[5] || s[6] || canClose) {
        if (sameDelimPrev && (s[5] || s[6])) break;
        if (runLen % 3 && !((runLen + b) % 3)) {
          skipped += b;
          continue;
        }
      }
      need -= b;
      if (need > 0) continue;
      b = Math.min(b, b + need + skipped);
      const firstLen = firstCpLen(s[0]);
      const raw = src.slice(pos, pos + k + s.index + firstLen + b);
      if (Math.min(k, b) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(text, []) };
    }
  }
  return undefined;
}

function delToken(src, pos, masked, prevChar) {
  const s0 = execAt(SI.delLDelim, src, pos);
  if (!s0) return undefined;
  if (!(s0[1] || '') || !prevChar || RI.punctuation.exec(prevChar)) {
    const o = cpLen(s0[0]) - 1;
    let need = o;
    const last = lastCloser(masked, '~');
    const scanFrom = pos + o;
    if (last < scanFrom) return undefined;
    const scanStr = masked.slice(scanFrom);
    const lastRel = last - scanFrom;
    const rdelim = RI.delRDelim;
    rdelim.lastIndex = 0;
    let s;
    while ((s = rdelim.exec(scanStr)) !== null && !(s.index > lastRel)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let runLen = g.length;
      if (runLen !== o) continue;
      if (s[3] || s[4]) {
        need += runLen;
        continue;
      }
      need -= runLen;
      if (need > 0) continue;
      runLen = Math.min(runLen, runLen + need);
      const firstLen = firstCpLen(s[0]);
      const raw = src.slice(pos, pos + o + s.index + firstLen + runLen);
      const text = raw.slice(o, raw.length - o);
      return { type: 'del', raw, text, tokens: inlineTokens(text, []) };
    }
  }
  return undefined;
}

function codespanToken(src, pos) {
  const m = execAt(SI.code, src, pos);
  if (!m) return undefined;
  let text = m[2].replace(RO.newLineCharGlobal, ' ');
  if (RO.nonSpaceChar.test(text) && RO.startingSpaceChar.test(text) && RO.endingSpaceChar.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: m[0], text };
}

function brToken(src, pos) {
  const m = execAt(SI.br, src, pos);
  if (!m) return undefined;
  return { type: 'br', raw: m[0] };
}

function autolinkToken(src, pos) {
  const m = execAt(SI.autolink, src, pos);
  if (!m) return undefined;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

const SCHEME_RE = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//y;

// The url rule can only match a scheme, a www. prefix, a mailto:/xmpp:
// address, or an email-shaped run ending at an @. Skip the (large) regex
// when none of those can start here.
function urlPossible(src, pos) {
  const c = src.charCodeAt(pos);
  const isAlnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  if (!isAlnum) return false;
  if (src.startsWith('www.', pos)) return true;
  if (src.startsWith('mailto:', pos) || src.startsWith('xmpp:', pos)) return true;
  SCHEME_RE.lastIndex = pos;
  if (SCHEME_RE.test(src)) return true;
  let i = pos;
  while (i < src.length) {
    const cc = src.charCodeAt(i);
    if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 46 || cc === 95 || cc === 43 || cc === 45) i++;
    else break;
  }
  return src[i] === '@';
}

function urlToken(src, pos) {
  const m = execAt(SI.url, src, pos);
  if (!m) return undefined;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + m[0];
  } else {
    let prev;
    do {
      prev = m[0];
      m[0] = RI._backpedal.exec(m[0])?.[0] ?? '';
    } while (prev !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function inlineTextToken(src, pos) {
  SI.text.lastIndex = pos;
  const m = SI.text.exec(src);
  if (!m) return undefined;
  const inRaw = L.state.inRawBlock;
  return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeEntities(m[0]), escaped: inRaw };
}

function inlineTokens(src, tokens) {
  // Fast path: with no link opener and no emphasis delimiter in the
  // source, neither the linkParenPossible bookkeeping nor the delimiter
  // stack can ever be consulted, so both are skipped.
  if (!src.includes('[') && !src.includes('!') && !src.includes('*') && !src.includes('_') && !src.includes('~')) {
    return inlineLoop(src, tokens, src, false);
  }
  const saved = L.state.linkParenPossible;
  L.state.linkParenPossible = saved && src.includes(')');
  try {
    let masked = src;
    if (src.includes('*') || src.includes('_') || src.includes('~')) masked = maskSrc(src);
    return inlineLoop(src, tokens, masked, true);
  } finally {
    L.state.linkParenPossible = saved;
  }
}

function inlineLoop(src, tokens, masked, withStack) {
  if (withStack) L.delimStack.push({ masked, data: null });
  try {
    let pos = 0;
    const len = src.length;
    const state = L.state;
    let prevChar = '';
    let justText = false;
    let lastRem = Infinity;
    while (pos < len) {
      const rem = len - pos;
      if (rem < lastRem) lastRem = rem;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
      if (!justText) prevChar = '';
      justText = false;
      const ch = src.charCodeAt(pos);
      let tok;

      if (ch === 92) {
        tok = escapeToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
        tok = brToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      } else if (ch === 60) {
        tok = tagToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
        tok = autolinkToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      } else if (ch === 91 || (ch === 33 && src.charCodeAt(pos + 1) === 91)) {
        tok = linkToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
        tok = reflinkToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          const last = tokens[tokens.length - 1];
          if (tok.type === 'text' && last !== undefined && last.type === 'text') {
            last.raw += tok.raw;
            last.text += tok.text;
          } else tokens.push(tok);
          continue;
        }
      } else if (ch === 42 || ch === 95) {
        tok = emStrongToken(src, pos, masked, prevChar);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      } else if (ch === 96) {
        tok = codespanToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      } else if (ch === 126) {
        tok = delToken(src, pos, masked, prevChar);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      } else if (ch === 32) {
        tok = brToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      }

      if (!state.inLink && urlPossible(src, pos)) {
        tok = urlToken(src, pos);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      }

      tok = inlineTextToken(src, pos);
      if (tok) {
        pos += tok.raw.length;
        if (tok.raw.charAt(tok.raw.length - 1) !== '_') prevChar = tok.raw.charAt(tok.raw.length - 1);
        justText = true;
        const last = tokens[tokens.length - 1];
        if (last !== undefined && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else tokens.push(tok);
        continue;
      }

      throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    }
    return tokens;
  } finally {
    if (withStack) L.delimStack.pop();
  }
}

// ---------------------------------------------------------------------------
// Renderer: the reference output strings, built by direct concatenation.
// ---------------------------------------------------------------------------

function renderTextToken(t) {
  if (t.tokens) return renderInline(t.tokens, false);
  return t.escaped ? t.text : escapeHtml(t.text);
}

function renderCode(t) {
  const langWord = (t.lang || '').match(RO.notSpaceStart)?.[0];
  const body = t.text ? t.text.replace(RO.endingNewline, '') + '\n' : '';
  const inner = t.escaped ? body : escapeHtml(body, true);
  return langWord
    ? '<pre><code class="language-' + escapeHtml(langWord) + '">' + inner + '</code></pre>\n'
    : '<pre><code>' + inner + '</code></pre>\n';
}

function renderCheckbox(t) {
  return '<input ' + (t.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderList(t) {
  let items = '';
  for (const item of t.items) items += '<li>' + renderTokens(item.tokens) + '</li>\n';
  const tag = t.ordered ? 'ol' : 'ul';
  const start = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '';
  return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>';
  return open + renderInline(cell.tokens, false) + '</' + tag + '>\n';
}

function renderTable(t) {
  let header = '';
  for (const cell of t.header) header += renderTableCell(cell);
  let body = '';
  for (const row of t.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n' + '<tr>\n' + header + '</tr>\n' + '</thead>\n' + body + '</table>\n';
}

function renderTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + t.depth + '>' + renderInline(t.tokens, false) + '</h' + t.depth + '>\n';
        break;
      case 'code':
        out += renderCode(t);
        break;
      case 'table':
        out += renderTable(t);
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(t.tokens) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(t);
        break;
      case 'checkbox':
        out += renderCheckbox(t);
        break;
      case 'html':
        out += t.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += '<p>' + renderInline(t.tokens, false) + '</p>\n';
        break;
      case 'text':
        out += renderTextToken(t);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

function renderLink(t) {
  const inner = t.autolink ? escapeHtml(t.text, true) : renderInline(t.tokens, false);
  const cleaned = cleanUrl(t.href);
  if (cleaned === null) return inner;
  let out = '<a href="' + escapeHtml(cleaned, t.autolink) + '"';
  if (t.title) out += ' title="' + escapeHtml(t.title) + '"';
  return out + '>' + inner + '</a>';
}

function renderImage(t) {
  const alt = t.tokens ? renderInline(t.tokens, true) : t.text;
  const cleaned = cleanUrl(t.href);
  if (cleaned === null) return escapeHtml(alt);
  let out = '<img src="' + escapeHtml(cleaned) + '" alt="' + escapeHtml(alt) + '"';
  if (t.title) out += ' title="' + escapeHtml(t.title) + '"';
  return out + '>';
}

// textMode renders with the plain-text renderer used for image alt text:
// formatting wrappers disappear, links/images keep only their inner text.
function renderInline(tokens, textMode) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape':
        out += textMode ? t.text : renderTextToken(t);
        break;
      case 'html':
        out += t.text;
        break;
      case 'link':
        out += textMode ? (t.tokens ? renderInline(t.tokens, true) : t.text) : renderLink(t);
        break;
      case 'image':
        out += textMode ? (t.tokens ? renderInline(t.tokens, true) : t.text) : renderImage(t);
        break;
      case 'checkbox':
        out += textMode ? t.raw : renderCheckbox(t);
        break;
      case 'strong':
        out += textMode ? (t.tokens ? renderInline(t.tokens, true) : t.text) : '<strong>' + renderInline(t.tokens, false) + '</strong>';
        break;
      case 'em':
        out += textMode ? (t.tokens ? renderInline(t.tokens, true) : t.text) : '<em>' + renderInline(t.tokens, false) + '</em>';
        break;
      case 'codespan':
        out += textMode ? t.text : '<code>' + escapeHtml(t.text, true) + '</code>';
        break;
      case 'br':
        if (!textMode) out += '<br>';
        break;
      case 'del':
        out += textMode ? (t.tokens ? renderInline(t.tokens, true) : t.text) : '<del>' + renderInline(t.tokens, false) + '</del>';
        break;
      case 'text':
        out += textMode ? t.text : renderTextToken(t);
        break;
      default:
        throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  L = {
    links: Object.create(null),
    linkCount: 0,
    inlineQueue: [],
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    delimStack: [],
  };
  if (src.includes('\r')) src = src.replace(RO.carriageReturn, '\n');
  const tokens = [];
  blockTokens(src, tokens, false);
  L.linkCount = Object.keys(L.links).length;
  const queue = L.inlineQueue;
  for (let i = 0; i < queue.length; i++) {
    L.state.inRawBlock = false;
    inlineTokens(queue[i].src, queue[i].tokens);
  }
  L.inlineQueue = [];
  return renderTokens(tokens);
}

export default parse;
