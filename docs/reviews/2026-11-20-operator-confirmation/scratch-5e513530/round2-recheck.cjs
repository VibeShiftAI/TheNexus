// Read-only recheck for the QA round 2 repair of task 5e513530 (run from the task worktree).
// Prints: the tree state, Robert's stored answers, the source binding of every current
// live report, and the exact evidence lines the report cites. Writes nothing.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const at = (file, from, to = from) => fs.readFileSync(file, 'utf8').split('\n').slice(from - 1, to)
    .map((line, i) => `    ${file.split('/').pop()}:${from + i}: ${line.trim()}`).join('\n');

console.log(`Recheck run at ${new Date().toISOString()}`);
console.log(`HEAD: ${git(['rev-parse', 'HEAD'])}`);
console.log(`Last commit: ${git(['log', '-1', '--format=%h %cI %s'])}`);
console.log(`git status entries: ${git(['status', '--porcelain']).split('\n').filter(Boolean).length}`);

console.log('\nA. Robert\'s answers for this task as stored (hitl.db, opened read-only)');
const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', 'file:/Volumes/Projects/Praxis/data/hitl.db?mode=ro',
    "select id, status, requested_at, resolved_at, json_extract(request_json,'$.resolution') as resolution from hitl_requests where id like 'task-question-5e513530-%' order by requested_at"],
    { encoding: 'utf8' }) || '[]');
for (const row of rows) console.log(`  ${row.id}: requested ${row.requested_at}, ${row.status} ${row.resolved_at}, resolution ${row.resolution}`);

console.log('\nB. Source binding of each current live report (HEAD and sha256 of every file under test)');
const dir = 'docs/reviews/2026-11-20-operator-confirmation';
const head = git(['rev-parse', 'HEAD']);
for (const name of ['live-chrome-unattended.json', 'live-webview-unattended.json', 'live-chrome-attended.json',
    'live-webview-attended.json', 'live-chrome-attended-2.json']) {
    const report = JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8'));
    const files = Object.entries(report.source.sha256);
    const same = files.filter(([file, hash]) => sha(file) === hash).length;
    console.log(`  ${name}: generated_at ${report.generated_at}; head ${report.source.head === head ? 'same as HEAD now' : report.source.head}; `
        + `files under test ${files.length}, current bytes match ${same}/${files.length}; answers_dialogs ${report.harness.answers_dialogs}; `
        + `checks ${report.summary.checks}, passed ${report.summary.passed}`);
}

console.log('\nC. Evidence lines the report cites for criterion 5');
console.log(at(`${dir}/live-webview-unattended.json`, 1413, 1414));
console.log(at(`${dir}/live-webview-unattended.json`, 1620, 1627));
console.log(at(`${dir}/live-webview-attended.json`, 1293, 1294));
console.log(at(`${dir}/live-webview-attended.json`, 1633, 1634));
console.log(at(`${dir}/live-webview-attended.json`, 1806, 1807));
console.log(at(`${dir}/live-webview-attended.json`, 2060));
console.log(at(`${dir}/live-chrome-attended-2.json`, 37));
console.log(at(`${dir}/live-chrome-attended-2.json`, 4261));
console.log(at(`${dir}/live-chrome-attended-2.json`, 4579));
console.log(at('scripts/operator-confirmation-qa/live-check.cjs', 214, 217));
console.log(at('server/services/operator-confirmation.js', 56));
console.log(at('server/services/operator-confirmation.js', 160));
console.log(at('server/services/operator-confirmation.js', 178, 179));
