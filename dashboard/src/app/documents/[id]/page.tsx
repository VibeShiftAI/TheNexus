"use client";

/**
 * Document review page — /documents/<id>.
 *
 * A directly linkable, full-format Markdown reviewer for any document the
 * Nexus API has registered (server-issued id, allowlisted path). Robert opens
 * the same URL on the desktop dashboard or the phone shell, comments on
 * passages or the whole document, and "Finish review" delivers the verbatim
 * feedback into his existing Praxis conversation.
 */

import { use } from "react";
import { DocumentReviewPage } from "@/components/document-review/document-review";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    return <DocumentReviewPage documentId={id} />;
}
