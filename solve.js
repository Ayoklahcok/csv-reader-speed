// Fast drop-in for make.fun's csv-reader 1.0.0 (v3: v1 with the unquoted fast path inlined into the record loop).
// Same answers as the reference on every input; built for speed with
// indexOf-based field scans and slice() instead of a char-at-a-time loop.
//
// Semantics (from the bounty brief):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next non-doubled quote; "" is one
//   quote; CRLF / lone CR inside quotes read as LF; junk after the closing
//   quote up to the next comma or line break is appended as-is (quote_junk);
//   a quote that never closes is a literal char and the text after it is
//   re-read as unquoted (unterminated_quote).
// - A quote inside an unquoted field is literal. Fields stay strings.
// - columns is the first record when header is true, else null; rows are
//   padded with "" (short_row) or cut (long_row) to the first record's width.
// - Each error is {code, line, row} in the order met; line is the 1-based line
//   the record starts on (LF, CRLF and lone CR inside quotes all counted),
//   row is the record's index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;

  // Every CR position, collected once with native indexOf: a stray CR inside
  // an unquoted field, or a CRLF line end, is then an O(1) pointer lookup
  // instead of an unbounded scan per field.
  const crs = [];
  for (let i = text.indexOf('\r'); i !== -1; i = text.indexOf('\r', i + 1)) crs.push(i);
  let crPtr = 0;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` from `p` up to the next comma or
  // line break; a CR not followed by LF is dropped (stray_cr). Returns the
  // field, how it ended, and how many characters were kept.
  function readUnquoted(value, p) {
    let added = 0;
    for (;;) {
      const iComma = text.indexOf(',', p);
      const iLF = text.indexOf('\n', p);
      let end = len;
      let kind = END;
      if (iComma !== -1 && iComma < end) {
        end = iComma;
        kind = COMMA;
      }
      if (iLF !== -1 && iLF < end) {
        end = iLF;
        kind = LINE_BREAK;
      }
      while (crPtr < crs.length && crs[crPtr] < p) crPtr++;
      const cr = crPtr < crs.length ? crs[crPtr] : -1;
      if (cr !== -1 && cr < end) {
        if (kind === LINE_BREAK && cr === end - 1) {
          // CRLF: the CR sits right before the LF that ends the field.
          value += text.slice(p, cr);
          added += cr - p;
          pos = end + 1;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        // Stray CR: drop it, record it, and keep reading the same field.
        value += text.slice(p, cr);
        added += cr - p;
        error('stray_cr');
        p = cr + 1;
        crPtr++;
        continue;
      }
      value += text.slice(p, end);
      added += end - p;
      if (kind === COMMA) {
        pos = end + 1;
        return { value, ended: COMMA, added };
      }
      if (kind === LINE_BREAK) {
        pos = end + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      pos = len;
      return { value, ended: END, added };
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let q = pos + 1;
    let doubled = false;
    let close = -1;
    for (;;) {
      const i = text.indexOf('"', q);
      if (i === -1) break;
      if (text.charCodeAt(i + 1) === 34) {
        doubled = true;
        q = i + 2;
        continue;
      }
      close = i;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted. `line` never moved, so it is still the
      // opening line, as the reference resets it to.
      error('unterminated_quote');
      return readUnquoted('"', open + 1);
    }
    // The quoted segment, [open+1, close): does it hold a line break?
    const ni = text.indexOf('\n', open + 1);
    const hasNL = ni !== -1 && ni < close;
    while (crPtr < crs.length && crs[crPtr] < open + 1) crPtr++;
    const hasCR = crPtr < crs.length && crs[crPtr] < close;
    let value;
    if (!hasNL && !hasCR) {
      value = doubled
        ? text.slice(open + 1, close).replaceAll('""', '"')
        : text.slice(open + 1, close);
    } else {
      // Slow path (rare: a note spanning lines): rebuild the segment, each
      // CRLF / lone CR as one LF, "" as one quote, counting the line breaks.
      const seg = text.slice(open + 1, close);
      let out = '';
      let breaks = 0;
      for (let k = 0; k < seg.length; k++) {
        const c = seg.charCodeAt(k);
        if (c === 34 && seg.charCodeAt(k + 1) === 34) {
          out += '"';
          k++;
        } else if (c === 13) {
          out += '\n';
          breaks++;
          if (seg.charCodeAt(k + 1) === 10) k++;
        } else if (c === 10) {
          out += '\n';
          breaks++;
        } else {
          out += seg[k];
        }
      }
      value = out;
      line += breaks;
    }
    pos = close + 1;
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value, pos);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let fValue;
    let fEnded;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const f = readQuoted();
        fValue = f.value;
        fEnded = f.ended;
      } else {
        // Inlined readUnquoted('', pos): the common path, without the call.
        quoted = false;
        let value = '';
        let p = pos;
        let ended;
        for (;;) {
          const iComma = text.indexOf(',', p);
          const iLF = text.indexOf('\n', p);
          let end = len;
          let kind = END;
          if (iComma !== -1 && iComma < end) {
            end = iComma;
            kind = COMMA;
          }
          if (iLF !== -1 && iLF < end) {
            end = iLF;
            kind = LINE_BREAK;
          }
          while (crPtr < crs.length && crs[crPtr] < p) crPtr++;
          const cr = crPtr < crs.length ? crs[crPtr] : -1;
          if (cr !== -1 && cr < end) {
            if (kind === LINE_BREAK && cr === end - 1) {
              value += text.slice(p, cr);
              pos = end + 1;
              line += 1;
              ended = LINE_BREAK;
              break;
            }
            value += text.slice(p, cr);
            error('stray_cr');
            p = cr + 1;
            crPtr++;
            continue;
          }
          value += text.slice(p, end);
          if (kind === COMMA) {
            pos = end + 1;
            ended = COMMA;
          } else if (kind === LINE_BREAK) {
            pos = end + 1;
            line += 1;
            ended = LINE_BREAK;
          } else {
            pos = len;
            ended = END;
          }
          break;
        }
        fValue = value;
        fEnded = ended;
      }
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
