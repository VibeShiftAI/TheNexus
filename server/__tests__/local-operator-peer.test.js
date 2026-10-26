const { createLocalOperatorPeerVerifier, connectionOwner, processInfo } = require('../services/local-operator-peer');
const socket = { localAddress: '::1', remoteAddress: '::1', localPort: 4000, remotePort: 53210, destroyed: false };
const date = 'Mon Oct 26 16:54:39 2026';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const native = '/Applications/The Nexus.app/Contents/MacOS/nexus-desktop';
let env;
beforeEach(() => {
    env = { ...process.env };
    process.env.NEXUS_LOCAL_OPERATOR_UID = '501';
    process.env.NEXUS_LOCAL_OPERATOR_CHROME = '1';
    process.env.NEXUS_LOCAL_OPERATOR_DESKTOP_CDHASH = 'a'.repeat(40);
});
afterEach(() => { process.env = env; });
function fixture({ kind = 'chrome', flags = '', uid = 501, parent = 1, valid = true, invalidPid, changed = false } = {}) {
    let lookups = 0;
    const run = jest.fn(async (file, args) => {
        if (file.endsWith('lsof')) return { stdout: `p900\nn[::1]:4000->[::1]:53210\np${changed && lookups++ ? 901 : 100}\nn[::1]:53210->[::1]:4000\n` };
        const pid = file.endsWith('ps') ? args[2] : args.at(-1);
        if (file.endsWith('ps')) return { stdout: `${kind === 'chrome' && pid === '100' ? 99 : parent} ${uid} ${date} ${kind === 'chrome' ? chrome : native} ${pid === '100' && kind === 'chrome' ? '--utility-sub-type=network.mojom.NetworkService' : flags}` };
        if (args[0] === '--verify') { if (!valid || pid === invalidPid) throw new Error('untrusted'); return { stdout: '', stderr: '' }; }
        return { stderr: `Executable=${kind === 'chrome' ? (pid === '100' ? '/Applications/Google Chrome.app/Contents/Frameworks/Helper' : chrome) : kind === 'native' ? native : '/usr/local/bin/node'}\nIdentifier=${pid === '100' && kind === 'chrome' ? 'com.google.Chrome.helper' : 'com.google.Chrome'}\nCodeDirectory v=20500 size=765 flags=0x10002(adhoc,runtime) hashes=13+7 location=embedded\n` };
    });
    return { run, verify: createLocalOperatorPeerVerifier({ run, platform: 'darwin', consoleUid: () => 501 }) };
}
test.each(['chrome', 'native'])('kernel peer plus configured running %s code qualifies', async kind => {
    const { run, verify } = fixture({ kind });
    expect(await verify({ socket })).toBe(kind === 'chrome' ? 'mac-chrome' : 'mac-desktop');
    const validations = run.mock.calls.filter(([file, args]) => file.endsWith('codesign') && args[0] === '--verify');
    expect(validations).toHaveLength(kind === 'chrome' ? 2 : 1);
    const strict = kind === 'chrome' ? '--strict=symlinks' : '--strict';
    expect(validations.every(([, args]) => args.includes(strict) && args.includes('--verbose=1') && /^\d+$/.test(args.at(-1)))).toBe(true);
    if (kind === 'chrome') {
        expect(validations.map(([, args]) => args[args.indexOf('-R') + 1])).toEqual([
            '=identifier "com.google.Chrome.helper" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"',
            '=identifier "com.google.Chrome" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"',
        ]);
    }
});
test.each([['helper', '100', 1], ['main', '99', 2]])('invalid Chrome %s code is refused without a weaker fallback', async (_name, invalidPid, count) => {
    const { run, verify } = fixture({ invalidPid });
    expect(await verify({ socket })).toBeNull();
    const validations = run.mock.calls.filter(([file, args]) => file.endsWith('codesign') && args[0] === '--verify');
    expect(validations).toHaveLength(count);
    expect(validations.every(([, args]) => args.includes('--strict=symlinks') && args.includes('--verbose=1') && args.includes('-R'))).toBe(true);
});
test.each(['--headless=new', '-headless -user-data-dir=/tmp/qa -remote-debugging-port=0', '--unknown-switch', '--remote-debugging-port=9222', '--remote-debugging-pipe', '--enable-automation', '--user-data-dir=/tmp/qa', '--profile-directory=QA', '--load-extension=/tmp/e', '--no-sandbox'])('automated/custom browser %s is refused', async flags => {
    expect(await fixture({ flags }).verify({ socket })).toBeNull();
});
test.each([
    ['executor process', { kind: 'node' }], ['invalid running code', { valid: false }],
    ['different user', { uid: 502 }], ['executor-launched browser', { parent: 33 }],
    ['socket changed owner', { changed: true }],
])('%s is refused', async (_name, options) => {
    expect(await fixture(options).verify({ socket, headers: { 'x-operator': 'Robert', 'user-agent': 'Chrome' } })).toBeNull();
});
test('missing pins, a locked-out console user, OS failure and non-macOS fail closed', async () => {
    const { run } = fixture();
    for (const options of [{ platform: 'linux' }, { consoleUid: () => 502 }, { run: async () => { throw new Error('unavailable'); } }]) {
        expect(await createLocalOperatorPeerVerifier({ run, platform: 'darwin', consoleUid: () => 501, ...options })({ socket })).toBeNull();
    }
    delete process.env.NEXUS_LOCAL_OPERATOR_UID;
    expect(await fixture().verify({ socket })).toBeNull();
});
test('full connection tuple, not a PID/header/port alone, determines one peer', () => {
    expect(connectionOwner('p4\nn[::1]:53210->[::1]:4001\n', socket)).toBeNull();
    expect(connectionOwner('p4\nn[::1]:53210->[::1]:4000\np5\nn[::1]:53210->[::1]:4000\n', socket)).toBeNull();
    expect(connectionOwner('p4\nn127.0.0.1:53210->127.0.0.1:4000\n', { ...socket, localAddress: '::ffff:127.0.0.1', remoteAddress: '::ffff:127.0.0.1' })).toBe(4);
    expect(processInfo(`1 501 ${date} ${chrome}`)).toMatchObject({ uid: 501, ppid: 1, started: date, command: chrome });
});
