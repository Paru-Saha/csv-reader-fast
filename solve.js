// A faster drop-in for make.fun's csv-reader 1.0.0: run(input) returns the same {columns, rows, errors} for every
// {text, header}, by the same broken-row policy, read once left to right.
//
// Where the reference builds every field a character at a time, this reader scans character codes and cuts each
// field out of the text with one slice. The common fields (an unquoted field, or a quoted one with no doubled quote,
// no CR inside and a comma or line break after its closing quote) are read inline in the record loop with local
// state; every other field (a stray CR, a doubled quote, a CR inside quotes, junk after a closing quote, a quote that
// never closes) goes to the general readers below, which share their state through `st`. The policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one quote, and each
//     CRLF or lone CR inside it is read as LF; what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never closes is a literal character and
//     the text after it is read again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings;
//   - columns is the first record when header is true, else null; rows holds the records after it, each padded with
//     "" (short_row, with fields) or cut (long_row, with extra) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on, row its index in rows (null for
//     the header), in the order met.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

const CH_COMMA = 44;
const CH_QUOTE = 34;
const CH_LF = 10;
const CH_CR = 13;
const CH_BOM = 0xfeff;

/** The general readers' shared state: the text, where they are, and how the last field ended. */
const st = {
  text: '',
  n: 0,
  pos: 0,
  line: 1,
  ended: END,
  added: 0,
  errors: null,
  recordLine: 1,
  recordRow: null,
};

/** Unquoted characters from st.pos onto `value`, up to the next comma or line break (stray_cr for a lone CR). */
function readUnquoted(value) {
  const text = st.text;
  const n = st.n;
  let i = st.pos;
  let start = i;
  let kept = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === CH_COMMA || c === CH_LF) {
      kept += i - start;
      if (i > start) value = value === '' ? text.slice(start, i) : value + text.slice(start, i);
      st.pos = i + 1;
      if (c === CH_LF) {
        st.line += 1;
        st.ended = LINE_BREAK;
      } else {
        st.ended = COMMA;
      }
      st.added = kept;
      return value;
    }
    if (c === CH_CR) {
      kept += i - start;
      if (i > start) value = value === '' ? text.slice(start, i) : value + text.slice(start, i);
      if (i + 1 < n && text.charCodeAt(i + 1) === CH_LF) {
        st.pos = i + 2;
        st.line += 1;
        st.ended = LINE_BREAK;
        st.added = kept;
        return value;
      }
      st.errors.push({ code: 'stray_cr', line: st.recordLine, row: st.recordRow });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  kept += n - start;
  if (n > start) value = value === '' ? text.slice(start, n) : value + text.slice(start, n);
  st.pos = n;
  st.ended = END;
  st.added = kept;
  return value;
}

/** A quoted field whose opening quote is at st.pos. */
function readQuoted() {
  const text = st.text;
  const n = st.n;
  const open = st.pos;
  const openLine = st.line;
  let line = openLine;
  let value = '';
  let i = open + 1;
  let start = i;
  let closed = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === CH_QUOTE) {
      if (i + 1 < n && text.charCodeAt(i + 1) === CH_QUOTE) {
        value += text.slice(start, i + 1);
        i += 2;
        start = i;
        continue;
      }
      if (i > start) value = value === '' ? text.slice(start, i) : value + text.slice(start, i);
      i += 1;
      closed = true;
      break;
    }
    if (c === CH_CR) {
      value += text.slice(start, i) + '\n';
      line += 1;
      i += i + 1 < n && text.charCodeAt(i + 1) === CH_LF ? 2 : 1;
      start = i;
      continue;
    }
    if (c === CH_LF) line += 1;
    i += 1;
  }
  if (!closed) {
    st.pos = open + 1;
    st.line = openLine;
    st.errors.push({ code: 'unterminated_quote', line: st.recordLine, row: st.recordRow });
    return readUnquoted('"');
  }
  st.line = line;
  st.pos = i;
  if (i >= n) {
    st.ended = END;
    return value;
  }
  const c = text.charCodeAt(i);
  if (c === CH_COMMA) {
    st.pos = i + 1;
    st.ended = COMMA;
    return value;
  }
  if (c === CH_LF) {
    st.pos = i + 1;
    st.line = line + 1;
    st.ended = LINE_BREAK;
    return value;
  }
  if (c === CH_CR && i + 1 < n && text.charCodeAt(i + 1) === CH_LF) {
    st.pos = i + 2;
    st.line = line + 1;
    st.ended = LINE_BREAK;
    return value;
  }
  value = readUnquoted(value);
  if (st.added > 0) st.errors.push({ code: 'quote_junk', line: st.recordLine, row: st.recordRow });
  return value;
}

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === CH_BOM) pos = 1;

  st.text = text;
  st.n = n;
  st.errors = errors;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === CH_LF) {
        pos += 1;
        line += 1;
      } else if (c === CH_CR && pos + 1 < n && text.charCodeAt(pos + 1) === CH_LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = COMMA;
    do {
      let i = pos;
      if (i < n && text.charCodeAt(i) === CH_QUOTE) {
        // A quoted field: inline when its closing quote is the first quote after it, no CR lies inside, and a comma,
        // a line break or the end of the text follows it.
        quoted = true;
        let j = i + 1;
        let lines = 0;
        let c = 0;
        while (j < n) {
          c = text.charCodeAt(j);
          if (c === CH_QUOTE || c === CH_CR) break;
          if (c === CH_LF) lines += 1;
          j += 1;
        }
        if (j < n && c === CH_QUOTE) {
          const k = j + 1;
          if (k >= n) {
            fields.push(text.slice(i + 1, j));
            line += lines;
            pos = k;
            ended = END;
            continue;
          }
          const d = text.charCodeAt(k);
          if (d === CH_COMMA) {
            fields.push(text.slice(i + 1, j));
            line += lines;
            pos = k + 1;
            ended = COMMA;
            continue;
          }
          if (d === CH_LF) {
            fields.push(text.slice(i + 1, j));
            line += lines + 1;
            pos = k + 1;
            ended = LINE_BREAK;
            continue;
          }
          if (d === CH_CR && k + 1 < n && text.charCodeAt(k + 1) === CH_LF) {
            fields.push(text.slice(i + 1, j));
            line += lines + 1;
            pos = k + 2;
            ended = LINE_BREAK;
            continue;
          }
        }
        st.pos = pos;
        st.line = line;
        st.recordLine = recordLine;
        st.recordRow = recordRow;
        fields.push(readQuoted());
        pos = st.pos;
        line = st.line;
        ended = st.ended;
        continue;
      }
      // An unquoted field: inline up to a comma, LF or CRLF; a lone CR goes to the general reader.
      quoted = false;
      let c = 0;
      while (i < n) {
        c = text.charCodeAt(i);
        if (c === CH_COMMA || c === CH_LF || c === CH_CR) break;
        i += 1;
      }
      if (i >= n) {
        fields.push(text.slice(pos, n));
        pos = n;
        ended = END;
        continue;
      }
      if (c === CH_COMMA) {
        fields.push(text.slice(pos, i));
        pos = i + 1;
        ended = COMMA;
        continue;
      }
      if (c === CH_LF) {
        fields.push(text.slice(pos, i));
        pos = i + 1;
        line += 1;
        ended = LINE_BREAK;
        continue;
      }
      if (i + 1 < n && text.charCodeAt(i + 1) === CH_LF) {
        fields.push(text.slice(pos, i));
        pos = i + 2;
        line += 1;
        ended = LINE_BREAK;
        continue;
      }
      st.pos = pos;
      st.line = line;
      st.recordLine = recordLine;
      st.recordRow = recordRow;
      fields.push(readUnquoted(''));
      pos = st.pos;
      line = st.line;
      ended = st.ended;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && !quoted && fields[0] === '') continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    const count = fields.length;
    if (count < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: count });
      for (let k = count; k < width; k++) fields.push('');
    } else if (count > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  st.text = '';
  st.errors = null;
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
