const { z } = require('zod');

// Check trimmed content without changing source prose on persistence.
const NonblankTextSchema = z.string().refine(value => value.trim().length > 0, 'Must not be blank');

// Knowledge attachments describe requirements and references. Strict objects
// keep authority and verification claims out of this task metadata surface.
const TaskKnowledgeContextSchema = z.object({
    version: z.literal(1),
    lookup_status: z.enum(['available', 'unavailable']),
    requirements: z.array(z.object({
        id: NonblankTextSchema,
        need_id: NonblankTextSchema.optional(),
        question: NonblankTextSchema,
        tags: z.array(NonblankTextSchema),
        reason: NonblankTextSchema,
        satisfaction_test: NonblankTextSchema,
        source_refs: z.array(NonblankTextSchema),
    }).strict()),
}).strict();

// Existing metadata belongs to its owning features. Only the knowledge keys
// receive new validation; all other metadata is retained on creation.
const TaskKnowledgeMetadataSchema = z.object({
    knowledge_context: TaskKnowledgeContextSchema.optional(),
    knowledge_need_ids: z.array(NonblankTextSchema).optional(),
    knowledge_unresolved_need_ids: z.array(NonblankTextSchema).optional(),
}).passthrough();

/**
 * Why task metadata fails the knowledge check, or null when it passes. No
 * response object, so a write path that does not go through a task route (the
 * intake backlog receipt, db/intake-backlog.js) applies the same check.
 */
function knowledgeMetadataError(metadata) {
    if (metadata === undefined) return null;
    const parsed = TaskKnowledgeMetadataSchema.safeParse(metadata);
    if (parsed.success) return null;
    return 'Invalid task knowledge metadata: ' + parsed.error.issues
        .map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

function requireValidKnowledgeMetadata(res, metadata) {
    const error = knowledgeMetadataError(metadata);
    if (!error) return true;
    res.status(400).json({ error });
    return false;
}

module.exports = { requireValidKnowledgeMetadata, knowledgeMetadataError };
