// Strict UTF-8 decode plus a mojibake scan over the files named on the command line.
// Exit 0 when every file is clean, 1 otherwise. Also counts em dashes (U+2014), which
// Robert's writing rule forbids outside the PRAXIS protocol separator.
const fs = require('fs');
const decoder = new TextDecoder('utf-8', { fatal: true });
const patterns = [
    ['replacement character U+FFFD', /�/g],
    ['C1 control character', /[\u0080-\u009F]/g],
    ['UTF-8 read as Latin-1 (Ã or Â followed by a Latin-1 symbol)', /[ÂÃ][\u0080-¿]/g],
    ['UTF-8 punctuation read as cp1252 (â€)', /â€/g],
    ['byte order mark', /﻿/g],
];
let problems = 0;
for (const file of process.argv.slice(2)) {
    const bytes = fs.readFileSync(file);
    let text;
    try {
        text = decoder.decode(bytes);
    } catch (error) {
        console.log(`${file}: NOT valid UTF-8 (${error.message})`);
        problems++;
        continue;
    }
    const found = patterns.map(([name, re]) => [name, (text.match(re) || []).length]).filter(([, n]) => n > 0);
    const emDashes = (text.match(/—/g) || []).length;
    problems += found.length;
    console.log(`${file}: ${bytes.length} bytes, valid UTF-8, mojibake ${found.length ? JSON.stringify(found) : 'none'}, em dashes ${emDashes}`);
}
console.log(`problems: ${problems}`);
process.exit(problems ? 1 : 0);
