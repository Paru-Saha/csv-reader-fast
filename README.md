# csv-reader-fast

A faster drop-in for make.fun's csv-reader 1.0.0, entered in the
[csv-reader-speed-01](https://make.fun/bounty/csv-reader-speed-01-run-20261121) bounty: `solve.js` exports
`run({text, header})`, which returns the same `{columns, rows, errors}` as csv-reader 1.0.0 for every input, and
`main.ts` answers every case in `/input/cases.json` with it.

- `solve.js` scans character codes and cuts each field out of the text with one slice, reading the common fields
  inline and sending only the rare broken ones (stray CR, doubled quote, CR inside quotes, quote junk, a quote that
  never closes) to general readers.
- `main.ts` runs one cold pass with V8 tuned for it (TurboFan off, single-threaded GC, a fast-growing young
  generation), and reads and writes valid UTF-8 input byte for byte as latin1, which no answer can tell apart.

Run it on a case file:

    MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts

MIT licensed.
