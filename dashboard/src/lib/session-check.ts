/**
 * Session check (/session): redacted summaries of the session this client
 * already holds and of the Nexus operator verdict on it.
 *
 * Why (2026-09-25, task 5fbeff4a): the Windows travel shell has no address
 * bar, so the one Cloudflare endpoint that names a session's kind,
 * /cdn-cgi/access/get-identity, was unreachable from the exact session that
 * Nexus chat kept refusing, and the pre-change server logged only a bare
 * "claim-rejected". The page that uses these helpers is reachable from the
 * menu inside that shell. Everything here reduces a response to fixed kinds,
 * fixed reason and check names, and booleans. The only values passed through
 * are the session's own verified email and its service-token Client ID: the
 * non-secret half of a service token and the exact value
 * NEXUS_OPERATOR_DEVICE_IDS needs. No token, cookie, secret or other claim is
 * kept, shown, logged or sent anywhere. Nothing here confers authority: the
 * verified decision stays in server/services/operator-access.js.
 *
 * 2026-09-26: the shell's real session read `check=audience` although the
 * pinned audience equals the AUD of the one Access application on the host,
 * so the comparison now also reports the form of the `aud` claim (the array
 * Cloudflare documents or the RFC 7519 single string) and the fixed words
 * for the profile claims checked after it (`type`, `sub`, `nbf`).
 */

export type SessionKind = "service-token" | "user" | "none" | "unknown";

export interface AssertionSummary {
    assertionPresent: boolean;
    kind: SessionKind;
    emailPresent: boolean;
    commonNamePresent: boolean;
    /** Service-token Client ID (`<32 hex>.access`), only for a service-token session. */
    clientId: string | null;
    /** True when the token's `exp` has passed; null when it has no usable `exp`. */
    expired: boolean | null;
}

/**
 * The /session/probe answer as the page reads it. `available` is false when
 * the probe gave no session summary at all (unreachable, a non-200 answer or
 * a body that is not a summary); the other fields then describe nothing and
 * the page must say "undetermined", never "no Access session".
 */
export interface ProbeSummary extends AssertionSummary {
    available: boolean;
    /** HTTP status of the probe read, 0 when it could not be made. */
    status: number;
    note: string;
    /** Pin comparisons and profile words from the probe, in the fixed vocabularies below; null when the probe did not send them. */
    emailPin: PinComparison | null;
    audience: PinComparison | null;
    audienceShape: AudienceShape | null;
    issuer: PinComparison | null;
    tokenType: TokenTypeWord | null;
    subject: SubjectWord | null;
    nbf: PresenceWord | null;
}

export interface AccessIdentitySummary {
    /** HTTP status of the get-identity read, 0 when it could not be made. */
    status: number;
    kind: SessionKind;
    /** The session's own verified address, when an identity provider supplied one. */
    email: string | null;
    clientId: string | null;
    note: string;
}

export type OperatorState = "ok" | "refused" | "route-missing" | "cross-site" | "unavailable" | "unreachable" | "unexpected";

export interface OperatorSummary {
    status: number;
    state: OperatorState;
    operator: boolean;
    identity: "user" | "device" | null;
    /** Fixed category from the API (`ok`, `assertion-missing`, `claim-rejected`, ...). */
    reason: string | null;
    /** Fixed check name from the API (`service-identity`, `identity-email`, ...). */
    check: string | null;
    assertionPresent: boolean | null;
    trustedDevices: number | null;
    /** True when issuer, audience and operator email are all pinned. */
    configured: boolean | null;
    note: string;
}

/** The three server-side operator pins, as names only; values are compared, never copied out. */
export interface OperatorPins {
    operatorEmail?: string | null;
    audience?: string | null;
    issuer?: string | null;
}

/**
 * How one claim of an unverified token relates to its pin: `n/a` when the
 * token has no such claim to compare (a service token has no email),
 * `absent` when the claim is missing where the profile requires it,
 * `unpinned` when no pin is set, else `match` or `mismatch`.
 */
export type PinComparison = "match" | "mismatch" | "unpinned" | "absent" | "n/a";

/** How a token carries `aud`: the array Cloudflare documents, the single string RFC 7519 also allows, nothing, or another type. */
export type AudienceShape = "array" | "string" | "absent" | "other";
/** Fixed words for the profile claims the server checks after the audience. */
export type TokenTypeWord = "app" | "other" | "absent";
export type SubjectWord = "empty" | "present" | "absent";
export type PresenceWord = "present" | "absent";

export interface AssertionComparison extends AssertionSummary {
    emailPin: PinComparison;
    /** Match when the pinned audience is in the array or equals the single string, as the server decides. */
    audience: PinComparison;
    audienceShape: AudienceShape;
    issuer: PinComparison;
    tokenType: TokenTypeWord;
    subject: SubjectWord;
    nbf: PresenceWord;
}

const NO_COMPARISON = {
    emailPin: "n/a", audience: "n/a", audienceShape: "absent", issuer: "n/a", tokenType: "absent", subject: "absent", nbf: "absent",
} as const;

// Mirror of DEVICE_ID_PATTERN in server/services/operator-access.js: a value
// that would be dropped there is not shown here either.
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const FIXED_NAME = /^[a-z][a-z-]{0,31}$/;

const ABSENT: AssertionSummary = {
    assertionPresent: false, kind: "none", emailPresent: false, commonNamePresent: false, clientId: null, expired: null,
};

function fixedName(value: unknown): string | null {
    return typeof value === "string" && FIXED_NAME.test(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function clientIdOf(value: unknown): string | null {
    return typeof value === "string" && CLIENT_ID_PATTERN.test(value) ? value : null;
}

function decodeClaims(segment: string): unknown {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

type ClaimsRead =
    | { state: "absent" }
    | { state: "unparseable" }
    | { state: "ok"; claims: Record<string, unknown> };

/** The claim segment of an application token, decoded and never verified. Stays inside this module. */
function readClaims(token: string | null | undefined): ClaimsRead {
    if (typeof token !== "string" || token === "") return { state: "absent" };
    if (token.length > 16_384) return { state: "unparseable" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return { state: "unparseable" };
    try {
        const claims = asRecord(decodeClaims(parts[1]));
        return claims ? { state: "ok", claims } : { state: "unparseable" };
    } catch {
        return { state: "unparseable" };
    }
}

function summarizeClaims(claims: Record<string, unknown>): AssertionSummary {
    const commonNamePresent = claims.common_name !== undefined;
    const emailPresent = typeof claims.email === "string" && claims.email !== "";
    const expired = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 <= Date.now() : null;
    const kind: SessionKind = commonNamePresent ? "service-token" : emailPresent ? "user" : "unknown";
    return {
        assertionPresent: true,
        kind,
        emailPresent,
        commonNamePresent,
        clientId: kind === "service-token" ? clientIdOf(claims.common_name) : null,
        expired,
    };
}

/**
 * The shape of an Access application token without verifying it: which kind
 * of session issued it and whether it has aged out. Diagnostic only.
 */
export function describeAssertion(token: string | null | undefined): AssertionSummary {
    const read = readClaims(token);
    if (read.state === "absent") return ABSENT;
    if (read.state === "unparseable") return { ...ABSENT, assertionPresent: true, kind: "unknown" };
    return summarizeClaims(read.claims);
}

function pinOf(value: string | null | undefined): string | null {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed === "" ? null : trimmed;
}

/**
 * describeAssertion plus fixed words that say which of the server's claim
 * checks an unverified token would fail against the same pins
 * (server/services/operator-access.js compares the exact trimmed issuer, the
 * audience as an array that includes the pin or as the single string equal
 * to it, and a lower-cased email) and the form of the audience claim. The
 * pins and the claims are compared here and never returned.
 */
export function compareAssertion(token: string | null | undefined, pins: OperatorPins): AssertionComparison {
    const read = readClaims(token);
    const summary = describeAssertion(token);
    if (read.state !== "ok") return { ...summary, ...NO_COMPARISON };
    const claims = read.claims;
    const emailPin = pinOf(pins.operatorEmail)?.toLowerCase() ?? null;
    const audiencePin = pinOf(pins.audience);
    const issuerPin = pinOf(pins.issuer);
    const emailClaim = typeof claims.email === "string" && claims.email !== "" ? claims.email.toLowerCase() : null;
    const issuerClaim = typeof claims.iss === "string" && claims.iss !== "" ? claims.iss : null;
    const audienceShape: AudienceShape = Array.isArray(claims.aud) ? "array"
        : typeof claims.aud === "string" ? "string"
            : claims.aud === undefined ? "absent" : "other";
    let audience: PinComparison;
    if (audienceShape === "absent") audience = "absent";
    else if (audiencePin === null) audience = "unpinned";
    else if (audienceShape === "array") audience = (claims.aud as unknown[]).includes(audiencePin) ? "match" : "mismatch";
    else audience = claims.aud === audiencePin ? "match" : "mismatch";
    return {
        ...summary,
        emailPin: emailClaim === null ? "n/a" : emailPin === null ? "unpinned" : emailClaim === emailPin ? "match" : "mismatch",
        audience,
        audienceShape,
        issuer: issuerClaim === null ? "absent" : issuerPin === null ? "unpinned" : issuerClaim === issuerPin ? "match" : "mismatch",
        tokenType: claims.type === "app" ? "app" : claims.type === undefined ? "absent" : "other",
        subject: typeof claims.sub === "string" ? (claims.sub === "" ? "empty" : "present") : "absent",
        nbf: claims.nbf === undefined ? "absent" : "present",
    };
}

function oneOf<T extends string>(value: unknown, words: readonly T[]): T | null {
    return typeof value === "string" && (words as readonly string[]).includes(value) ? (value as T) : null;
}

const PIN_WORDS = ["match", "mismatch", "unpinned", "absent", "n/a"] as const;

/** Fixed sentence for the Session page's audience row: the form of the claim and its relation to the pin. */
export function describeAudience(shape: AudienceShape | null, audience: PinComparison | null): string {
    if (shape === null) return "not reported by the probe";
    if (shape === "absent") return "absent from the token";
    if (shape === "other") return "of an unexpected type";
    const form = shape === "array" ? "array form (as Cloudflare documents)" : "single-string form (RFC 7519)";
    const relation = audience === "match" ? "equals the pinned audience"
        : audience === "mismatch" ? "is not the pinned audience"
            : audience === "unpinned" ? "no audience is pinned in the dashboard process" : "not compared";
    return `${form}; ${relation}`;
}

const NO_PROBE_COMPARISON = { emailPin: null, audience: null, audienceShape: null, issuer: null, tokenType: null, subject: null, nbf: null };

/** Whitelisted read of the /session/probe answer (an AssertionComparison from the server, fixed words only). */
export function summarizeProbe(status: number, body: unknown): ProbeSummary {
    const record = status === 200 ? asRecord(body) : null;
    if (!record || typeof record.assertionPresent !== "boolean") {
        return {
            ...ABSENT,
            ...NO_PROBE_COMPARISON,
            kind: "unknown",
            available: false,
            status,
            note: status === 0
                ? "The dashboard probe could not be reached, so this page cannot tell whether an Access session is present."
                : `The dashboard probe answered ${status} without a session summary, so this page cannot tell whether an Access session is present.`,
        };
    }
    const kind: SessionKind = record.kind === "service-token" || record.kind === "user" || record.kind === "unknown" ? record.kind : "none";
    return {
        assertionPresent: record.assertionPresent,
        kind,
        emailPresent: record.emailPresent === true,
        commonNamePresent: record.commonNamePresent === true,
        clientId: kind === "service-token" ? clientIdOf(record.clientId) : null,
        expired: typeof record.expired === "boolean" ? record.expired : null,
        available: true,
        status,
        note: "",
        emailPin: oneOf(record.emailPin, PIN_WORDS),
        audience: oneOf(record.audience, PIN_WORDS),
        audienceShape: oneOf(record.audienceShape, ["array", "string", "absent", "other"] as const),
        issuer: oneOf(record.issuer, PIN_WORDS),
        tokenType: oneOf(record.tokenType, ["app", "other", "absent"] as const),
        subject: oneOf(record.subject, ["empty", "present", "absent"] as const),
        nbf: oneOf(record.nbf, ["present", "absent"] as const),
    };
}

/**
 * Cloudflare's own answer for the caller's session, served at the Access
 * edge and never by this server. A person's session carries an email; the
 * travel shell's service-token session carries a Client ID and no email.
 */
export function summarizeAccessIdentity(status: number, body: unknown): AccessIdentitySummary {
    const base = { status, kind: "none" as SessionKind, email: null, clientId: null };
    if (status === 0) return { ...base, note: "The Cloudflare edge could not be reached from this origin." };
    const record = asRecord(body);
    if (!record) {
        return {
            ...base,
            note: status === 404
                ? "No Cloudflare Access in front of this origin: the Mac app loads localhost:3000 directly."
                : `The edge answered ${status} without a JSON identity.`,
        };
    }
    if (typeof record.err === "string") {
        return {
            ...base,
            note: record.err === "no app token set"
                ? "This origin holds no Access session cookie: a browser or app that has not signed in here."
                : "The Access edge reported an error for this session.",
        };
    }
    const email = typeof record.email === "string" && record.email !== "" ? record.email : null;
    const clientId = clientIdOf(record.common_name);
    const serviceToken = clientId !== null || record.service_token_status === true || typeof record.service_token_id === "string";
    if (serviceToken) {
        return { ...base, kind: "service-token", clientId, note: "A service-token session: the travel shell's startup exchange, not a person's login." };
    }
    if (email) return { ...base, kind: "user", email, note: "A person's session, verified by the identity provider (one-time PIN)." };
    return { ...base, kind: "unknown", note: "An Access session of a shape this page does not recognize." };
}

/** Whitelisted read of GET /api/ai/chat/operator-identity, the verified Nexus verdict. */
export function summarizeOperatorIdentity(status: number, body: unknown): OperatorSummary {
    const base: OperatorSummary = {
        status, state: "unexpected", operator: false, identity: null, reason: null, check: null,
        assertionPresent: null, trustedDevices: null, configured: null, note: "",
    };
    if (status === 0) return { ...base, state: "unreachable", note: "The Nexus API did not answer." };
    if (status === 404) {
        return {
            ...base,
            state: "route-missing",
            note: "The Nexus API is still running code from before this check existed. After the Nexus child is reloaded once, the verdict appears here.",
        };
    }
    if (status === 403) return { ...base, state: "cross-site", note: "The check answers same-origin requests only." };
    if (status === 503) return { ...base, state: "unavailable", note: "The operator identity check is temporarily unavailable." };
    const record = asRecord(body);
    if (status !== 200 || !record) return { ...base, note: `The Nexus API answered ${status} without a verdict.` };
    const configured = asRecord(record.configured);
    const identity = record.identity === "user" || record.identity === "device" ? record.identity : null;
    const operator = record.operator === true;
    return {
        ...base,
        state: operator ? "ok" : "refused",
        operator,
        identity,
        reason: fixedName(record.reason),
        check: fixedName(record.check),
        assertionPresent: typeof record.assertionPresent === "boolean" ? record.assertionPresent : null,
        trustedDevices: configured && typeof configured.trustedDevices === "number" ? configured.trustedDevices : null,
        configured: configured ? configured.issuer === true && configured.audience === true && configured.operatorEmail === true : null,
        note: operator
            ? `Nexus recognizes this session as the operator (identity ${identity ?? "unknown"}).`
            : "Nexus withheld operator identity from this session.",
    };
}

/** The one thing to do next, from the three reads together. Fixed text plus the session's own Client ID or address. */
export function nextStep(probe: ProbeSummary, access: AccessIdentitySummary, operator: OperatorSummary): string {
    if (operator.state === "ok") {
        return "Nothing to do: chat turns from this session carry operator identity. If Praxis still declines a guarded action, that comes from a later gate, not from sign-in.";
    }
    const kind = probe.available && (probe.kind === "service-token" || probe.kind === "user") ? probe.kind : access.kind;
    const undetermined = !probe.available && access.kind === "none";
    const id = (probe.available ? probe.clientId : null) ?? access.clientId;
    const pinIt = id
        ? `Add ${id} to NEXUS_OPERATOR_DEVICE_IDS in TheNexus/.env on the Mac`
        : "Pin this session's Client ID (the client_id field of the laptop's access-token.json, or the Zero Trust service-token list) in NEXUS_OPERATOR_DEVICE_IDS in TheNexus/.env on the Mac";
    if (operator.state === "refused") {
        if (operator.reason === "assertion-missing") {
            return "No Access session reaches Nexus from this origin. On the Mac app (localhost) that is expected; use the travel shell, the phone app, or a browser through the tunnel.";
        }
        if (operator.reason === "config-missing") {
            return "Nexus is missing one of its operator pins (issuer, audience or operator email). Set them on the Mac and reload the Nexus child once.";
        }
        if (operator.reason === "key-fetch-failed") return "Nexus could not fetch the Access signing keys. Retry in 30 seconds.";
        if (operator.check === "service-identity") {
            const pinned = (operator.trustedDevices ?? 0) > 0 ? "a different Client ID is pinned than this session's" : "its Client ID is not pinned";
            return `Refused at check service-identity: this is a service-token session and ${pinned}. ${pinIt}, then reload the Nexus child once and open this page again.`;
        }
        if (operator.check === "identity-email") {
            const shown = access.email ? ` (${access.email})` : "";
            return `Refused at check identity-email: NEXUS_OPERATOR_EMAIL on the Mac is not this session's verified address${shown}. Correct that pin, then reload the Nexus child once and open this page again.`;
        }
        if (operator.check === "executor-headers") {
            return "Refused at check executor-headers: the request carried machine credentials beside the session, which a person's chat turn never does.";
        }
        if (operator.check === "audience" && probe.available) {
            if (probe.audienceShape === "string" && probe.audience === "match") {
                return "Refused at check audience: this session's token carries the pinned audience as a single string (a form RFC 7519 allows) and the running Nexus child accepts only the array form. No pin needs changing: reload the Nexus child once so the corrected module runs, then open this page again.";
            }
            if (probe.audienceShape === "array" && probe.audience === "mismatch") {
                return "Refused at check audience: this token was issued for an Access application whose audience tag is not NEXUS_OPERATOR_ACCESS_AUD. In Zero Trust open the application that protects this host, copy its Application Audience (AUD) tag into NEXUS_OPERATOR_ACCESS_AUD on the Mac, then reload the Nexus child once.";
            }
        }
        return operator.check
            ? `Refused at check ${operator.check}: the session token failed a profile check; sign-in itself is not the cause.`
            : "Refused for a reason this page does not recognize.";
    }
    if (operator.state === "route-missing") {
        if (kind === "service-token") return `This is the travel shell's service-token session. ${pinIt}, reload the Nexus child once, then open this page again for the verdict.`;
        if (kind === "user") {
            return "This is a person's Access session. If NEXUS_OPERATOR_EMAIL on the Mac equals the address shown, a single reload of the Nexus child is all that remains; open this page again afterwards for the verdict.";
        }
        if (undetermined) return `${probe.note} Use "Check again" in a moment; nothing about this session has been decided.`;
        if (kind === "none") return "No Access session on this origin. On the Mac app (localhost) that is expected.";
        return "Reload the Nexus child once, then open this page again for the verdict.";
    }
    if (undetermined && operator.state !== "unreachable") return `${probe.note} ${operator.note}`.trim();
    return operator.note;
}
