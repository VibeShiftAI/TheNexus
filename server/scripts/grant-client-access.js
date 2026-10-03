#!/usr/bin/env node
/**
 * Grant, revoke or show a client's project-scoped entitlement from the Nexus
 * host (db/client-access.js, docs/contracts/client-project-access.md).
 *
 * Robert's operator credential (NEXUS_OPERATOR_APPROVAL_KEY) is not
 * provisioned on the live server (2026-10-02), so the API grant endpoint fails
 * closed with 503 there. This script is the local equivalent: it runs on the
 * host with filesystem access to nexus.db (already operator-level access),
 * writes the same immutable ledger rows with `authority: operator_local`, and
 * records the authorization source. It never creates members, links, projects
 * or credentials: the member must already be linked to the project, and it
 * grants nothing beyond that one project.
 *
 * Usage (from the repo root; honors NEXUS_DB_PATH):
 *   node server/scripts/grant-client-access.js --project <id> --member <id> --source <path-or-ref> [--note "..."]
 *   node server/scripts/grant-client-access.js --project <id> --member <id> --revoke --reason "..."
 *   node server/scripts/grant-client-access.js --project <id> --show
 *
 * Output is JSON on stdout (ledger rows only, never secrets). Exit 0 on
 * success (including an idempotent duplicate), 2 on usage errors, 1 on refusal.
 */
const args = process.argv.slice(2);
function option(name) {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = args[index + 1];
    return value === undefined || value.startsWith('--') ? '' : value;
}
const flag = name => args.includes(`--${name}`);

const projectId = option('project');
const memberId = option('member');
if (!projectId) {
    console.error('usage: --project <id> (--show | --member <id> --source <ref> [--note "..."] | --member <id> --revoke --reason "...")');
    process.exit(2);
}

const db = require('../../db');
if (!db.clientAccess) {
    console.error('Client access ledger unavailable: the database did not open');
    process.exit(1);
}
const BY = `operator_local:${require('os').userInfo().username}`;
const AUTHORITY = 'operator_local';

try {
    if (flag('show')) {
        process.stdout.write(`${JSON.stringify(db.clientAccess.listForProject(projectId), null, 2)}\n`);
        process.exit(0);
    }
    if (!memberId) {
        console.error('--member <id> is required unless --show is given');
        process.exit(2);
    }
    if (flag('revoke')) {
        const reason = option('reason');
        if (!reason) {
            console.error('--reason "..." is required with --revoke');
            process.exit(2);
        }
        const active = db.clientAccess.listForProject(projectId).entitlements.find(e => e.member_id === memberId && e.state === 'active');
        if (!active) {
            console.error('No active entitlement for that member on that project');
            process.exit(1);
        }
        process.stdout.write(`${JSON.stringify(db.clientAccess.revoke(projectId, active.id, { reason }, { by: BY, authority: AUTHORITY }), null, 2)}\n`);
        process.exit(0);
    }
    const source = option('source');
    if (!source) {
        console.error('--source <path-or-ref> naming the recorded authorization is required for a grant');
        process.exit(2);
    }
    const result = db.clientAccess.grant(projectId, { member_id: memberId, source, note: option('note') || undefined }, { by: BY, authority: AUTHORITY });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
} catch (error) {
    console.error(`Refused: ${error.message}`);
    process.exit(1);
}
