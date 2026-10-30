/**
 * Critic Service
 * Implements the Reflection Loop from the AI Workflow Optimization document
 * Reviews code before file writes to catch bugs, security issues, and style problems
 * 
 * Based on: Section 4.1 - The Reflection Loop
 */

const path = require('path');
const { trackUsage } = require('../utils/token-tracker');
const { runAgyPrompt, extractJsonSlice } = require('../utils/agy-client');

/**
 * Get critic configuration from environment/defaults
 * No longer uses database - critic is a built-in atomic node
 */
function getCriticConfig() {
    // CRITIC_ENABLED: "true" or "false" (default: true). The review runs on
    // the Antigravity CLI's own default model; there is no model setting.
    const enabled = process.env.CRITIC_ENABLED !== 'false'; // Default to enabled

    return {
        enabled,
        systemPrompt: null, // Use built-in prompt
    };
}

/** The verdict when no review could run: reject by default, saying why. */
function unavailableReview(reason, error) {
    return { approved: false, issues: [`Critic review unavailable: ${reason}`], suggestions: [], error };
}

/**
 * Check if critic is enabled
 */
function isCriticEnabled() {
    const config = getCriticConfig();
    return config.enabled;
}

/**
 * Review code before writing to filesystem
 * Returns { approved: boolean, issues: string[], suggestions: string[] }
 * 
 * @param {string} filepath - The target file path
 * @param {string} content - The code content to write
 * @param {string} projectContext - Optional project context for better review
 */
async function reviewCode(filepath, content, projectContext = '') {
    const config = getCriticConfig();

    if (!config.enabled) {
        console.log('[Critic] Disabled - skipping review');
        return { approved: true, issues: [], suggestions: [], skipped: true };
    }

    console.log(`[Critic] Reviewing code for ${path.basename(filepath)}...`);

    try {
        const systemPrompt = config.systemPrompt || `
You are a Code Critic reviewing code before it is written to the filesystem.

Analyze the proposed code for:
1. **Logical Bugs** - Off-by-one errors, null checks, edge cases
2. **Security Issues** - Injection vulnerabilities, exposed secrets, unsafe operations
3. **Style Issues** - Inconsistency with project conventions, naming problems
4. **Missing Pieces** - Incomplete implementations, missing error handling

Output format:
{
  "approved": true|false,
  "issues": ["issue 1", "issue 2"],
  "suggestions": ["suggestion 1"]
}

Be concise but thorough. If no issues, set approved to true with empty arrays.
`;

        const reviewPrompt = `
## File: ${filepath}

${projectContext ? `## Project Context:\n${projectContext}\n\n` : ''}
## Code to Review:
\`\`\`
${content.substring(0, 10000)} ${content.length > 10000 ? '\n[TRUNCATED - ' + content.length + ' chars total]' : ''}
\`\`\`

Review this code and respond with JSON only.
`;

        // The Antigravity CLI (agy): subscription-authed Gemini, no per-token
        // spend. There is no API fallback (Robert's 2026-08-11 rule: no direct
        // Gemini API anywhere); when agy cannot answer, the review is
        // unavailable and the write is rejected by default, as it was when no
        // API key was set.
        const agy = await runAgyPrompt(
            `${systemPrompt}\n\n${reviewPrompt}\n\nRespond with ONLY the JSON object (no prose, no code fences).`,
        );
        if (!agy.ok) {
            console.warn(`[Critic] agy unavailable (${agy.error}) - rejecting by default`);
            return unavailableReview(`the Antigravity CLI could not answer (${agy.error})`, 'agy_unavailable');
        }
        const slice = extractJsonSlice(agy.text);
        if (!slice) {
            console.warn('[Critic] agy reply carried no JSON - rejecting by default');
            return unavailableReview('the reply carried no JSON verdict', 'parse_error');
        }
        let review;
        try {
            review = JSON.parse(slice);
        } catch (parseError) {
            console.warn('[Critic] agy reply carried unparseable JSON - rejecting by default');
            return unavailableReview('the reply carried unparseable JSON', 'parse_error');
        }
        // Subscription CLI: no token counts exist; record the call at zero.
        trackUsage({ provider: 'antigravity', model: 'agy-default', inputTokens: 0, outputTokens: 0, task: 'critic' });
        console.log(`[Critic] Review complete via agy: ${review.approved ? 'APPROVED' : 'ISSUES FOUND'}`);
        if (review.issues?.length > 0) {
            console.log(`[Critic] Issues: ${review.issues.join(', ')}`);
        }
        return review;

    } catch (error) {
        console.error('[Critic] Review failed:', error.message);
        return { approved: false, issues: ['Critic review failed: ' + error.message], suggestions: [], error: error.message };
    }
}

/**
 * Toggle critic enabled/disabled
 * Note: Since critic is now configured via env vars, this just logs the request.
 * To persist the change, set CRITIC_ENABLED environment variable.
 */
function setCriticEnabled(enabled) {
    console.log(`[Critic] ${enabled ? 'Enable' : 'Disable'} requested.`);
    console.log('[Critic] To persist this setting, set CRITIC_ENABLED=' + (enabled ? 'true' : 'false') + ' in your environment.');
    // Return true to indicate the request was received
    // Actual state change requires env var or server restart
    return true;
}

module.exports = {
    reviewCode,
    isCriticEnabled,
    setCriticEnabled,
    getCriticConfig
};
