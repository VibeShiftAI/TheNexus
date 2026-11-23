/**
 * A review finished before task 282c64fa (2026-11-23). Back then the approve-
 * after-changes checkbox stored a grant on the review and its submission, and
 * an executor could record Robert's approval of the revised version. The finish
 * route no longer writes that grant, but stored rows keep it and work in flight
 * has to finish under it, so these suites put the same fields on a plain finish.
 */
const fmt = require('../../services/document-review-format');

function markFinishedUnderOldRule(store, reviewId, authority = 'access_user') {
    store.updateReview(reviewId, { approval_delegated: true, submitted_authority: authority });
    const stored = store.getSubmissionForReview(reviewId);
    const payload = { ...stored.payload, approval_delegated: true, submitted_authority: authority };
    return store.updateSubmission(stored.id, { payload, message_text: fmt.formatSubmissionMessage(payload) });
}

module.exports = { markFinishedUnderOldRule };
