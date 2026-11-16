// parse.js — CommonMark 0.31.2 + GFM parser, byte-compatible with marked 18.1.3
// (default options: GFM on, async off). Written from the CommonMark spec and
// verified against marked's output on the competition practice set.
// Single entrypoint: export function parse(markdown) -> html string.

// ---------------------------------------------------------------- utilities
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const RE_UNICODE_PUNCT = /[\p{P}\p{S}]/u;

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

// The Unicode whitespace set (ASCII whitespace plus the Unicode spaces
// CommonMark recognises).
function isUnicodeSpace(ch) {
  if (isSpace(ch)) return true;
  return ch === '\u00a0' || ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') ||
    ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' ||
    ch === '\u3000' || ch === '\ufeff';
}

// True for a single punctuation character (ASCII punctuation, or a
// Unicode punctuation/symbol character).
function isPunct(ch) {
  if (ch.length !== 1) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.indexOf(ch) !== -1;
  return RE_UNICODE_PUNCT.test(ch);
}

// True for an ASCII letter or digit, or any non-ASCII character (which
// CommonMark treats as alphanumeric).
function isAlphaNum(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
}

// Escape text for HTML output. An `&` is left alone when it starts
// something that looks like a character reference (&name; &#123; &#x1a;);
// every other `&` and each < > " ' is escaped. Named references are
// never decoded (marked passes them through); numeric references are
// decoded by the inline parser before this runs.
const RE_ESCAPE_TEXT = /&(?!(?:#\d{1,7};|#[Xx][0-9a-fA-F]{1,6};|\w+);)|[<>"']/g;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeText(s) {
  return s.replace(RE_ESCAPE_TEXT, (m) => ESCAPE_MAP[m]);
}

// Strict escaping for code spans and code blocks: every & < > " ' goes.
const RE_ESCAPE_CODE = /[&<>"']/g;
function escapeCode(s) {
  return s.replace(RE_ESCAPE_CODE, (m) => ESCAPE_MAP[m]);
}

// Decode one numeric character reference body ("#35" or "#x22"). Zero,
// surrogates and out-of-range values become U+FFFD.
function decodeNumericRef(body) {
  let n;
  if (body.charCodeAt(0) === 35) { // '#'
    if (body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88) n = parseInt(body.slice(2), 16);
    else n = parseInt(body.slice(1), 10);
  } else {
    n = 0;
  }
  if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(n);
}

// Escape the single character a numeric reference decoded to, so a
// decoded `&` cannot masquerade as an entity reference downstream.
function escapeDecodedChar(ch) {
  return ESCAPE_MAP[ch] || ch;
}

// Clean a link destination the way marked does: encodeURI, then restore
// `%` (encodeURI turns a literal % into %25 and marked undoes that).
// A lone surrogate makes encodeURI throw; then the destination is used
// as-is.
function cleanUrl(url) {
  if (url == null) return null;
  try {
    return encodeURI(url).replace(/%25/g, '%');
  } catch (e) {
    return url;
  }
}

// Backslash escapes: a backslash before an ASCII punctuation character
// yields that character; before anything else the backslash stays.
function unescapeStr(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && ASCII_PUNCT.indexOf(s[i + 1]) !== -1) {
      out += s[i + 1];
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

// Normalise a link label for reference lookup: strip, collapse internal
// whitespace runs to one space, case-fold.
  // Expand tabs to spaces, advancing to the next multiple of 4 columns,
  // starting at column `startCol`. Used for code block content (CommonMark
  // expands tabs in code blocks).
  function expandTabs(s, startCol) {
    if (s.indexOf('\t') === -1) return s;
    let out = '';
    let col = startCol;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\t') {
        const w = 4 - (col % 4);
        out += ' '.repeat(w);
        col += w;
      } else {
        out += ch;
        col++;
      }
    }
    return out;
  }

  // Remove up to n columns of leading indentation from s. A tab is
  // consumed whole when the indent stripping reaches it (marked advances
  // the column past the tab rather than replacing it with spaces).
  function stripLeadingIndent(s, n) {
    let col = 0, i = 0;
    while (i < s.length && col < n) {
      const ch = s[i];
      if (ch === ' ') { col++; i++; }
      else if (ch === '\t') { col += 4 - (col % 4); i++; }
      else break;
    }
    return s.slice(i);
  }

// Turn the leading whitespace of `s` into spaces, expanding each tab to
// the next multiple of 4 from `startCol`. Only the leading run is touched;
// a tab further into the content stays literal.
function expandLeadingTabs(s, startCol) {
  let col = startCol;
  let i = 0;
  let out = '';
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ') {
      out += ' ';
      col++;
    } else if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      break;
    }
  }
  return out + s.slice(i);
}

// Does `node` sit directly inside a BlockQuote? The tab-expansion base is
// 2 for a block whose immediate parent is a blockquote (one `> ` marker),
// and the absolute column for a list item even when that item is itself
// inside a blockquote.
function parentIsBlockquote(node) {
  return !!(node && node.parent && node.parent.type === 'BlockQuote');
}

// Expand the leading tab of a paragraph or code content line. At the top
// level (lineCol 0) a leading tab is literal content, so the line is
// returned untouched. Inside a container the tab expands from the
// blockquote base of 2 or from the absolute column.
function expandContentTab(content, lineCol, inBQ) {
  if (lineCol === 0) return content;
  return expandLeadingTabs(content, inBQ ? 2 : lineCol);
}

// Remove up to `n` leading whitespace characters (space or tab) from the
// line, each consumed whole. This is marked's fenced-code dedent (its
// `Dt`): it takes the opening fence line's leading whitespace `s` and
// removes up to `s.length` leading whitespace characters from every
// content line. A tab in the fence indent therefore vanishes entirely
// instead of leaving its remaining columns as spaces, and a tab after a
// few spaces is gone too once `n` characters are used up. (Column-based
// stripping would leave `4 - n` spaces for a tab and break exactly the
// tab lines in deeply nested fences.)
function stripFenceChars(line, n) {
  while (n > 0) {
    if (line.partial > 0) { line.col += line.partial; line.partial = 0; line.pos++; n--; continue; }
    if (line.pos >= line.s.length) break;
    const ch = line.s[line.pos];
    if (ch === ' ') { line.pos++; line.col++; n--; }
    else if (ch === '\t') { line.col += 4 - (line.col % 4); line.pos++; n--; }
    else break;
  }
}

// Strip `n` columns of fence indent from a code-block line. The descent
// already consumed the container markers, so `line.col` on entry is the
// container content start and `n` (the fence indent, relative to that
// start) is the number of columns left to strip. A tab straddling the
// boundary is expanded to its remaining width as spaces. A line with less
// indent than n is stripped as far as its whitespace goes (no restore).
// A leading tab expands to spaces only inside a container (content start
// column > 0); at the top level a leading tab is literal content. The
// expansion base is 2 inside a blockquote (one `> ` marker width, plus
// the columns stripped for the fence indent), and the absolute column
// otherwise (a list item's tab expands from its absolute column).
// When `fenceChars` is set (a fenced block at the top level, where the
// descent left the line untouched), the strip is character-based instead
// of column-based, matching marked's `Dt` exactly.
function stripCodeIndent(line, n, inBlockquote, fenceChars) {
  const contentStartCol = line.col;
  if (n > 0) {
    if (fenceChars && contentStartCol === 0) stripFenceChars(line, n);
    else advanceColumns(line, n);
  }
  if (contentStartCol === 0) return contentOf(line);
  const startCol = inBlockquote ? 2 + (line.col - contentStartCol) : line.col;
  return expandLeadingTabs(contentOf(line), startCol);
}

function normalizeLabel(s) {
  // Case-fold a link label for lookup: trim it, collapse runs of
  // whitespace to one space, then fold the characters JavaScript's
  // toLowerCase leaves alone — ß/ẞ to "ss" and final sigma ς to σ.
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ß/g, 'ss')
    .replace(/ẞ/g, 'ss')
    .replace(/ς/g, 'σ')
    .toLowerCase();
}

// True when the string holds only spaces and tabs (or is empty).
function isBlankLine(s) {
  return /^[ \t]*$/.test(s);
}

// ---------------------------------------------------------------- line model
// A source line is walked with a cursor: `pos` is the byte offset into the
// string, `col` the absolute column (a tab jumps to the next multiple of
// 4), and `partial` the columns left of a tab that was only partly
// consumed and is still sitting at `pos`. The text after the cursor is
// read with contentOf().
function makeLine(s) {
  return { s, pos: 0, col: 0, partial: 0 };
}

// The character at the cursor: a partly consumed tab reads as a space.
function lineChar(line) {
  if (line.partial > 0) return ' ';
  return line.pos < line.s.length ? line.s[line.pos] : '';
}

function lineAtEnd(line) {
  return line.pos >= line.s.length && line.partial === 0;
}

// Move the cursor `count` columns forward over whitespace only. A tab
// that runs past the target leaves its remainder as a partial tab at the
// cursor. Returns false when a non-space is met first, or the line ends.
function advanceColumns(line, count) {
  while (count > 0) {
    if (line.partial > 0) {
      const take = Math.min(line.partial, count);
      line.partial -= take;
      line.col += take;
      count -= take;
      if (line.partial === 0) line.pos++;
      continue;
    }
    if (line.pos >= line.s.length) return false;
    const ch = line.s[line.pos];
    if (ch === ' ') {
      line.pos++;
      line.col++;
      count--;
    } else if (ch === '\t') {
      const w = 4 - (line.col % 4);
      if (w <= count) {
        line.pos++;
        line.col += w;
        count -= w;
      } else {
        line.partial = w - count;
        line.col += count;
        count = 0;
      }
    } else {
      return false;
    }
  }
  return true;
}

// How many columns of leading whitespace sit at the cursor (spaces and
// tabs only). A partial tab contributes its remaining columns; once it is
// consumed the whitespace after it counts normally.
function indentColumns(line) {
  let col = line.col;
  let i = line.pos;
  if (line.partial > 0) {
    col += line.partial;
    i++;
  }
  while (i < line.s.length) {
    const ch = line.s[i];
    if (ch === ' ') {
      col++;
      i++;
    } else if (ch === '\t') {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  return col - line.col;
}

// The rest of the line from the cursor. A partly consumed tab contributes
// its remaining columns as spaces.
function contentOf(line) {
  if (line.partial > 0) return ' '.repeat(line.partial) + line.s.slice(line.pos + 1);
  return line.s.slice(line.pos);
}

// True when nothing but spaces and tabs remains. A partial tab counts as
// content (spaces), so the remainder is not blank while one is pending.
function isBlankRemainder(line) {
  if (line.partial > 0) return false;
  for (let i = line.pos; i < line.s.length; i++) {
    const ch = line.s[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------- block nodes
let NODE_ID = 0;
function makeNode(type, parent) {
  const n = {
    id: NODE_ID++, type, parent: parent || null, children: [],
    open: true, lastLineBlank: false,
    lines: null, // paragraph / heading / code / html: source lines
    level: 0, // heading
    fenced: false, fenceChar: '', fenceLength: 0, fenceIndent: 0, info: '', // code
    htmlType: 0, htmlEndTag: '', // html block
    listType: '', delimiter: '', start: 1, tight: true, // list
    markerOffset: 0, contentIndent: 0, // list item
    header: null, aligns: null, rows: null, // table
  };
  if (parent) parent.children.push(n);
  return n;
}
function lastChild(node) {
  return node.children.length ? node.children[node.children.length - 1] : null;
}

// ---------------------------------------------------------------- block parser
// Parses the whole document into a block tree and a link-reference map.
function parseBlocks(src) {
  src = src.replace(/\r\n?/g, '\n');
  const rawLines = src.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  // A trailing newline produces a final empty line; keep it (it is a blank
  // line that closes open blocks, which is harmless and spec-faithful).
  const doc = makeNode('Document', null);
  const refs = new Map();
  const stack = [doc]; // open blocks, doc first, tip last

  const tip = () => stack[stack.length - 1];

  // Finalise (close) blocks from the tip down to (but excluding) `downTo`.
  function closeTo(downTo) {
    while (stack.length > 1 && stack[stack.length - 1] !== downTo) {
      const b = stack.pop();
      finalizeBlock(b, refs);
    }
  }
  function closeAll() {
    while (stack.length > 1) {
      const b = stack.pop();
      finalizeBlock(b, refs);
    }
  }

  // Descend through open containers, consuming their markers. Returns the
  // deepest container that matched. Mutates `line`. `stack` is left intact;
  // unmatched blocks below the returned container are closed by the caller.
  function descend(line) {
    let container = doc;
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.type === 'List') {
        // A List is a container only when the line continues an open item
        // or starts a new item of this list; otherwise the list ends here
        // (a plain indented line after a closed item is outside the list).
        const next = stack[i + 1];
        if (next && next.type === 'ListItem' && next.open) { container = b; continue; }
        const nl = matchListStart(line);
        if (nl && nl.type === b.listType &&
          (nl.type === 'bullet' ? b.marker === nl.marker : b.delimiter === nl.delimiter)) {
          container = b; continue;
        }
        break;
      }
      if (b.type === 'BlockQuote') {
        // Up to 3 spaces of indent, then '>', then one optional space/tab.
        const save = { pos: line.pos, col: line.col, partial: line.partial };
        const ind = indentColumns(line);
        if (ind > 3) break;
        if (!advanceColumns(line, ind)) break;
        if (lineChar(line) !== '>') { line.pos = save.pos; line.col = save.col; line.partial = save.partial; break; }
        line.pos++; line.col++;
        if (line.partial > 0) line.partial = 0; // '>' consumed the tab position
        // Optional single space after '>'. Only a space is consumed, not
        // a tab: a tab after '>' is content (it expands from the
        // blockquote content base, not from a partially-consumed tab).
        if (line.pos < line.s.length && line.s[line.pos] === ' ') {
          advanceColumns(line, 1);
        }
        container = b;
        continue;
      }
      if (b.type === 'ListItem') {
        if (isBlankRemainder(line)) { container = b; continue; }
        // A fenced code block consumes its content lines regardless of the
        // item's indent, but only once it already has content: if the
        // FIRST content line does not reach the item's content indent, the
        // code block ends empty (and the line becomes a paragraph outside
        // the list). Advance toward the content indent as far as the line
        // allows (its lines need not reach it). contentIndent is relative
        // to the marker, so advance that many columns from here.
        const nx = stack[i + 1];
        if (nx && nx.open && nx.type === 'CodeBlock' && nx.fenced && nx.lines.length > 0) {
          advanceColumns(line, b.contentIndent);
          container = b; continue;
        }
        // The line must reach the item's content indent (relative to the
        // marker, i.e. this many columns past the current position).
        const save = { pos: line.pos, col: line.col, partial: line.partial };
        if (!advanceColumns(line, b.contentIndent)) {
          line.pos = save.pos; line.col = save.col; line.partial = save.partial;
          // The item does not continue. Its parent List stays the
          // container only when this line starts a new item of the same
          // list (a thematic break beats a list marker, so it closes the
          // list instead). Otherwise the List closes too.
          const list = b.parent;
          const isTB = /^ {0,3}([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(contentOf(line));
          const nl = !isTB ? matchListStart(line) : null;
          if (nl && list && list.type === 'List' && list.listType === nl.type &&
            (nl.type === 'bullet' ? list.marker === nl.marker : list.delimiter === nl.delimiter)) {
            container = list;
          } else {
            container = list && list.parent ? list.parent : doc;
          }
          break;
        }
        container = b;
        continue;
      }
      break; // leaf block: descent stops
    }
    return container;
  }

  // Simulate the descent for a look-ahead line without mutating the real
  // stack. Returns the content string after container markers, or null when
  // the line does not continue the same containers.
  function peekContent(raw, depthContainer) {
    const l = makeLine(raw);
    const c = descend(l);
    if (c !== depthContainer) return null;
    return contentOf(l);
  }

  // Add a child block to a container, applying the loose-list rules.
  function addChild(parent, block) {
    if (parent.type === 'ListItem') {
      if (parent.children.length > 0 && parent.lastLineBlank) {
        let p = parent;
        while (p && p.type !== 'List') p = p.parent;
        if (p) p.tight = false;
      }
    } else if (parent.type === 'List' && block.type === 'ListItem') {
      // A blank line between items: the previous item ended with a blank
      // line. (A blank line nested deeper, inside an item's sub-block, does
      // not loosen the outer list.)
      const prev = parent.children[parent.children.length - 1];
      if (prev && prev.lastLineBlank) parent.tight = false;
    }
    parent.children.push(block);
    block.parent = parent;
    // A new child clears the blank flag up the whole parent chain: content
    // has arrived inside each ancestor, so none of them ends with a blank
    // line any more.
    let ap = parent;
    while (ap) { ap.lastLineBlank = false; ap = ap.parent; }
    return block;
  }

  // Start a new block of `type` as a child of `container` and push it.
  function startBlock(container, type) {
    const b = makeNode(type, null);
    addChild(container, b);
    stack.push(b);
    return b;
  }

  // ---- finalisation ----
  function finalizeBlock(b, refsMap) {
    if (b.type === 'Paragraph') {
      extractDefinitions(b, refsMap);
      if (!b.lines || b.lines.length === 0 || (b.lines.length === 1 && b.lines[0] === '')) {
        const p = b.parent;
        if (p) {
          const idx = p.children.indexOf(b);
          if (idx !== -1) p.children.splice(idx, 1);
        }
        b.removed = true;
      }
    } else if (b.type === 'CodeBlock') {
      if (b.fenced) {
        // A fenced block drops exactly one trailing blank line (the
        // newline before the closing fence); further blank lines are content.
        if (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
      } else {
        while (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
      }
    } else if (b.type === 'Table') {
      b.headerCells = splitTableRow(b.headerLine);
      // A row line without a pipe is a single cell holding the whole line.
      b.rowCells = b.rows.map((r) => splitTableRow(r) || [r.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')]);
      const n = b.headerCells.length;
      for (const r of b.rowCells) {
        while (r.length < n) r.push('');
        if (r.length > n) r.length = n;
      }
    }
  }

  // Extract leading link reference definitions from a paragraph's lines.
  function extractDefinitions(para, refsMap) {
    const text = para.lines.join('\n');
    let pos = 0;
    while (true) {
      const def = matchDefinition(text, pos);
      if (!def) break;
      const label = normalizeLabel(def.label);
      if (!refsMap.has(label)) refsMap.set(label, { dest: def.dest, title: def.title });
      pos = def.end;
      if (text[pos] === '\n') pos++;
    }
    if (pos > 0) {
      const rest = text.slice(pos);
      para.lines = rest === '' ? [] : rest.split('\n');
    }
  }

  // Match one link reference definition at text[pos]. Returns
  // {label, dest, title, end} or null.
  function matchDefinition(text, pos) {
    let i = pos;
    let ind = 0;
    while (i < text.length && text[i] === ' ' && ind < 3) { i++; ind++; }
    if (i >= text.length || text[i] !== '[') return null;
    const label = scanLinkLabel(text, i);
    if (!label) return null;
    // A label must contain at least one non-whitespace character.
    if (!/\S/.test(label.text)) return null;
    i = label.end;
    if (text[i] !== ':') return null;
    i++;
    // Skip whitespace on the same line; the destination may also be on the
    // next line (if nothing but whitespace follows the colon). The next
    // line's leading indentation is not limited to 3 spaces here because
    // the definition is parsed from paragraph text, not raw source lines.
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    if (text[i] === '\n') {
      let k = i + 1;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k >= text.length || text[k] === '\n') return null;
      i = k;
    }
    if (i >= text.length) return null;
    let dest = '';
    if (text[i] === '<') {
      let j = i + 1, d = '', ok = false;
      while (j < text.length) {
        const ch = text[j];
        if (ch === '\\' && j + 1 < text.length && ASCII_PUNCT.indexOf(text[j + 1]) !== -1) { d += text[j + 1]; j += 2; continue; }
        if (ch === '>') { ok = true; break; }
        if (ch === '<' || ch === '\n') break;
        d += ch; j++;
      }
      if (!ok) return null;
      dest = d;
      i = j + 1;
    } else {
      let j = i, d = '', depth = 0;
      while (j < text.length) {
        const ch = text[j];
        if (ch === '\\' && j + 1 < text.length && ASCII_PUNCT.indexOf(text[j + 1]) !== -1) { d += text[j + 1]; j += 2; continue; }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 32) break;
        if (ch === '(') depth++;
        else if (ch === ')') {
          if (depth === 0) break;
          depth--;
        }
        d += ch; j++;
      }
      if (d === '' || depth !== 0) return null;
      dest = d;
      i = j;
    }
    // Optional title: on the same line after the destination, or alone on the
    // next line. A title may span multiple lines. Anything else after the
    // destination invalidates the definition; a following definition on the
    // next line does not.
    const parseTitleAt = (p) => {
      const q = text[p];
      const close = q === '(' ? ')' : q;
      let k = p + 1, t = '', ok = false;
      while (k < text.length) {
        const ch = text[k];
        if (ch === '\\' && k + 1 < text.length && ASCII_PUNCT.indexOf(text[k + 1]) !== -1) { t += text[k + 1]; k += 2; continue; }
        if (ch === close) { ok = true; break; }
        if (q === '(' && ch === '(') return null;
        t += ch; k++;
      }
      if (!ok) return null;
      return { title: t, end: k + 1 };
    };
    let title = null;
    let end = -1;
    let j = i;
    let hadWs = false;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) { j++; hadWs = true; }
    if (j < text.length && (text[j] === '"' || text[j] === "'" || text[j] === '(')) {
      // A title must be separated from the destination by whitespace.
      if (!hadWs) return null;
      const t = parseTitleAt(j);
      if (!t) return null;
      title = t.title;
      let k = t.end;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k < text.length && text[k] !== '\n') return null;
      end = k;
    } else if (j < text.length && text[j] !== '\n') {
      return null;
    } else if (j < text.length && text[j] === '\n') {
      // A title on the next line is best-effort: if it is missing, invalid,
      // or followed by other content, the definition simply has no title
      // and ends at the destination (the next line is separate content).
      let k = j + 1;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      if (k < text.length && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
        const t = parseTitleAt(k);
        if (t) {
          let m = t.end;
          while (m < text.length && (text[m] === ' ' || text[m] === '\t')) m++;
          if (m < text.length && text[m] === '\n') {
            title = t.title;
            end = m;
          } else if (m >= text.length) {
            title = t.title;
            end = m;
          } else {
            end = j;
          }
        } else {
          end = j;
        }
      } else {
        end = j;
      }
    } else {
      end = j;
    }
    return { label: label.text, dest, title, end };
  }

  // Skip spaces/tabs, then at most one newline plus up to 3 spaces. Returns
  // the new position, or -1 if it would cross a blank line or EOF.
  function skipWs1(text, i) {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    if (text[i] === '\n') {
      i++;
      let ind = 0;
      while (i < text.length && text[i] === ' ' && ind < 3) { i++; ind++; }
      if (i >= text.length || text[i] === '\n') return -1;
    }
    if (i >= text.length) return -1;
    return i;
  }

  // Scan a link label starting at text[i] === '['. Returns {text, end}
  // (end = index just past ']'), or null.
  function scanLinkLabel(text, i) {
    // A label ends at the first unescaped ']'; it may not contain '['.
    let j = i + 1, len = 0, label = '';
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\\' && j + 1 < text.length && ASCII_PUNCT.indexOf(text[j + 1]) !== -1) {
        label += ch + text[j + 1]; len += 2; j += 2; continue;
      }
      if (ch === '[') return null;
      if (ch === ']') return label.length === 0 ? null : { text: label, end: j + 1 };
      label += ch; len++; j++;
      if (len > 999) return null;
    }
    return null;
  }

  // ---- leaf starts ----
  const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));

  function matchBlockquoteStart(line) {
    const ind = indentColumns(line);
    if (ind > 3) return false;
    const save = { pos: line.pos, col: line.col, partial: line.partial };
    if (!advanceColumns(line, ind)) return false;
    if (lineChar(line) !== '>') { line.pos = save.pos; line.col = save.col; line.partial = save.partial; return false; }
    return true;
  }
  function consumeBlockquoteMarker(line) {
    line.pos++; line.col++;
    if (line.partial > 0) line.partial = 0;
    if (line.pos < line.s.length && (line.s[line.pos] === ' ' || line.s[line.pos] === '\t')) advanceColumns(line, 1);
  }

  // Match a list-item marker at the cursor. Returns null or marker info.
  function matchListStart(line) {
    const ind = indentColumns(line);
    if (ind > 3) return null;
    let i = line.pos, col = line.col;
    while (i < line.s.length && line.s[i] === ' ' && col - line.col < 3) { i++; col++; }
    if (i >= line.s.length) return null;
    const markerCol = col;
    const ch = line.s[i];
    let type = '', marker = '', start = 1, delimiter = '';
    if (ch === '-' || ch === '+' || ch === '*') {
      type = 'bullet'; marker = ch;
      const nx = line.s[i + 1];
      if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
      i += 1; col += 1;
    } else if (ch >= '0' && ch <= '9') {
      let j = i, num = '';
      while (j < line.s.length && line.s[j] >= '0' && line.s[j] <= '9' && num.length < 9) { num += line.s[j]; j++; }
      if (j >= line.s.length || (line.s[j] !== '.' && line.s[j] !== ')')) return null;
      if (num.length > 9) return null;
      const nx = line.s[j + 1];
      if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
      type = 'ordered'; delimiter = line.s[j]; marker = num + delimiter; start = parseInt(num, 10);
      i = j + 1; col += marker.length;
    } else return null;
    const afterMarkerCol = col;
    let k = i, c2 = col, spaces = 0;
    while (k < line.s.length && (line.s[k] === ' ' || line.s[k] === '\t')) {
      if (line.s[k] === ' ') { spaces++; c2++; k++; }
      else { const w = 4 - (c2 % 4); spaces += w; c2 += w; k++; }
    }
    const empty = k >= line.s.length;
    // Content indent RELATIVE to the container's content start (line.col
    // when the marker is matched): the marker sits at a different absolute
    // column on different lines (blockquote markers consume a variable
    // width), so only the offset from the container start is stable.
    const baseCol = line.col;
    let contentIndent;
    if (empty) contentIndent = (afterMarkerCol + 1) - baseCol;
    else if (spaces >= 1 && spaces <= 4) contentIndent = c2 - baseCol;
    else contentIndent = (afterMarkerCol + 1) - baseCol;
    return {
      type, marker, delimiter, start,
      markerOffset: line.col + ind,
      contentIndent, contentIndentAbs: empty ? afterMarkerCol + 1 : (spaces >= 1 && spaces <= 4 ? c2 : afterMarkerCol + 1), empty,
      markerEndPos: i, markerEndCol: afterMarkerCol,
    };
  }

  // Match an HTML block start at the beginning of `rest` (the line's content
  // after containers). `allowType7` is false inside a paragraph. Returns
  // {type, endTag} or null.
  function matchHtmlBlockStart(rest, allowType7) {
    const m = /^ {0,3}</.exec(rest);
    if (!m) return null;
    const s = rest.slice(m[0].length - 1); // starts at '<'
    const lower = s.toLowerCase();
    // Type 1: script, pre, style, textarea, title.
    const t1 = /^<(script|pre|style|textarea|title)(?:[ \t>]|$)/.exec(lower);
    if (t1) return { type: 1, endTag: t1[1] };
    // Type 2: comment.
    if (lower.startsWith('<!--')) return { type: 2 };
    // Type 3: processing instruction.
    if (lower.startsWith('<?')) return { type: 3 };
    // Type 4: declaration.
    if (/^<![A-Za-z]/.test(s)) return { type: 4 };
    // Type 5: CDATA.
    if (lower.startsWith('<![cdata[')) return { type: 5 };
    // Type 6: block-level tag.
    const t6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t/>]|$)/.exec(s);
    if (t6 && BLOCK_TAGS.has(t6[1].toLowerCase())) return { type: 6 };
    // Type 7: complete open or closing tag alone on the line. A closing
    // tag carries no attributes.
    if (allowType7) {
      if (/^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/.test(s)) {
        return { type: 7 };
      }
    }
    return null;
  }

  // Split a table row line into cell strings. Returns null when the line is
  // not a table row at all (no unescaped pipe). `forDelimiter` relaxes the
  // cell content check (delimiter cells are validated by the caller).
  function splitTableRow(line, forDelimiter) {
    let cells = [];
    let cur = '';
    let i = 0;
    // Optional leading whitespace, then an optional leading pipe. A
    // leading pipe counts as a separator: a row like ` | release` (one
    // cell, no other pipe) is a valid row, not a non-row.
    let sawPipe = false;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (line[i] === '|') { i++; sawPipe = true; }
    while (i < line.length) {
      const ch = line[i];
      // A pipe preceded by a backslash is a literal pipe, not a separator
      // (marked does not count backslashes: `\\|` is also literal).
      if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|') { cur += '|'; i += 2; continue; }
      if (ch === '|') {
        cells.push(cur);
        cur = '';
        sawPipe = true;
        i++;
        continue;
      }
      cur += ch;
      i++;
    }
    if (!sawPipe && cells.length === 0) return null;
    // Trailing pipe produces an empty final cell only if the line ends with one.
    if (line.endsWith('|')) {
      // The last cell before the trailing pipe was already pushed; drop the
      // empty remainder.
    } else {
      cells.push(cur);
    }
    // Trim cells (leading/trailing spaces are stripped; inner kept).
    cells = cells.map((c) => c.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
    return cells;
  }

  // Would this line start a new block (blockquote, heading, fence, break,
  // list, HTML block, indented code) instead of continuing a table row?
  // Pure check: reads the line but does not move its cursor.
  function lineStartsBlock(line) {
    const rest = contentOf(line);
    if (/^ {0,3}>/.test(rest)) return true;
    if (/^ {0,3}#{1,6}(?:[ \t]+|[ \t]*$)/.test(rest)) return true;
    if (/^ {0,3}(```+|~~~+)/.test(rest)) return true;
    if (/^ {0,3}([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) return true;
    if (matchListStart(line)) return true;
    if (matchHtmlBlockStart(rest, true)) return true;
    if (indentColumns(line) >= 4) return true;
    return false;
  }

  // Try to start new blocks at `container` for this line.
  function tryStartBlocks(line, container, li) {
    let cur = container;
    for (;;) {
      if (matchBlockquoteStart(line)) {
        closeTo(cur);
        const b = startBlock(cur, 'BlockQuote');
        consumeBlockquoteMarker(line);
        cur = b;
        continue;
      }
      // A thematic break beats a list marker: a line of three or more
      // matching -, _, or * characters separated by spaces/tabs is a break,
      // not a list (checked after any blockquote start, and again after a
      // list marker is consumed, so a break may also be a list item's content).
      if (/^ {0,3}([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(contentOf(line))) {
        closeTo(cur);
        const tb = startBlock(cur, 'ThematicBreak');
        tb.open = false;
        stack.pop();
        finalizeBlock(tb, refs);
        return 'consumed';
      }
      const lst = matchListStart(line);
      if (lst) {
        // Does this item join an existing list (a continuation) or start a
        // new one? A continuation is not subject to the paragraph-interrupt
        // rules (an ordered list may continue from any number; only a NEW
        // ordered list must start at 1 to interrupt a paragraph).
        const curIsList = cur.type === 'List' && cur.open && cur.listType === lst.type &&
          (lst.type === 'bullet' ? cur.marker === lst.marker : cur.delimiter === lst.delimiter);
        const lc0 = lastChild(cur);
        const lcIsList = !curIsList && lc0 && lc0.type === 'List' && lc0.open && lc0.listType === lst.type &&
          (lst.type === 'bullet' ? lc0.marker === lst.marker : lc0.delimiter === lst.delimiter);
        if (!curIsList && !lcIsList && tip().type === 'Paragraph' && tip().open) {
          if (lst.empty) return null;
          // An ordered list must start at 1 to interrupt a paragraph, UNLESS
          // its delimiter differs from the delimiter of the list enclosing
          // the paragraph (then it is unambiguously a new list), or the
          // list is nested inside a list item (a nested list always
          // interrupts the item's paragraph).
          if (lst.type === 'ordered' && lst.start !== 1 && cur.type !== 'ListItem') {
            let p = tip().parent;
            let encDelim = null;
            while (p) { if (p.type === 'List') { encDelim = p.delimiter; break; } p = p.parent; }
            if (encDelim === null || encDelim === lst.delimiter) return null;
          }
        }
        closeTo(cur);
        let list = null;
        // When the descent already returned the matching List itself, the
        // new item joins it directly.
        if (curIsList) {
          list = cur;
        } else if (lcIsList) {
          list = lc0;
        } else {
          list = startBlock(cur, 'List');
          list.listType = lst.type;
          list.marker = lst.marker;
          list.delimiter = lst.delimiter;
          list.start = lst.start;
          list.tight = true;
        }
        const item = startBlock(list, 'ListItem');
        item.markerOffset = lst.markerOffset;
        item.contentIndent = lst.contentIndent;
        line.pos = lst.markerEndPos; line.col = lst.markerEndCol;
        // Content starts at the absolute content column; advance from
        // the marker end to it.
        const targetCol = lst.contentIndentAbs;
        if (line.col < targetCol) advanceColumns(line, targetCol - line.col);
        // An empty marker line (only spaces after the marker) contributes
        // no content: swallow the trailing spaces so they do not seed a
        // paragraph (which would render as a stray <br> or spaces), and
        // the line is fully consumed.
        if (lst.empty) { line.pos = line.s.length; return 'consumed'; }
        cur = item;
        continue;
      }
      break;
    }

    // Recomputed after the container loop: a started container closes the
    // paragraph, so the tip may have changed since the function was entered.
    const paraOpen = tip().type === 'Paragraph' && tip().open;
    const rest = contentOf(line);
    let m = /^( {0,3})(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(rest);
    if (m) {
      const level = m[2].length;
      let text = (m[3] || '').replace(/[ \t]+$/, '');
      text = text.replace(/^(.*?)[ \t]+#+[ \t]*$/, '$1');
      if (/^#+$/.test(text)) text = '';
      closeTo(cur);
      const h = startBlock(cur, 'Heading');
      h.level = level;
      h.lines = [text];
      h.open = false;
      stack.pop();
      finalizeBlock(h, refs);
      return 'consumed';
    }
    m = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/.exec(rest);
    if (m) {
      if (!(m[2][0] === '`' && m[3].indexOf('`') !== -1)) {
        closeTo(cur);
        const cb = startBlock(cur, 'CodeBlock');
        cb.fenced = true;
        cb.fenceChar = m[2][0];
        cb.fenceLength = m[2].length;
        // A tilde fence directly inside a blockquote keeps its indent on
        // content lines (marked does not strip it for `~~~`, only for
        // backtick fences); a backtick fence strips up to its indent.
        cb.fenceIndent = (m[2][0] === '~' && cur.type === 'BlockQuote') ? 0 : m[1].length;
        cb.inBlockquote = cur.type === 'BlockQuote';
        cb.info = m[3] || '';
        cb.lines = [];
        return 'consumed';
      }
    }
    const html = matchHtmlBlockStart(rest, !paraOpen);
    if (html) {
      closeTo(cur);
      const hb = startBlock(cur, 'HtmlBlock');
      hb.htmlType = html.type;
      hb.htmlEndTag = html.endTag || '';
      hb.lines = [rest];
      if (htmlBlockEndsHere(hb, rest)) {
        // The block ends on its start line; a following blank line swallows
        // the trailing newline.
        if (rawLines[li + 1] === '') hb.noTrailing = true;
        stack.pop();
        finalizeBlock(hb, refs);
      }
      return 'consumed';
    }
    if (/^ {0,3}([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) {
      closeTo(cur);
      const tb = startBlock(cur, 'ThematicBreak');
      tb.open = false;
      stack.pop();
      finalizeBlock(tb, refs);
      return 'consumed';
    }
    const tbl = tryStartTable(line, cur, li);
    if (tbl) return tbl;
    if (!paraOpen) {
      const ind = indentColumns(line);
      if (ind >= 4) {
        closeTo(cur);
        const cb = startBlock(cur, 'CodeBlock');
        cb.fenced = false;
        cb.lines = [];
        advanceColumns(line, 4);
        cb.lines.push(contentOf(line));
        return 'consumed';
      }
    }
    // No leaf block started: the tip is either an open paragraph (caller adds
    // the line to it) or a container (caller starts a paragraph under it).
    if (tip().type === 'Paragraph' && tip().open) return null;
    return { container: cur };
  }

  // Try to start a table: current line is the header row, next line (same
  // containers) the delimiter row.
  function tryStartTable(line, container, li) {
    const rest = contentOf(line);
    if (rest.indexOf('|') === -1) return null;
    const nextRaw = rawLines[li + 1];
    if (nextRaw === undefined) return null;
    const next = peekContent(nextRaw, container);
    if (next === null) return null;
    const cells = splitTableRow(next, true);
    if (!cells) return null;
    const aligns = [];
    for (const c of cells) {
      const t = c.trim();
      if (!/^:?-+:?$/.test(t)) return null;
      aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : null);
    }
    const headerCells = splitTableRow(rest);
    if (!headerCells || headerCells.length === 0) return null;
    // The delimiter row must have as many cells as the header row.
    if (cells.length !== headerCells.length) return null;
    closeTo(container);
    const tb = startBlock(container, 'Table');
    tb.headerLine = rest;
    tb.aligns = aligns;
    tb.rows = [];
    return { table: true, nextIndex: li + 2 };
  }

  // Handle a blank line (after container markers). `container` is the deepest
  // matched container. Returns true if the line was consumed as content.
  function handleBlank(line, container) {
    let t = tip();
    // A blank line belongs to a leaf block only when the line is inside
    // that block's container. A blank line outside the container (e.g. no
    // `>` marker for a blockquote) closes the leaf block and its container
    // instead of becoming part of the block.
    if ((t.type === 'CodeBlock' || (t.type === 'HtmlBlock' && t.htmlType >= 1 && t.htmlType <= 5)) &&
      t.parent !== container) {
      closeTo(container);
      t = tip();
    }
    if (t.type === 'CodeBlock' && t.fenced) {
      // A "blank" line with spaces keeps the spaces beyond the fence indent.
      t.lines.push(stripCodeIndent(line, t.fenceIndent || 0, t.inBlockquote, true));
      t.lastLineBlank = true;
      return true;
    }
    if (t.type === 'CodeBlock' && !t.fenced) {
      // A "blank" line with spaces keeps the spaces beyond the 4-space code indent.
      t.lines.push(stripCodeIndent(line, 4));
      t.lastLineBlank = true;
      return true;
    }
    if (t.type === 'HtmlBlock' && t.htmlType >= 1 && t.htmlType <= 5) {
      t.lines.push('');
      t.lastLineBlank = true;
      return true;
    }
    if (t.type === 'HtmlBlock') { // types 6-7 end at a blank line
      t.noTrailing = true;
      closeTo(container);
    }
    if (t.type === 'Table') {
      stack.pop();
      finalizeBlock(t, refs);
    }
    // Structural blank line: close an open paragraph, flag open blocks.
    if (tip().type === 'Paragraph') closeTo(container);
    // A blank line closes an empty list item (it has no blocks yet); the
    // following indented line is then outside the list.
    if (tip().type === 'ListItem' && tip().children.filter((c) => !c.removed).length === 0) {
      closeTo(tip().parent);
    }
    // A blank line flags the container and its ancestors, so a blank line
    // between two blocks (or items) is visible to the list-looseness rules.
    // The flag does NOT cross a blockquote boundary: a blank line inside a
    // blockquote is the blockquote's own blank line, not the enclosing
    // list item's. (addChild clears the flag up the chain when content is
    // added, so a blank line nested inside an item does not loosen an
    // outer list once deeper content follows.)
    let fp = container;
    while (fp && fp !== doc) {
      fp.lastLineBlank = true;
      if (fp.type === 'BlockQuote') break;
      fp = fp.parent;
    }
    return true;
  }

  for (let li = 0; li < rawLines.length; li++) {
    const line = makeLine(rawLines[li]);
    const container = descend(line);
    const t = tip();

    // Blank line? A line that is only spaces after a blockquote marker
    // still has content (the spaces) when a paragraph is open in that
    // blockquote: it is a paragraph line, not a blank line. A tab-only
    // line inside a table is an (empty) table row, not a blank line: a
    // tab is content for the table, while a spaces-only line ends it.
    const t0peek = tip();
    const tableTabRow = t0peek.type === 'Table' && line.s.slice(line.pos).indexOf('\t') !== -1;
    if (isBlankRemainder(line) && !tableTabRow) {
      const t0 = tip();
      if (t0.type === 'Paragraph' && t0.open && t0.parent === container &&
          line.pos < line.s.length) {
        let anc = container;
        while (anc) {
          if (anc.type === 'BlockQuote') {
            t0.lines.push(expandContentTab(contentOf(line), line.col, true));
            t0.lastLineBlank = false;
            break;
          }
          anc = anc.parent;
        }
        if (anc) continue;
      }
      handleBlank(line, container);
      continue;
    }

    // Setext heading underline? Applies when the tip is an open paragraph
    // AND the line is inside the same container as that paragraph (a lazy
    // continuation line outside the paragraph's container cannot be an
    // underline; it is paragraph text or a new block).
    if (t.type === 'Paragraph' && t.open && t.parent === container) {
      const rest = contentOf(line);
      const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(rest);
      if (m) {
        // Extract any link reference definitions first; they are not part
        // of the heading text. If nothing remains, this line is not an
        // underline (it is processed normally below).
        extractDefinitions(t, refs);
        if (t.lines.length > 0) {
          // Convert the tip paragraph to a heading in place (its containers
          // stay open); the underline line is consumed. The heading text is
          // the paragraph text with leading/trailing whitespace stripped.
          t.type = 'Heading';
          t.level = m[1][0] === '=' ? 1 : 2;
          t.lines = [t.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')];
          t.open = false;
          stack.pop();
          finalizeBlock(t, refs);
          continue;
        }
      }
    }

    // Leaf-block tips consume the line themselves (code, HTML, table),
    // but only when the line is inside the tip's own container. A line
    // that the descent placed outside that container (e.g. a lazy
    // continuation without the blockquote marker) closes the tip instead.
    let tipBlock = tip();
    if ((tipBlock.type === 'CodeBlock' || tipBlock.type === 'HtmlBlock' || tipBlock.type === 'Table') &&
      tipBlock.parent !== container) {
      stack.pop();
      finalizeBlock(tipBlock, refs);
      tipBlock = tip();
    }
    if (tipBlock.type === 'CodeBlock' && tipBlock.fenced) {
      if (tryCloseFence(line, tipBlock)) {
        stack.pop();
        finalizeBlock(tipBlock, refs);
      } else {
        // Strip up to the opening fence's indent from the content line.
        tipBlock.lines.push(stripCodeIndent(line, tipBlock.fenceIndent || 0, tipBlock.inBlockquote, true));
      }
      tipBlock.lastLineBlank = false;
      continue;
    }
    if (tipBlock.type === 'CodeBlock' && !tipBlock.fenced) {
      const ind = indentColumns(line);
      if (ind >= 4) {
        advanceColumns(line, 4);
        // After the 4-space indent is stripped, the rest is literal
        // content: a leading tab stays a tab (it is not expanded).
        tipBlock.lines.push(contentOf(line));
        tipBlock.lastLineBlank = false;
        continue;
      }
      stack.pop();
      finalizeBlock(tipBlock, refs);
    }
    if (tipBlock.type === 'HtmlBlock') {
      const rest = contentOf(line);
      tipBlock.lines.push(rest);
      tipBlock.lastLineBlank = false;
      if (htmlBlockEndsHere(tipBlock, rest)) {
        if (rawLines[li + 1] === '') tipBlock.noTrailing = true;
        stack.pop();
        finalizeBlock(tipBlock, refs);
      }
      continue;
    }
    if (tipBlock.type === 'Table') {
      const rest = contentOf(line);
      // A table row is any line that does not start a new block. A plain
      // line without a pipe is still a (single-cell) row. A whitespace-only
      // line that reaches here contains a tab (spaces-only lines end the
      // table in handleBlank); it is an empty row, not an indented code
      // block, even though a tab counts as a 4-column indent.
      if (!lineStartsBlock(line) || /^[ \t]*$/.test(rest)) {
        tipBlock.rows.push(rest);
        tipBlock.lastLineBlank = false;
        continue;
      }
      stack.pop();
      finalizeBlock(tipBlock, refs);
    }

    // Try to start new blocks at `container`.
    const started = tryStartBlocks(line, container, li);
    if (started === 'consumed') continue;
    if (started && started.table) {
      li = started.nextIndex - 1;
      continue;
    }

    // No new block: the line belongs to the tip, or starts a paragraph.
    const cur = tip();
    if (cur.type === 'Paragraph' && cur.open) {
      let content = contentOf(line);
      if (cur.parent !== container) {
        // Lazy continuation line: its leading whitespace is part of the
        // paragraph text, except that a 4-space code-block indent is
        // stripped when 4 or more spaces lead (fewer than 4 are kept).
        let n = 0;
        while (n < content.length && content[n] === ' ') n++;
        if (n >= 4) content = content.slice(4);
        // A lazy-continuation line that looks like a level-1 setext
        // underline (only `=` chars) inside a blockquote is added to the
        // paragraph with 4 leading spaces (cmark's rendering of this edge
        // case; the line is not an underline because it is outside the
        // paragraph's container).
        if (/^ {0,3}=+[ \t]*$/.test(content)) {
          let anc = cur.parent;
          while (anc) {
            if (anc.type === 'BlockQuote') { content = '    ' + content.replace(/^[ \t]+/, ''); break; }
            anc = anc.parent;
          }
        }
      }
      // Expand a leading tab (literal at the top level, base 2 inside a
      // blockquote, absolute column otherwise). Applies to lazy lines too:
      // a lazy continuation inside a blockquote still expands its tab.
      if (line.col > 0) content = expandContentTab(content, line.col, parentIsBlockquote(cur));
      cur.lines.push(content);
      cur.lastLineBlank = false;
    } else if (cur.type === 'CodeBlock' && cur.fenced) {
      if (tryCloseFence(line, cur)) {
        stack.pop();
        finalizeBlock(cur, refs);
      } else {
        // Strip up to the opening fence's indent from the content line.
        cur.lines.push(stripCodeIndent(line, cur.fenceIndent || 0, cur.inBlockquote, true));
      }
      cur.lastLineBlank = false;
    } else if (cur.type === 'CodeBlock' && !cur.fenced) {
      cur.lines.push(contentOf(line));
      cur.lastLineBlank = false;
    } else if (cur.type === 'HtmlBlock') {
      cur.lines.push(contentOf(line));
      cur.lastLineBlank = false;
      if (htmlBlockEndsHere(cur, contentOf(line))) {
        if (rawLines[li + 1] === '') cur.noTrailing = true;
        cur.open = false;
        stack.pop();
        finalizeBlock(cur, refs);
      }
    } else {
      // Start a new paragraph under the innermost container that
      // tryStartBlocks reached (it may have started a list/blockquote).
      // A line consumed entirely by container markers (e.g. a bare `>`)
      // has no content and starts no paragraph.
      const content = contentOf(line);
      if (content === '') continue;
      const under = started && started.container ? started.container : container;
      closeTo(under);
      const p = startBlock(under, 'Paragraph');
      p.lines = [expandContentTab(content, line.col, parentIsBlockquote(p))];
    }
  }
  closeAll();
  return { doc, refs };
}

// Is this line a closing fence for the fenced code block? (Handled by the
// caller for the fenced case; kept separate for clarity.)
function tryCloseFence(line, code) {
  const rest = contentOf(line);
  const m = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(rest);
  if (!m) return false;
  if (m[2][0] !== code.fenceChar) return false;
  if (m[2].length < code.fenceLength) return false;
  code.open = false;
  return true;
}

// Does this line end the HTML block (types 1-5 end-condition markers)?
function htmlBlockEndsHere(block, rest) {
  if (block.htmlType === 1) {
    const tag = block.htmlEndTag;
    return new RegExp('</' + tag + '\\s*>', 'i').test(rest);
  }
  if (block.htmlType === 2) return rest.indexOf('-->') !== -1;
  if (block.htmlType === 3) return rest.indexOf('?>') !== -1;
  if (block.htmlType === 4) return rest.indexOf('>') !== -1;
  if (block.htmlType === 5) return rest.indexOf(']]>') !== -1;
  return false; // types 6-7 end at blank lines
}

// ---------------------------------------------------------------- inline parsing
// Left-to-right greedy inline tokenizer, following marked 18.1.3's rules:
// at each position the first matching construct wins (escape, HTML tag /
// autolink, link, reference link, emphasis, code span, hard break,
// strikethrough, bare autolink, plain text). Emphasis and strikethrough
// scan forward from their opener for the first usable closer, keeping a
// running account of how much of the opener run is still unspent and how
// much was skipped by the rule of three. A link label follows the shape
// marked's label pattern accepts (balanced brackets, code spans, no stray
// backtick run), and a link whose label already holds a link is left
// literal. The inside of emphasis, strong emphasis, strikethrough and
// link text is tokenized recursively. Tokens render to HTML at the end.

// --- character classes used by the emphasis flanking rules ---
function isSpaceCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}
// Punctuation for the `*` rules: marked treats `~` as a non-punctuation
// character there, so it is excluded.
function isPunctNoTilde(ch) {
  return ch !== '' && ch !== '~' && isPunct(ch);
}
// Punctuation-or-space for the flanking checks (the `~` counts here).
function isPunctSpaceNT(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && (isUnicodeSpace(ch) || isPunct(ch));
}
function isAlnum(ch) {
  return ch !== '' && /[\p{L}\p{N}]/u.test(ch);
}
// not-punctuation-not-space for the `*` closer rules (`~` counts as one).
function isNotPunctSpaceStar(ch) {
  return ch !== '' && !isUnicodeSpace(ch) && !isPunctNoTilde(ch);
}
// not-punctuation-not-space for the `_` and `~` closer rules.
function isNotPunctSpace(ch) {
  return ch !== '' && !isUnicodeSpace(ch) && !isPunct(ch);
}
// ASCII punctuation only: marked's backslash-escape rule unescapes a
// backslash before an ASCII punctuation character, and nothing else (a
// Unicode punctuation mark such as « keeps its backslash).
function isAsciiPunct(ch) {
  return ch !== '' && ASCII_PUNCT.indexOf(ch) !== -1;
}

// --- angle autolink / inline HTML tag at text[i] === '<' ---
// Returns {kind:'link', url, isEmail, end} | {kind:'html', html, end} | null.
const RE_ANGLE_SCHEME = /<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/y;
const RE_ANGLE_EMAIL = /<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/y;
const RE_ANGLE_COMMENT_EMPTY = /<!-->|<!--->/y;
const RE_ANGLE_COMMENT = /<!--[\s\S]*?-->/y;
const RE_ANGLE_PI = /<\?[\s\S]*?\?>/y;
const RE_ANGLE_DECL = /<![A-Za-z][\s\S]*?>/y;
const RE_ANGLE_CDATA = /<!\[CDATA\[[\s\S]*?\]\]>/y;
const RE_ANGLE_TAG = /<[A-Za-z][A-Za-z0-9-]*(?:[ \t\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t\n]*\/?>/y;
const RE_ANGLE_CTAG = /<\/[A-Za-z][A-Za-z0-9-]*[ \t\n]*>/y;
function matchAngle(text, i) {
  let m;
  RE_ANGLE_SCHEME.lastIndex = i;
  m = RE_ANGLE_SCHEME.exec(text);
  if (m) return { kind: 'link', url: m[1] + ':' + m[2], isEmail: false, end: i + m[0].length };
  RE_ANGLE_EMAIL.lastIndex = i;
  m = RE_ANGLE_EMAIL.exec(text);
  if (m) return { kind: 'link', url: 'mailto:' + m[1], isEmail: true, end: i + m[0].length, label: m[1] };
  RE_ANGLE_COMMENT_EMPTY.lastIndex = i;
  m = RE_ANGLE_COMMENT_EMPTY.exec(text);
  if (m) return { kind: 'html', html: m[0], end: i + m[0].length };
  RE_ANGLE_COMMENT.lastIndex = i;
  m = RE_ANGLE_COMMENT.exec(text);
  if (m) return { kind: 'html', html: m[0], end: i + m[0].length };
  RE_ANGLE_PI.lastIndex = i;
  m = RE_ANGLE_PI.exec(text);
  if (m) return { kind: 'html', html: m[0], end: i + m[0].length };
  RE_ANGLE_DECL.lastIndex = i;
  m = RE_ANGLE_DECL.exec(text);
  if (m) return { kind: 'html', html: m[0], end: i + m[0].length };
  RE_ANGLE_CDATA.lastIndex = i;
  m = RE_ANGLE_CDATA.exec(text);
  if (m) return { kind: 'html', html: m[0], end: i + m[0].length };
  RE_ANGLE_TAG.lastIndex = i;
  m = RE_ANGLE_TAG.exec(text);
  if (m) return { kind: 'html', html: m[0], end: i + m[0].length };
  RE_ANGLE_CTAG.lastIndex = i;
  m = RE_ANGLE_CTAG.exec(text);
  if (m) return { kind: 'html', html: m[0], end: i + m[0].length };
  return null;
}

// --- extended GFM autolink (www. / bare email / bare scheme) at text[i] ---
// Returns {url, isEmail, label, end} or null. An email followed by `_`
// or `-` is not an autolink (the email pattern's trailing lookahead).
const RE_GFM_SCHEME = /[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s<>]*/y;
const RE_GFM_SCHEME_NOSLASH = /[A-Za-z][A-Za-z0-9+.-]{1,31}:[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?:\/[^\s<>\/]+)?/y;
const RE_GFM_WWW = /www\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)*/y;
const RE_GFM_WWW_PATH = /[^\s<>\]]*/y;
const RE_GFM_EMAIL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/y;
const RE_BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
// Trim a bare-URL autolink the way marked does: repeatedly keep the
// longest prefix the backpedal pattern accepts. A trailing ')' is kept
// when more URL text follows it; a ']' is ordinary URL text.
function backpedalUrl(url) {
  let prev, cur = url;
  do {
    prev = cur;
    const m = RE_BACKPEDAL.exec(cur);
    cur = m ? m[0] : '';
  } while (cur !== prev);
  return cur;
}

function matchGfmAutolink(text, i) {
  let m;
  RE_GFM_SCHEME.lastIndex = i;
  m = RE_GFM_SCHEME.exec(text);
  if (m) {
    const label = backpedalUrl(m[0]);
    if (label.length > 0) {
      return { url: label, isEmail: false, label, end: i + label.length };
    }
  }
  RE_GFM_SCHEME_NOSLASH.lastIndex = i;
  m = RE_GFM_SCHEME_NOSLASH.exec(text);
  if (m) {
    const end = trimAutolinkEnd(text, i, i + m[0].length);
    if (end > i) {
      if (text[end] === '-' || text[end] === '_') return null;
      const label = text.slice(i, end);
      return { url: label, isEmail: false, label, end };
    }
  }
  RE_GFM_WWW.lastIndex = i;
  m = RE_GFM_WWW.exec(text);
  if (m) {
    let end = i + m[0].length;
    RE_GFM_WWW_PATH.lastIndex = end;
    const pm = RE_GFM_WWW_PATH.exec(text);
    if (pm) end += pm[0].length;
    const label = backpedalUrl(text.slice(i, end));
    if (label.length > 0) {
      return { url: 'http://' + label, isEmail: false, label, end: i + label.length };
    }
  }
  RE_GFM_EMAIL.lastIndex = i;
  m = RE_GFM_EMAIL.exec(text);
  if (m) {
    let end = i + m[0].length;
    end = trimAutolinkEnd(text, i, end);
    if (end <= i) return null;
    if (text[end] === '-') return null;
    if (text[end] === '_') return null;
    const label = text.slice(i, end);
    return { url: 'mailto:' + label, isEmail: true, label, end };
  }
  return null;
}

// Strip trailing punctuation from an extended autolink per the GFM rules:
// trailing ? ! . , : * _ ~ ; a trailing ) without a matching ( in the link;
// a trailing ( with no matching ) after it; a trailing ; that completes
// an entity reference.
function trimAutolinkEnd(text, start, end) {
  let e = end;
  for (;;) {
    if (e <= start) break;
    const ch = text[e - 1];
    if ('?!.,:*_~'.indexOf(ch) !== -1) { e--; continue; }
    if (ch === '(') { e--; continue; }
    if (ch === ';') {
      let k = e - 2;
      while (k >= start && /[A-Za-z0-9#]/.test(text[k])) k--;
      if (k >= start && text[k] === '&') { e = k; continue; }
      e--; continue;
    }
    if (ch === ')') {
      let open = 0, close = 0;
      for (let k = start; k < e; k++) {
        if (text[k] === '(') open++;
        else if (text[k] === ')') close++;
      }
      if (close > open) { e--; continue; }
      break;
    }
    break;
  }
  return e;
}

// --- code span starting at text[i] === '`' ---
// Returns {content, end} (end = the index past the closing run), or null.
// The closing run must be exactly as long as the opening run and must not
// be part of a longer run; the content between them is non-empty. Newlines
// inside become spaces, and one space is stripped from each end when the
// content both starts and ends with a space (and is not all spaces).
function matchCodeSpan(text, i) {
  // Length of the backtick run starting at `at`.
  const runLen = (at) => {
    let m = at;
    while (m < text.length && text[m] === '`') m++;
    return m - at;
  };
  const run = runLen(i);
  const contentStart = i + run;
  for (let k = contentStart; k < text.length;) {
    if (text[k] !== '`') {
      k++;
      continue;
    }
    const closerLen = runLen(k);
    if (closerLen === run) {
      let content = text.slice(contentStart, k).replace(/\n/g, ' ');
      if (content.length > 0 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      return { content, end: k + closerLen };
    }
    k += closerLen;
  }
  return null;
}

// --- link label starting at text[i] === '[' ---
// Returns {text, end} (end = index past the closing ']') or null. The
// label may hold escapes, balanced bracket groups, and code spans (any
// backtick run, any closer run); a stray backtick run that cannot be a
// code span rejects the label, as does an unmatched '[' or a missing ']'.
const RE_LABEL_CODE_SPAN = /`+(?!`)[^`]*?`+(?!`)/y;
const RE_LABEL_CODE_SPAN_BEFORE_BRACKET = /`+(?=\])/y;
function matchLabel(text, i) {
  if (text[i] !== '[') return null;
  let label = '';
  let j = i + 1;
  // Opener run length of a code span whose closer run came up short
  // (the sloppy span matcher lets the closer be shorter than the opener,
  // so the span's closing backticks are still outstanding). A backtick
  // run right before ']' while one is outstanding is that span's missing
  // closer, not the start of a new span.
  let pendingCloser = 0;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length) {
      label += text.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (ch === '[') {
      // A nested bracket group, which may itself hold further groups.
      const end = scanBracketGroup(text, j);
      if (end === -1) return null;
      label += text.slice(j, end);
      j = end;
      continue;
    }
    if (ch === '`') {
      if (pendingCloser > 0) {
        RE_LABEL_CODE_SPAN_BEFORE_BRACKET.lastIndex = j;
        const bm = RE_LABEL_CODE_SPAN_BEFORE_BRACKET.exec(text);
        if (bm) {
          let runLen = 0;
          while (runLen < bm[0].length && bm[0][runLen] === '`') runLen++;
          if (runLen >= pendingCloser) {
            label += bm[0];
            j += bm[0].length;
            pendingCloser = 0;
            continue;
          }
        }
      }
      RE_LABEL_CODE_SPAN.lastIndex = j;
      const cm = RE_LABEL_CODE_SPAN.exec(text);
      if (cm) {
        let openLen = 0;
        while (openLen < cm[0].length && cm[0][openLen] === '`') openLen++;
        let closeLen = 0;
        while (closeLen < cm[0].length && cm[0][cm[0].length - 1 - closeLen] === '`') closeLen++;
        if (closeLen < openLen) pendingCloser = openLen;
        label += cm[0];
        j += cm[0].length;
        continue;
      }
      RE_LABEL_CODE_SPAN_BEFORE_BRACKET.lastIndex = j;
      const bm = RE_LABEL_CODE_SPAN_BEFORE_BRACKET.exec(text);
      if (bm) {
        label += bm[0];
        j += bm[0].length;
        continue;
      }
      return null;
    }
    if (ch === ']') {
      return { text: label, end: j + 1 };
    }
    label += ch;
    j++;
    if (label.length > 999) return null;
  }
  return null;
}

// The end index (exclusive) of the bracket group starting at text[i]
// ('['), or -1 when it never closes. Nested groups, escapes and code
// spans inside the group are honoured.
function scanBracketGroup(text, i) {
  let j = i + 1;
  // Same outstanding-closer tracking as matchLabel.
  let pendingCloser = 0;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length) { j += 2; continue; }
    if (ch === '[') {
      const end = scanBracketGroup(text, j);
      if (end === -1) return -1;
      j = end;
      continue;
    }
    if (ch === '`') {
      if (pendingCloser > 0) {
        RE_LABEL_CODE_SPAN_BEFORE_BRACKET.lastIndex = j;
        const bm = RE_LABEL_CODE_SPAN_BEFORE_BRACKET.exec(text);
        if (bm) {
          let runLen = 0;
          while (runLen < bm[0].length && bm[0][runLen] === '`') runLen++;
          if (runLen >= pendingCloser) { j += bm[0].length; pendingCloser = 0; continue; }
        }
      }
      RE_LABEL_CODE_SPAN.lastIndex = j;
      const cm = RE_LABEL_CODE_SPAN.exec(text);
      if (cm) {
        let openLen = 0;
        while (openLen < cm[0].length && cm[0][openLen] === '`') openLen++;
        let closeLen = 0;
        while (closeLen < cm[0].length && cm[0][cm[0].length - 1 - closeLen] === '`') closeLen++;
        if (closeLen < openLen) pendingCloser = openLen;
        j += cm[0].length;
        continue;
      }
      RE_LABEL_CODE_SPAN_BEFORE_BRACKET.lastIndex = j;
      const bm = RE_LABEL_CODE_SPAN_BEFORE_BRACKET.exec(text);
      if (bm) { j += bm[0].length; continue; }
      return -1;
    }
    if (ch === ']') return j + 1;
    j++;
    if (j - i > 999) return -1;
  }
  return -1;
}

// --- link destination and title inside parens, starting at text[i] === '(' ---
// Returns {dest, title, end} (end = the index past the closing ')'), or
// null when the parens do not hold a valid destination. The destination
// is either `<...>` or a bare run with balanced parens (a ')' that would
// close more parens than were opened ends the destination and becomes
// the link's closer); a title may follow after whitespace, in double
// quotes, single quotes, or parens.
function matchLinkParen(text, i) {
  // How many consecutive backslashes end right before index `at`?
  // An odd count means the character at `at` is escaped.
  const trailingBackslashes = (at) => {
    let n = 0;
    for (let b = at - 1; b >= 0 && text[b] === '\\'; b--) n++;
    return n;
  };
  // Skip spaces, tabs and newlines, returning the first other index.
  const skipWs = (from) => {
    let k = from;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
    return k;
  };

  let j = skipWs(i + 1);
  let dest = null;
  if (text[j] === '<') {
    // Angle-bracket destination: escapes pass through, a newline or a
    // second '<' rejects it, and the closing '>' must not be escaped.
    let closed = -1;
    for (let k = j + 1; k < text.length; k++) {
      const c = text[k];
      if (c === '\\' && k + 1 < text.length) { k++; continue; }
      if (c === '\n' || c === '<') break;
      if (c === '>') { closed = k; break; }
    }
    if (closed === -1) return null;
    if (trailingBackslashes(closed) % 2 === 1) return null;
    dest = text.slice(j + 1, closed);
    j = closed + 1;
  } else {
    // Bare destination: it stops at whitespace or a control character.
    // '(' opens a level and ')' closes one; a ')' with no level open
    // ends the destination instead (it is the link's closing paren).
    // An empty destination is allowed only when ')' follows at once.
    let depth = 0;
    let k = j;
    while (k < text.length) {
      const c = text[k];
      if (c === '\\' && k + 1 < text.length) { k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c.charCodeAt(0) < 0x20) break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (depth > 0) return null;
    if (k === j && text[k] !== ')') return null;
    dest = text.slice(j, k);
    j = k;
  }

  // Optional title: it needs whitespace before it, then a quoted or
  // parenthesised run. When the title is missing or unclosed, the text
  // after the destination is left for the closing-paren check.
  let title = null;
  let k = skipWs(j);
  const hasWs = k > j;
  if (k < text.length && hasWs && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const open = text[k];
    const close = open === '(' ? ')' : open;
    let tEnd = -1;
    for (let t = k + 1; t < text.length; t++) {
      if (text[t] === '\\' && t + 1 < text.length) { t++; continue; }
      if (text[t] === close) { tEnd = t; break; }
    }
    if (tEnd !== -1) {
      title = text.slice(k + 1, tEnd);
      k = skipWs(tEnd + 1);
    }
  }

  // The next character must be the link's closing ')', unescaped.
  if (text[k] !== ')') return null;
  if (trailingBackslashes(k) % 2 === 1) return null;
  return { dest, title, end: k + 1 };
}

// --- the "label holds an unclosed <" check ---
// A link label is invalid when it contains a '<' that starts a tag or
// autolink reaching past the label's end (the label never closes).
// `src` is the text being tokenized, `labelText` the label content and
// `labelStart` the absolute index of the label's first character.
function labelHasOpenAngle(src, labelText, labelStart) {
  if (!labelText.includes('<')) return false;
  for (let s = 0; s < labelText.length; s++) {
    const ch = labelText[s];
    if (ch === '\\') {
      s++;
      continue;
    }
    if (ch === '`') {
      // Skip a code span whole; a stray backtick run is skipped too.
      const cs = matchCodeSpan(labelText, s);
      if (cs) {
        s += cs.end - s - 1;
        continue;
      }
      let j = s;
      while (j < labelText.length && labelText[j] === '`') j++;
      s = j - 1;
      continue;
    }
    if (ch !== '<') continue;
    const a = matchAngle(src, labelStart + s);
    if (!a) continue;
    const angleStart = labelStart + s;
    if (a.end - angleStart > labelText.length - s) return true;
    s += a.end - angleStart - 1;
  }
  return false;
}

// --- reference text starting at text[i] === '[' ---
// The reference pattern: 1 to 999 characters, each an escape or any
// character except '[', ']' and a backslash, and not empty or only
// whitespace. Returns {text, end} (end = the index past the closing
// ']'), or null.
function matchRefText(text, i) {
  if (text[i] !== '[') return null;
  let ref = '';
  let j = i + 1;
  while (j < text.length && ref.length < 999) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length) {
      ref += text.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (ch === ']') break;
    if (ch === '[') return null;
    ref += ch;
    j++;
  }
  if (text[j] !== ']') return null;
  if (ref.length === 0 || ref.trim() === '') return null;
  return { text: ref, end: j + 1 };
}

// --- shortcut reference link at src[i] === '[' (or '![') ---
// The shortcut label follows the reference pattern rather than the label
// pattern, so it is matched independently of matchLabel.
function matchShortcutLink(src, i, refs) {
  const ref = matchRefText(src, i);
  if (!ref) return null;
  const entry = refs.get(normalizeLabel(ref.text));
  if (!entry) return null;
  return { label: ref.text, dest: entry.dest, title: entry.title, end: ref.end };
}

// Does a token tree hold a regular (non-autolink) link anywhere? A link
// inside an image's alt text does not count, because the image's label
// tokenization restores the flag.
function containsLink(tokens) {
  for (const tok of tokens) {
    if (tok.t === 'link' && !tok.isAutolink) return true;
    if (tok.t === 'image') continue;
    if (tok.children && containsLink(tok.children)) return true;
  }
  return false;
}

// --- last possible closer for a delimiter run ---
// A plain scan of the raw string: the last run of `*`, `_` or `~` whose
// preceding character is not a space, tab, newline, carriage return or
// form feed. A run at position 0 does not count. This bounds the closer
// search, exactly as marked bounds its scan.
function lastClosers(src) {
  let star = -1;
  let und = -1;
  let tilde = -1;
  const n = src.length;
  for (let s = 0; s < n;) {
    const ch = src[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      s++;
      continue;
    }
    let i = s + 1;
    while (i < n && src[i] === ch) i++;
    const o = s === 0 ? '\n' : src[s - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (ch === '*') star = s;
      else if (ch === '_') und = s;
      else tilde = s;
    }
    s = i;
  }
  return { star, und, tilde };
}

// --- closer classification ---
// Classify a delimiter run by its neighbours as 'clean' (groups 1-2),
// 'opener' (groups 3-4), 'cond' (groups 5-6) or 'none'. `prev` is the
// character before the run ('' at the start), `next` the character after
// it ('' at the end). The patterns below are marked's right-delimiter
// patterns for the GFM rules, group by group.
function classifyCloserStar(prev, next) {
  if (isPunctNoTilde(prev) && (isUnicodeSpace(next) || next === '')) return 'clean';
  if (isNotPunctSpaceStar(prev) && (isUnicodeSpace(next) || isPunctNoTilde(next) || next === '')) return 'clean';
  if ((isUnicodeSpace(prev) || isPunctNoTilde(prev)) && isNotPunctSpaceStar(next)) return 'opener';
  if (isUnicodeSpace(prev) && isPunctNoTilde(next)) return 'opener';
  if (isPunctNoTilde(prev) && isPunctNoTilde(next)) return 'cond';
  if (isNotPunctSpaceStar(prev) && isNotPunctSpaceStar(next)) return 'cond';
  return 'none';
}
function classifyCloserUnd(prev, next) {
  if (isPunct(prev) && (isUnicodeSpace(next) || next === '')) return 'clean';
  if (isNotPunctSpace(prev) && (isUnicodeSpace(next) || isPunct(next) || next === '')) return 'clean';
  if ((isUnicodeSpace(prev) || isPunct(prev)) && isNotPunctSpace(next)) return 'opener';
  if (isUnicodeSpace(prev) && isPunct(next)) return 'opener';
  if (isPunct(prev) && isPunct(next)) return 'cond';
  return 'none';
}
function classifyCloserDel(prev, next) {
  if (prev !== '~' && isPunct(prev) && (isUnicodeSpace(next) || next === '')) return 'clean';
  if (isNotPunctSpace(prev) && next !== '~' && (isUnicodeSpace(next) || isPunct(next) || next === '')) return 'clean';
  if (prev !== '~' && (isUnicodeSpace(prev) || isPunct(prev)) && isNotPunctSpace(next)) return 'opener';
  if (isUnicodeSpace(prev) && next !== '~' && isPunct(next)) return 'opener';
  if (prev !== '~' && isPunct(prev) && next !== '~' && isPunct(next)) return 'cond';
  if (isNotPunctSpace(prev) && isNotPunctSpace(next)) return 'cond';
  return 'none';
}

// --- emphasis at src[pos] (a run of `ch`, '*' or '_') ---
// Returns {inner, end, strong} (inner = raw inner text, end = index past
// the used closer) or null. `prevChar` is the character before pos in
// the text being tokenized.
function emStrongAt(src, masked, pos, ch, lastCloser, prevChar) {
  const n = src.length;
  let runEnd = pos;
  while (runEnd < n && src[runEnd] === ch) runEnd++;
  const k = runEnd - pos;
  const next = runEnd < n ? src[runEnd] : '';
  // A run followed by a space, or at the end, is not an opener.
  if (next === '' || isUnicodeSpace(next)) return null;
  // d = the following punctuation character (group 1 for `*`, group 3
  // for `_`). The `~` does not count as punctuation in either delimiter.
  const d = isPunctNoTilde(next) ? next : '';
  let l = pos;
  while (l > 0 && masked[l - 1] === ch) l--;
  const p = l > 0 ? masked[l - 1] : '';
  const o = prevChar === ch;
  const h = p === '*' || p === '_' || isPunctSpaceNT(p);
  const nn = l < pos ? p : prevChar;
  const u = l < pos ? h : isPunctSpaceNT(nn);
  // A `_` run between alphanumerics cannot open. The rule only fires
  // when the following character is a non-punctuation character (the
  // fourth LDelim group); a following punctuation mark is exempt.
  if (ch === '_' && d === '' && !isUnicodeSpace(next) && next !== '_' && isAlnum(nn)) return null;
  // A run followed by punctuation can open only when the preceding
  // character is a space or punctuation (or there is none).
  if (d !== '' && nn !== '' && !u) return null;
  const y = pos - l + k;
  const R = p !== '' && p.trim() !== '' && (d !== '' || (ch === '*' && !h));
  const Q = pos + k;
  if (lastCloser < Q) return null;
  // The closer scan runs on the masked string after the opener, using
  // the right-delimiter pattern (its skip alternatives hide delimiters
  // inside the other delimiter's strong span).
  const A = ch === '*' ? RE_RDELIM_AST : RE_RDELIM_UND;
  const t2 = masked.slice(Q);
  const ee = lastCloser - Q;
  A.lastIndex = 0;
  let m = k, f = 0, s;
  while ((s = A.exec(t2)) !== null && !(s.index > ee)) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue; // a skip match: no candidate closer here
    const b = [...g].length;
    if (s[3] || s[4]) { m += b; continue; }
    if (s[5] || s[6] || R) {
      if (o && (s[5] || s[6])) break;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const use = Math.min(b, b + m + f);
    // The run starts at the end of the match (the match begins with
    // the preceding character); its position in the full text is
    // Q + s.index + s[0].length - g.length.
    const runStart = Q + s.index + s[0].length - g.length;
    const rawEnd = runStart + use;
    const strong = Math.min(k, use) % 2 === 0;
    const usedOpener = strong ? 2 : 1;
    const inner = src.slice(pos + usedOpener, rawEnd - usedOpener);
    return { inner, end: rawEnd, strong, usedOpener, openerRun: k };
  }
  return null;
}

// --- strikethrough at src[pos] (a run of '~') ---
// Returns {inner, end} or null. The closer must have exactly the same
// length as the opener (1 or 2 tildes); there is no rule of three.
function delAt(src, masked, pos, lastCloser, prevChar) {
  const n = src.length;
  let runEnd = pos;
  while (runEnd < n && src[runEnd] === '~' && runEnd - pos < 2) runEnd++;
  const o = runEnd - pos;
  if (o === 0) return null;
  const next = runEnd < n ? src[runEnd] : '';
  // The following character must exist and not be a space or a '~'.
  if (next === '' || isUnicodeSpace(next) || next === '~') return null;
  const d = isPunct(next) ? next : '';
  if (d !== '' && prevChar !== '' && !isPunctSpaceNT(prevChar)) return null;
  const Q = pos + o;
  if (lastCloser < Q) return null;
  const t2 = masked.slice(Q);
  const ee = lastCloser - Q;
  const A = RE_RDELIM_DEL;
  A.lastIndex = 0;
  let p = o, s;
  while ((s = A.exec(t2)) !== null && !(s.index > ee)) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (s[3] || s[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    const use = Math.min(l, l + p);
    const runStart = Q + s.index + s[0].length - g.length;
    const rawEnd = runStart + use;
    const inner = src.slice(pos + o, rawEnd - o);
    return { inner, end: rawEnd };
  }
  return null;
}

// --- numeric character reference at src[i] === '&' ---
// Only numeric references are decoded (&#35; &#x22;); named references
// pass through untouched, exactly as marked leaves them. Returns
// {text, end} or null.
function decodeEntityAt(src, i) {
  if (src[i] !== '&' || src[i + 1] !== '#') return null;
  let k = i + 2;
  let hex = false;
  if (src[k] === 'x' || src[k] === 'X') { hex = true; k++; }
  const d0 = k;
  while (k < src.length && (hex ? /[0-9a-fA-F]/.test(src[k]) : /[0-9]/.test(src[k]))) k++;
  if (k === d0 || src[k] !== ';') return null;
  if (hex && k - d0 > 6) return null;
  if (!hex && k - d0 > 7) return null;
  const body = src.slice(i + 1, k);
  return { text: escapeDecodedChar(decodeNumericRef(body)), end: k + 1 };
}

// Unescape backslash escapes before any punctuation character (marked's
// anyPunctuation replacement, applied to link destinations and titles).
// Remove backslash escapes before any punctuation or symbol character.
function unescapeAnyPunct(s) {
  return s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

// Clean a link destination the way marked does, but return null when it
// cannot be encoded (a lone surrogate): such a link renders as plain text.
function hrefOrNull(dest) {
  if (dest == null) return null;
  try {
    return encodeURI(dest).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// --- link or image starting at src[i] === '[' (or '![') ---
// Returns {token, end}, or null (null means: emit the '[' or '!' as text
// and move on).// Try a link or image starting at src[i] ('[' or '!['). The forms are
// tried in marked's order: inline link, full reference link, collapsed
// reference, shortcut reference. A full reference whose label matched but
// whose destination is undefined ends the attempt: marked returns a text
// token there and does not try the shortcut.
function tryLinkAt(src, i, refs, ctx) {
  const isImage = src[i] === '!';
  const bracketPos = i + (isImage ? 1 : 0);
  const labelStart = bracketPos + 1;
  if (src[bracketPos] !== '[') return null;

  // Build the link/image token from a destination, title and label text.
  // The label is tokenized inside a link, so an <a> tag inside it must
  // not leak its inLink state out of the label; a link inside a link's
  // label is rejected (but an image label may hold one).
  const makeToken = (rawDest, rawTitle, labelText, end) => {
    const savedInLinkHtml = inLinkHtml;
    inLinkHtml = true;
    const inner = tokenizeInline(labelText, refs, { inLink: true });
    inLinkHtml = savedInLinkHtml;
    if (!isImage && containsLink(inner)) return null;
    const dest = unescapeAnyPunct(rawDest);
    const title = rawTitle == null ? null : unescapeAnyPunct(rawTitle);
    const token = isImage
      ? { t: 'image', dest, title, children: inner }
      : { t: 'link', dest, title, children: inner };
    return { token, end };
  };
  // Try the shortcut reference for the bracket at `bracketPos`. The
  // token ends at `end` (past the `[]` for a collapsed reference, past
  // the label's ']' otherwise).
  const tryShortcut = (end) => {
    const sc = matchShortcutLink(src, bracketPos, refs);
    if (!sc) return null;
    if (labelHasOpenAngle(src, sc.label, labelStart)) return null;
    return makeToken(sc.dest, sc.title, sc.label, end === null ? sc.end : end);
  };

  const lab = matchLabel(src, bracketPos);
  if (!lab) {
    // The label pattern did not match, but the shortcut reference
    // pattern may still match (it accepts different contents).
    return tryShortcut(null);
  }

  const after = lab.end;
  if (src[after] === '(') {
    const par = matchLinkParen(src, after);
    if (par && !labelHasOpenAngle(src, lab.text, labelStart)) {
      const r = makeToken(par.dest, par.title, lab.text, par.end);
      if (r) return r;
    }
    // The inline form failed: fall through to the reference forms.
  }
  if (src[after] === '[') {
    const ref = matchRefText(src, after);
    if (ref) {
      const entry = refs.get(normalizeLabel(ref.text));
      if (entry && !labelHasOpenAngle(src, lab.text, labelStart)) {
        const r = makeToken(entry.dest, entry.title, lab.text, ref.end);
        if (r) return r;
      }
      return null;
    }
    if (src[after + 1] === ']') {
      // Collapsed reference `[label][]`: the token ends past the `[]`.
      return tryShortcut(after + 2);
    }
    return null;
  }
  return tryShortcut(null);
}

// The right-delimiter scans. These are the exact patterns marked uses:
// the first alternative in each hides a delimiter that sits inside the
// other delimiter's strong span (`*` inside `__...__`, `_` inside
// `**...**`); the second alternative skips non-delimiter text; the
// remaining groups classify a candidate closer (1,2 clean; 3,4 opener;
// 5,6 conditional).
const RE_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RE_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RE_RDELIM_DEL = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

// Whether the document is inside an <a ...> tag (opened by an HTML tag
// and not yet closed by </a>). While set, no GFM autolink forms. This is
// document state, not per-paragraph: it is reset at the start of parse().
let inLinkHtml = false;
const RE_START_A_TAG = /^<a /;
const RE_END_A_TAG = /^<\/a>/;

// --- the main inline tokenizer ---
// Left to right, the first matching construct at each position wins:
// escape, HTML tag / autolink, link, emphasis, code span, hard break,
// strikethrough, bare autolink, character reference, plain text.
// `ctx.inLink` is true while tokenizing a link's label: bare autolinks
// do not form there, but angle autolinks do.
function tokenizeInline(src, refs, ctx) {
  const tokens = [];
  let textBuf = '';
  const flushText = () => {
    if (textBuf !== '') {
      tokens.push({ t: 'text', s: textBuf });
      textBuf = '';
    }
  };
  const masked = maskInline(src, refs);
  const closers = lastClosers(masked);
  const n = src.length;
  let i = 0;
  const isWordChar = (ch) => ch !== '' && /[A-Za-z0-9_]/.test(ch);
  while (i < n) {
    const ch = src[i];
    const prevChar = i > 0 ? src[i - 1] : '';
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flushText();
        tokens.push({ t: 'br' });
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        // An escaped '&' is written pre-escaped, so it cannot merge with
        // the following text into a character reference (&ouml; stays
        // &amp;ouml;, it does not become an entity).
        textBuf += nx === '&' ? '&amp;' : nx;
        i += 2;
        continue;
      }
      textBuf += '\\';
      i++;
      continue;
    }
    if (ch === '<') {
      const a = matchAngle(src, i);
      if (a) {
        flushText();
        if (a.kind === 'link') {
          const label = a.isEmail ? a.label : a.url;
          tokens.push({ t: 'link', dest: a.url, title: null, children: [{ t: 'text', s: label }], isAutolink: true });
        } else {
          // An opening <a ...> tag puts the rest of the document inside
          // a link (until a closing </a>); while inside it, no GFM
          // autolink forms. The state persists across paragraphs.
          if (!inLinkHtml && RE_START_A_TAG.test(a.html)) inLinkHtml = true;
          else if (inLinkHtml && RE_END_A_TAG.test(a.html)) inLinkHtml = false;
          tokens.push({ t: 'html', s: a.html });
        }
        i = a.end;
        continue;
      }
      textBuf += '<';
      i++;
      continue;
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const r = tryLinkAt(src, i, refs, ctx);
      if (r) {
        flushText();
        tokens.push(r.token);
        i = r.end;
        continue;
      }
      textBuf += ch;
      i++;
      continue;
    }
    if (ch === '*' || ch === '_') {
      const em = emStrongAt(src, masked, i, ch, ch === '*' ? closers.star : closers.und, prevChar);
      if (em) {
        flushText();
        const inner = tokenizeInline(em.inner, refs, { inLink: ctx.inLink });
        tokens.push({ t: em.strong ? 'strong' : 'em', children: inner });
        i = em.end;
        continue;
      }
      // Not emphasis: emit one delimiter character as text and retry
      // the rest of the run at the next position (a longer run can open
      // from its second character).
      textBuf += ch;
      i++;
      continue;
    }
    if (ch === '`') {
      const cs = matchCodeSpan(src, i);
      if (cs) {
        flushText();
        tokens.push({ t: 'code', s: cs.content });
        i = cs.end;
        continue;
      }
      let j = i;
      while (j < n && src[j] === '`') j++;
      textBuf += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '\n') {
      let k = textBuf.length;
      while (k > 0 && textBuf[k - 1] === ' ') k--;
      if (textBuf.length - k >= 2) {
        textBuf = textBuf.slice(0, k);
        flushText();
        tokens.push({ t: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      textBuf += '\n';
      i++;
      continue;
    }
    if (ch === '~') {
      const d = delAt(src, masked, i, closers.tilde, prevChar);
      if (d) {
        flushText();
        const inner = tokenizeInline(d.inner, refs, { inLink: ctx.inLink });
        tokens.push({ t: 'del', children: inner });
        i = d.end;
        continue;
      }
      textBuf += '~';
      i++;
      continue;
    }
    if (ch === '&') {
      const ent = decodeEntityAt(src, i);
      if (ent) {
        textBuf += ent.text;
        i = ent.end;
        continue;
      }
      textBuf += '&';
      i++;
      continue;
    }
    if (!ctx.inLink && !inLinkHtml && isWordChar(ch) && (i === 0 || !isWordChar(prevChar))) {
      const a = matchGfmAutolink(src, i);
      if (a) {
        flushText();
        tokens.push({ t: 'link', dest: a.url, title: null, children: [{ t: 'text', s: a.label }], isAutolink: true });
        i = a.end;
        continue;
      }
    }
    textBuf += ch;
    i++;
  }
  flushText();
  return tokens;
}

// --- rendering ---
// The plain-text form of a token tree (used for image alt text): every
// construct renders as its text, with no tags.
function plainText(tokens) {
  let out = '';
  for (const tok of tokens) {
    if (tok.t === 'text' || tok.t === 'code' || tok.t === 'html') out += tok.s;
    else if (tok.t === 'br') out += '\n';
    else if (tok.children) out += plainText(tok.children);
  }
  return out;
}

// Render a flat inline token list to HTML. A link whose destination does
// not survive cleaning renders as its children with no <a> tag; an image
// with no usable destination renders as its alt text alone.
function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'text':
        out += escapeText(tok.s);
        break;
      case 'code':
        out += '<code>' + escapeCode(tok.s) + '</code>';
        break;
      case 'html':
        out += tok.s;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'em':
        out += '<em>' + renderTokens(tok.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderTokens(tok.children) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderTokens(tok.children) + '</del>';
        break;
      case 'link': {
        const href = hrefOrNull(tok.dest);
        if (href === null) {
          out += renderTokens(tok.children);
          break;
        }
        out += '<a href="' + escapeText(href) + '"';
        if (tok.title !== null && tok.title !== undefined) out += ' title="' + escapeText(tok.title) + '"';
        out += '>' + renderTokens(tok.children) + '</a>';
        break;
      }
      case 'image': {
        const href = hrefOrNull(tok.dest);
        const alt = escapeText(plainText(tok.children));
        if (href === null) {
          out += alt;
          break;
        }
        out += '<img src="' + escapeText(href) + '" alt="' + alt + '"';
        if (tok.title !== null && tok.title !== undefined) out += ' title="' + escapeText(tok.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

// Render one inline string to HTML. `refs` is the reference-link map
// from the block parser.
function parseInline(text, refs) {
  return renderTokens(tokenizeInline(text, refs, { inLink: false }));
}

// --- the emphasis mask ---
// Before the emphasis closer scan runs, the stretches of text where a
// delimiter cannot close an opener are blanked out: reference-link
// labels, escaped punctuation, code spans, link spans and HTML tags. The
// mask keeps the string length, so every index still lines up with the
// raw text — only the characters that could be mistaken for a closer are
// replaced.
const RE_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\\]|\\[\s\S]|[^\[\]\\])*\\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const RE_ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
// A link-like span for the mask: `[label](destination)` whose destination
// may hold spaces and balanced parens (the same shape marked's blockSkip
// uses — a space inside the parens must not stop the match, or a label
// like `[at _node ..._](<... optional>)` would stay unmasked and its `_`
// would wrongly close an emphasis), a code span, or an HTML tag.
const RE_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// Does `text` hold a link — an inline link, or a reference link whose
// destination is defined? Used when deciding whether a reference-link
// label may be masked.
function linkInText(text, refs) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(RE_BLOCK_SKIP)) {
    const span = m[0];
    const start = span.charAt(0) === '!' ? 1 : 0;
    if (span.charAt(start) !== '[') continue;
    const lab = matchLabel(span, start);
    if (!lab) continue;
    if (span[lab.end] !== '(') continue;
    if (!matchLinkParen(span, lab.end)) continue;
    if (text.charAt(m.index - 1) === '!') continue;
    return true;
  }
  for (const m of text.matchAll(RE_REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    const isImage = s.charAt(0) === '!';
    const refName = s.slice(r + 1, -1);
    const refDefined = refs.has(normalizeLabel(refName));
    if (isImage || !refDefined) continue;
    if (r > 1 && linkInText(s.slice(1, r - 1), refs)) continue;
    return true;
  }
  return false;
}

// Mask one reference link found by the reflink search: replace its label
// with 'a's so no delimiter inside it can close an emphasis. When the
// label itself holds a link, only the reference part is masked and the
// label is masked recursively.
function maskReflinkMatch(match, refs) {
  const o = match.lastIndexOf('[');
  if (!refs.has(normalizeLabel(match.slice(o + 1, -1)))) return match;
  if (o > 1 && match.charAt(0) !== '!') {
    const labelPart = match.slice(1, o - 1);
    if (linkInText(labelPart, refs)) {
      const maskedLabel = labelPart.replace(RE_REFLINK_SEARCH, (m) => maskReflinkMatch(m, refs));
      return '[' + maskedLabel + '][' + 'a'.repeat(match.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match.length - 2) + ']';
}

// The masked form of a string, for the emphasis closer scan.
function maskInline(src, refs) {
  let t = src;
  if (refs && refs.size > 0 && src.includes('[')) {
    t = t.replace(RE_REFLINK_SEARCH, (m) => maskReflinkMatch(m, refs));
  }
  // Code spans keep their outer backticks but lose any backtick inside
  // (it becomes '+', so it cannot look like a span boundary); an escaped
  // punctuation mark becomes '+'s of the same length.
  t = t.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (n, s, r) =>
    r ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
      : n);
  // A link span, code span or tag collapses to '[' + 'a's + ']'.
  t = t.replace(RE_BLOCK_SKIP, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  return t;
}
// ---------------------------------------------------------------- rendering
// Render a node's live children in order, marking the last one.
function renderBlocks(node, refs, endsWithNL, isTop) {
  let out = '';
  const kids = node.children.filter((c) => !c.removed);
  for (let k = 0; k < kids.length; k++) {
    out += renderBlock(kids[k], refs, k === kids.length - 1, isTop, endsWithNL);
  }
  return out;
}

function renderBlock(b, refs, isLast, isTop, endsWithNL) {
  switch (b.type) {
    case 'Paragraph':
      return '<p>' + parseInline(b.lines.join('\n'), refs) + '</p>\n';
    case 'Heading': {
      const content = b.lines.join('\n');
      return '<h' + b.level + '>' + parseInline(content, refs) + '</h' + b.level + '>\n';
    }
    case 'ThematicBreak':
      return '<hr>\n';
    case 'CodeBlock': {
      const content = b.lines.length ? b.lines.join('\n') + '\n' : '';
      if (b.fenced && b.info) {
        // The info string's first word is the language; backslash escapes
        // in it are unescaped before the class is emitted.
        const lang = unescapeStr(b.info.split(/[ \t]+/)[0]);
        return '<pre><code class="language-' + escapeText(lang) + '">' + escapeCode(content) + '</code></pre>\n';
      }
      return '<pre><code>' + escapeCode(content) + '</code></pre>\n';
    }
    case 'HtmlBlock': {
      // Lines joined with '\n'. The trailing newline is omitted when the
      // block is marked noTrailing, when it is the last child of a nested
      // container (a list item or blockquote closes right after it), or
      // when it is the last top-level block and the input itself has no
      // trailing newline. A whitespace-only line is NOT an empty line: it
      // does not suppress the newline.
      let trailing = '\n';
      if (b.noTrailing) trailing = '';
      else if (isLast && !isTop) trailing = '';
      else if (isLast && isTop && !endsWithNL) trailing = '';
      return b.lines.join('\n') + trailing;
    }
    case 'BlockQuote':
      return '<blockquote>\n' + renderBlocks(b, refs, true, false) + '</blockquote>\n';
    case 'List': {
      const tag = b.listType === 'ordered' ? 'ol' : 'ul';
      const startAttr = b.listType === 'ordered' && b.start !== 1 ? ' start="' + b.start + '"' : '';
      return '<' + tag + startAttr + '>\n' + renderBlocks(b, refs, true, false) + '</' + tag + '>\n';
    }
    case 'ListItem': {
      const list = b.parent;
      const tight = list ? list.tight : true;
      let inner = '';
      const kids = b.children.filter((c) => !c.removed);
      for (let k = 0; k < kids.length; k++) {
        const child = kids[k];
        const lastChild = k === kids.length - 1;
        if (child.type !== 'Paragraph') {
          inner += renderBlock(child, refs, lastChild, false, true);
          continue;
        }
        const text = child.lines.join('\n');
        // Task list item: a leading [ ] / [x] / [X] on the FIRST paragraph
        // (followed by whitespace or end of text) becomes a checkbox.
        if (k === 0) {
          const tm = /^\[( |x|X)\](?=[ \t]|$)/.exec(text);
          if (tm) {
            const checked = tm[1] === 'x' || tm[1] === 'X';
            const box = checked
              ? '<input checked="" disabled="" type="checkbox">'
              : '<input disabled="" type="checkbox">';
            const rest = parseInline(text.slice(3), refs);
            inner += tight ? box + rest : '<p>' + box + rest + '</p>\n';
            continue;
          }
        }
        // In a tight list every paragraph renders bare (no <p> tags).
        inner += tight ? parseInline(text, refs) : renderBlock(child, refs, lastChild, false, true);
      }
      return '<li>' + inner + '</li>\n';
    }
    case 'Table': {
      // One cell per header entry, with an align attribute when set.
      const cell = (tag, content, align) =>
        '<' + tag + (align ? ' align="' + align + '"' : '') + '>' + parseInline(content, refs) + '</' + tag + '>\n';
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < b.headerCells.length; c++) {
        out += cell('th', b.headerCells[c], b.aligns[c]);
      }
      out += '</tr>\n</thead>\n';
      if (b.rowCells.length > 0) {
        out += '<tbody>';
        for (const row of b.rowCells) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            out += cell('td', row[c], b.aligns[c]);
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return renderBlocks(b, refs, true, false);
  }
}

// ---------------------------------------------------------------- entry point
export function parse(markdown) {
  inLinkHtml = false;
  const { doc, refs } = parseBlocks(markdown);
  return renderBlocks(doc, refs, markdown.endsWith('\n'), true);
}









