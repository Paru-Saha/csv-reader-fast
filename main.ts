// A faster drop-in for csv-reader 1.0.0, run as the harness runs every entry: `node /bot/main.ts` (node22). It reads
// every case from /input/cases.json (a JSON array of {id, input}), answers each one alone with run() from solve.js,
// and writes /output/answers.json: a JSON array of the answers, one per case and in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Two things make it cheaper than the house driver, neither of which changes an answer:
//
// - V8's flags. The whole run is one cold pass over about 11 MB, so the optimizing compiler's work costs more than it
//   saves: TurboFan is off (Maglev still compiles the hot loops), the garbage collector runs on the main thread
//   alone, as the house driver turns incremental marking off, and the young generation grows fast.
// - The bytes as they stand. Every character the reader acts on (comma, quote, CR, LF) is ASCII, and in UTF-8 no byte
//   of a multi-byte character is ever ASCII. So when the input is valid UTF-8 and carries no \u escape, it is read as
//   latin1 (one string character per byte): run() reads every record, field and line exactly as it would on the
//   decoded text, its fields are the same bytes, and JSON.stringify writes them back untouched, so writing the
//   answers as latin1 puts out exactly the UTF-8 the decoded path would. The one difference is the byte order mark,
//   three characters in latin1 where run() looks for one, so the driver drops it before calling run(), as run() would.
//   Any other input takes the plain path: decoded as UTF-8 and written as UTF-8.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { setFlagsFromString } from 'node:v8';

// Set before solve.js is imported, so all of its work runs under them.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbofan');
setFlagsFromString('--single-threaded-gc');
// Nearly every string and array the reader makes lives to the end (they are the answer), so the young generation is
// let grow fast: fewer scavenges, each copying what survives, before the heap settles at its size.
setFlagsFromString('--semi-space-growth-factor=8');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; input: { text: unknown; header: unknown } };

/** The UTF-8 byte order mark, as latin1 reads it. */
const BOM_LATIN1 = 'ï»¿';

const bytes = readFileSync(join(INPUT_DIR, 'cases.json'));
const asBytes = bytes.indexOf('\\u') === -1 && isUtf8(bytes);

const cases = JSON.parse(bytes.toString(asBytes ? 'latin1' : 'utf8')) as Case[];
const answers: unknown[] = [];
for (const c of cases) {
  let input: unknown = c.input;
  if (asBytes && typeof c.input.text === 'string' && c.input.text.startsWith(BOM_LATIN1)) {
    input = { text: c.input.text.slice(3), header: c.input.header };
  }
  answers.push(run(input));
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers), asBytes ? 'latin1' : 'utf8');
