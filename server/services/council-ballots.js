/**
 * Per-seat Morning Council ballots for one task: who voted what, on which
 * cue, and whether the seats actually disagreed.
 *
 * Source: Praxis's council-session store (data/council-sessions/<id>.json,
 * written by CouncilSessionTracker). A Morning Council session carries one
 * thesis per seat; `thesis.parsed` is Praxis's deterministic re-render of the
 * VALIDATED ballot (Praxis src/morning/morning-council.ts
 * renderValidatedBallot), one row per vote:
 *
 *   VOTE|<task id>|<include or hold>|<rank>|<minutes>|<complexity>|<reason>
 *
 * The reason is the seat's own stated cue for its decision, which is the
 * load-bearing cue this surface exists to expose.
 *
 * The seat roster is the session's registered `voices` (CouncilSessionTracker
 * convene registers every reference seat plus the aggregator before any
 * ballot lands, and each thesis is written the moment its seat reports), so
 * a seat whose ballot has not landed is still a seat. The aggregator voice
 * (`<model> (aggregator)`, session-tracker.ts aggregatorVoiceName) does not
 * vote and is excluded from the roster.
 *
 * Honesty rules:
 *   - Agreement is never reported as endorsement. Seats that all voted the
 *     same way read "no dissent recorded", never "consensus".
 *   - A seat that errored, or that returned no row for this task, is not a
 *     silent yes. It is counted as giving no position, and a session with
 *     such seats can only say "no dissent among the seats that voted".
 *   - A registered seat with no thesis yet (still pending or running) is
 *     `pending`: evidence not yet recorded, never a yes and never dropped
 *     from the count. A session with pending seats cannot read "no dissent
 *     (all seats)".
 *   - Fewer than two recorded positions cannot show dissent or its absence.
 *   - An unreadable store is "unavailable", never an empty list.
 *
 * Scope: only sessions in which at least one seat's validated ballot has a
 * row for the task. A row Praxis rejected as malformed never reaches
 * `parsed`, so a session whose only mention of the task was rejected does
 * not appear; the seat-level note on rejected rows flags that possibility.
 * The session file does not store the candidate pool, so an in-flight
 * session with no ballot landed yet cannot be attributed to a task at all;
 * it appears once the first ballot naming the task lands.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_COUNCIL_SESSIONS_DIR = process.env.PRAXIS_COUNCIL_SESSIONS_DIR
    || '/Volumes/Projects/Praxis/data/council-sessions';

/** Sessions returned per task, newest first. A display cap: totals cover all. */
const COUNCIL_SESSION_PAGE = 10;
const MAX_TEXT_CHARS = 400;
const DECISIONS = new Set(['include', 'hold']);
const REJECTED_ROWS = /\((\d+) malformed row\(s\) were rejected\)/;
const NON_SUBSTANTIVE = '(non-substantive ballot: no valid rows)';
/** Praxis names the aggregator seat `<model> (aggregator)`; it does not vote. */
const AGGREGATOR_VOICE = / \(aggregator\)$/;
/** Voice statuses that mean the seat has not finished: its ballot may still land. */
const IN_FLIGHT_VOICE = new Set(['pending', 'running']);

function isAggregatorVoice(name) {
    return AGGREGATOR_VOICE.test(String(name ?? ''));
}

function bounded(text, max = MAX_TEXT_CHARS) {
    const s = String(text ?? '').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function intOrNull(raw) {
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
}

/**
 * This task's row(s) in one seat's validated ballot text.
 * Returns { vote, malformed, conflicting, rejectedRows, nonSubstantive }.
 */
function parseSeatBallot(parsedText, taskId) {
    const text = typeof parsedText === 'string' ? parsedText : '';
    const prefix = `VOTE|${taskId}|`;
    const variants = new Map();
    let malformed = 0;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith(prefix)) continue;
        const fields = line.split('|');
        const decision = String(fields[2] ?? '').trim().toLowerCase();
        if (fields.length < 7 || !DECISIONS.has(decision)) {
            malformed += 1;
            continue;
        }
        variants.set(line, {
            decision,
            rank: intOrNull(fields[3]),
            estimatedMinutes: intOrNull(fields[4]),
            complexity: intOrNull(fields[5]),
            // The reason is the last field; rejoin in case it held a '|'.
            cue: bounded(fields.slice(6).join('|')),
        });
    }
    const rejected = text.match(REJECTED_ROWS);
    return {
        vote: variants.size === 1 ? [...variants.values()][0] : null,
        conflicting: variants.size > 1,
        malformed,
        rejectedRows: rejected ? Number(rejected[1]) : 0,
        nonSubstantive: text.includes(NON_SUBSTANTIVE),
    };
}

/** One seat's reported position on the task, with why it has none if so. */
function seatPosition(thesis, taskId) {
    const voice = typeof thesis?.voice === 'string' ? thesis.voice : 'unknown seat';
    const base = {
        seat: voice,
        model: typeof thesis?.model === 'string' ? thesis.model : null,
        recordedAt: Number.isFinite(thesis?.recordedAt) ? new Date(thesis.recordedAt).toISOString() : null,
    };
    if (thesis?.status !== 'success') {
        return {
            ...base,
            state: 'unavailable',
            detail: `Seat ${thesis?.status || 'did not report'}${thesis?.error ? `: ${bounded(thesis.error, 200)}` : ''}`,
        };
    }
    const ballot = parseSeatBallot(thesis.parsed, taskId);
    if (ballot.vote) return { ...base, state: 'voted', ...ballot.vote };
    let detail;
    if (ballot.conflicting) detail = 'Ballot holds conflicting rows for this task; neither is counted.';
    else if (ballot.malformed > 0) detail = 'Ballot row for this task could not be parsed.';
    else if (ballot.nonSubstantive) detail = 'Ballot had no valid rows at all.';
    else if (ballot.rejectedRows > 0) {
        detail = `No valid row for this task; Praxis rejected ${ballot.rejectedRows} malformed row(s) from this ballot, and this task's row may be among them.`;
    } else detail = 'Ballot has no row for this task.';
    return { ...base, state: 'no_position', detail };
}

/**
 * A registered voting seat with no thesis in the file. While the voice is
 * pending or running the ballot may still land (`pending`); any other
 * status means the seat finished without a recorded ballot (`unavailable`).
 */
function rosterSeatWithoutThesis(voice) {
    const status = typeof voice?.status === 'string' ? voice.status : 'unknown';
    const base = {
        seat: typeof voice?.name === 'string' ? voice.name : 'unknown seat',
        model: typeof voice?.model === 'string' ? voice.model : null,
        recordedAt: null,
    };
    if (IN_FLIGHT_VOICE.has(status)) {
        return { ...base, state: 'pending', detail: `Seat is ${status}; its ballot has not been recorded yet.` };
    }
    return { ...base, state: 'unavailable', detail: `Seat ${status} with no ballot recorded.` };
}

/** `source.roster` values: where the seat list came from. */
const ROSTER_VOICES = 'voices[]';
const ROSTER_THESES_FALLBACK = 'theses[] (file has no voices roster)';

/**
 * Seats for one session: every registered voting voice, in roster order,
 * paired with its thesis when one landed; then any thesis whose voice is
 * not on the roster. A file with no roster falls back to its theses, and
 * `roster` names which of the two the seats were read from.
 */
function rosterSeats(session, taskId) {
    const theses = Array.isArray(session?.theses) ? session.theses : [];
    const voices = (Array.isArray(session?.voices) ? session.voices : []).filter((v) => !isAggregatorVoice(v?.name));
    const thesisByVoice = new Map(theses.filter((t) => typeof t?.voice === 'string').map((t) => [t.voice, t]));
    const seats = voices.map((v) => {
        const thesis = typeof v?.name === 'string' ? thesisByVoice.get(v.name) : undefined;
        return thesis ? seatPosition(thesis, taskId) : rosterSeatWithoutThesis(v);
    });
    const onRoster = new Set(voices.map((v) => v?.name).filter((n) => typeof n === 'string'));
    for (const t of theses) {
        if (!onRoster.has(t?.voice) && !isAggregatorVoice(t?.voice)) seats.push(seatPosition(t, taskId));
    }
    return { seats, roster: voices.length > 0 ? ROSTER_VOICES : ROSTER_THESES_FALLBACK };
}

/**
 * Session-level divergence from the recorded positions only.
 *   dissent                    ≥2 distinct decisions among voting seats
 *   no_dissent                 every registered seat voted, ≥2 of them, all alike
 *   no_dissent_among_reporting ≥2 voted alike, but some seats gave no
 *                              position or have not reported yet
 *   insufficient               fewer than two positions: nothing to compare
 */
function classifyDivergence(seats) {
    const voted = seats.filter((s) => s.state === 'voted');
    const missing = seats.length - voted.length;
    const decisions = new Set(voted.map((s) => s.decision));
    if (decisions.size >= 2) return 'dissent';
    if (voted.length < 2) return 'insufficient';
    return missing === 0 ? 'no_dissent' : 'no_dissent_among_reporting';
}

function positionsOf(seats) {
    const groups = new Map();
    for (const s of seats) {
        if (s.state !== 'voted') continue;
        if (!groups.has(s.decision)) groups.set(s.decision, []);
        groups.get(s.decision).push(s.seat);
    }
    return [...groups.entries()]
        .map(([decision, members]) => ({ decision, seats: members }))
        .sort((a, b) => b.seats.length - a.seats.length || a.decision.localeCompare(b.decision));
}

/** Build the task-level record from one parsed session JSON, or null if it has no row for the task. */
function sessionForTask(session, taskId, file) {
    const theses = Array.isArray(session?.theses) ? session.theses : [];
    const prefix = `VOTE|${taskId}|`;
    if (!theses.some((t) => typeof t?.parsed === 'string' && t.parsed.includes(prefix))) return null;
    const { seats, roster } = rosterSeats(session, taskId);
    const count = (state) => seats.filter((s) => s.state === state).length;
    const voted = count('voted');
    const unavailable = count('unavailable');
    const pending = count('pending');
    return {
        sessionId: typeof session.sessionId === 'string' ? session.sessionId : path.basename(file, '.json'),
        topic: typeof session.topic === 'string' ? bounded(session.topic, 160) : null,
        createdAt: Number.isFinite(session.createdAt) ? new Date(session.createdAt).toISOString() : null,
        // Praxis's session phase: anything but "complete" is still in flight.
        phase: typeof session.phase === 'string' ? session.phase : null,
        morningRunId: typeof session.metadata?.morningRunId === 'string' ? session.metadata.morningRunId : null,
        source: { store: 'praxis:data/council-sessions', file: path.basename(file), field: 'theses[].parsed', roster },
        divergence: classifyDivergence(seats),
        coverage: { seats: seats.length, voted, unavailable, pending, noPosition: seats.length - voted - unavailable - pending },
        positions: positionsOf(seats),
        seats,
    };
}

/**
 * Reader over the session store with a per-file cache keyed on mtime+size,
 * so the console's poll does not re-parse ~200 JSON files each time. Only
 * Morning Council sessions keep a cached body; everything else caches as
 * "not a ballot session".
 */
function createCouncilBallotReader({ sessionsDir = DEFAULT_COUNCIL_SESSIONS_DIR, page = COUNCIL_SESSION_PAGE } = {}) {
    const cache = new Map();

    function loadSession(file) {
        const stat = fs.statSync(file);
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.session;
        let session = null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (parsed?.metadata?.kind === 'morning-council') {
            session = {
                sessionId: parsed.sessionId,
                topic: parsed.topic,
                phase: parsed.phase,
                createdAt: parsed.createdAt,
                metadata: { morningRunId: parsed.metadata.morningRunId },
                // The registered roster, kept so seats without a thesis stay counted.
                voices: (Array.isArray(parsed.voices) ? parsed.voices : []).map((v) => ({
                    name: v?.name, model: v?.model, status: v?.status,
                })),
                theses: (Array.isArray(parsed.theses) ? parsed.theses : []).map((t) => ({
                    voice: t?.voice, model: t?.model, status: t?.status, error: t?.error,
                    parsed: t?.parsed, recordedAt: t?.recordedAt,
                })),
            };
        }
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, session });
        return session;
    }

    return function councilForTask(taskId) {
        let names;
        try {
            names = fs.readdirSync(sessionsDir).filter((n) => n.endsWith('.json'));
        } catch (err) {
            return {
                available: false,
                reason: `Council session store unreadable (${err.code || err.message}); dissent is unknown, not absent.`,
                sessionsDir,
                sessionsScanned: 0,
                unreadableSessions: 0,
                totals: null,
                totalSessions: 0,
                sessions: [],
            };
        }
        const seen = new Set(names.map((n) => path.join(sessionsDir, n)));
        for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);

        let unreadable = 0;
        const matched = [];
        for (const name of names) {
            const file = path.join(sessionsDir, name);
            let session;
            try {
                session = loadSession(file);
            } catch {
                unreadable += 1;
                continue;
            }
            const record = session ? sessionForTask(session, taskId, file) : null;
            if (record) matched.push(record);
        }
        matched.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const totals = { dissent: 0, no_dissent: 0, no_dissent_among_reporting: 0, insufficient: 0 };
        for (const s of matched) totals[s.divergence] += 1;
        return {
            available: true,
            reason: unreadable > 0
                ? `${unreadable} session file(s) could not be read; their ballots are missing from this view.`
                : null,
            sessionsDir,
            sessionsScanned: names.length,
            unreadableSessions: unreadable,
            totals,
            totalSessions: matched.length,
            sessions: matched.slice(0, page),
        };
    };
}

module.exports = {
    createCouncilBallotReader,
    parseSeatBallot,
    seatPosition,
    rosterSeats,
    isAggregatorVoice,
    classifyDivergence,
    sessionForTask,
    DEFAULT_COUNCIL_SESSIONS_DIR,
    COUNCIL_SESSION_PAGE,
};
