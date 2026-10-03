import type { ClientArtifact, ClientEntitlement, ClientMemberIdentity, ClientReview } from '@praxis/contract';
import { API_URL, authFetch } from './shared';

// ═══════════════════════════════════════════════════════════════
// CLIENT PROJECT ACCESS: the cockpit's read-only view of a project's
// client entitlements, published artifact versions and client reviews
// (server/routes/client-access.js, docs/contracts/client-project-access.md).
// Entity shapes come from @praxis/contract (entities/client-access.ts,
// revision 1.1); this module only adds the ledger-side fields the cockpit
// summary carries and the client surface never returns. The dashboard
// installs the contract as a real copy, so after a contract change run
// `npm run build` in nexus-shared, then `rm -rf node_modules/@praxis &&
// npm install` here (dashboard/.npmrc explains why a plain install does not
// refresh it). Grants and revocations need Robert's operator credential or
// the local grant script; this module never sends one.
// ═══════════════════════════════════════════════════════════════

export type { ClientArtifact, ClientEntitlement, ClientMemberIdentity, ClientReview } from '@praxis/contract';

/** A review as the cockpit summary shows it: the shared shape plus ledger-only attribution. */
export type ClientReviewRow = ClientReview & {
    member_id?: string;
    project_id?: string;
    authority?: string;
    session_sha256?: string;
    session_expires_at?: string;
};

/** A published version with its reviews in the cockpit (ledger) view. */
export type ClientArtifactRow = Omit<ClientArtifact, 'reviews' | 'accepted'> & {
    reviews: ClientReviewRow[];
    accepted: ClientReviewRow[];
};

/** An entitlement with the member as it is now and this row's live access resolution. */
export type ClientEntitlementRow = ClientEntitlement & {
    /** The member as it is now (null once deleted). */
    member: (ClientMemberIdentity & { status: string }) | null;
    /** Live resolution for this row: granted, superseded, revoked, or the denial reason. */
    access: string;
};

export interface ClientAccessSummary {
    project_id: string;
    scope: string;
    entitlements: ClientEntitlementRow[];
    artifacts: ClientArtifactRow[];
    reviews: ClientReviewRow[];
}

/** GET /api/projects/:id/client-access (cockpit read). */
export async function getProjectClientAccess(projectId: string): Promise<ClientAccessSummary> {
    const res = await authFetch(`${API_URL}/${encodeURIComponent(projectId)}/client-access`);
    if (!res.ok) throw new Error(`Client access API unavailable (${res.status})`);
    return res.json();
}
