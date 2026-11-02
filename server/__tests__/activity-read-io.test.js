const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const { initializeActivityEvents, readActivityEvents } = require('../../db/activity-events');

// macOS getrusage reports zero block writes; libproc exposes the actual byte count.
function diskBytesWritten() {
    return Number(execFileSync('/usr/bin/python3', ['-c', `
import ctypes,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
usage=(ctypes.c_uint64*20)()
if lib.proc_pid_rusage(int(sys.argv[1]),2,ctypes.byref(usage)) != 0:
    raise RuntimeError('proc_pid_rusage failed')
print(usage[19])
`, String(process.pid)], { encoding: 'utf8' }).trim());
}

(process.platform === 'darwin' ? test : test.skip)('reading a small feed page does not spill historical message bodies to disk', () => {
    const db = new Database(':memory:');
    try {
        db.pragma('temp_store = FILE');
        initializeActivityEvents(db);
        const insert = db.prepare('INSERT INTO ag_events(event_type,title,message,metadata,created_at) VALUES(?,?,?,?,?)');
        const message = 'historical text '.repeat(2048);
        db.transaction(() => {
            for (let i = 0; i < 1000; i++) insert.run('notice', `Event ${i}`, message, JSON.stringify({ payload: message }), '2026-11-01 12:00:00');
        })();
        const before = diskBytesWritten();
        const rows = readActivityEvents(db, { limit: 5 });
        const written = diskBytesWritten() - before;
        expect(rows.map(row => row.id)).toEqual([1000, 999, 998, 997, 996]);
        expect(rows[0].message).toBe(message);
        expect(rows[0].metadata.payload).toBe(message);
        expect(written).toBeLessThan(4 * 1024 * 1024);
    } finally { db.close(); }
});
