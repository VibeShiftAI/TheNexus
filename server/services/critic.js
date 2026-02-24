/**
 * Critic Service
 * Implements the Reflection Loop from the AI Workflow Optimization document
 * Reviews code before file writes to catch bugs, security issues, and style problems
 * 
 * Based on: Section 4.1 - The Reflection Loop
 */

const path = require('path');

/**
 * Get critic configuration from environment/defaults
 * No longer uses database - critic is a built-in atomic node
 */
function getCriticConfig() {
    // Critic configuration now comes from environment variables
    // CRITIC_ENABLED: "true" or "false" (default: true)
    // CRITIC_MODEL: model ID (default: "gemini-2.5-flash")

    const enabled = process.env.CRITIC_ENABLED !== 'false'; // Default to enabled

    return {
        enabled,
        defaultModel: process.env.CRITIC_MODEL || 'gemini-2.5-flash',
        systemPrompt: null, // Use built-in prompt
    };
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

    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('[Critic] No API key configured - rejecting by default');
        return { approved: false, issues: ['Critic API key not configured'], suggestions: [], error: 'api_key_missing' };
    }

    console.log(`[Critic] Reviewing code for ${path.basename(filepath)}...`);

    try {
        const modelId = config.defaultModel || 'gemini-3-flash';
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

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    { role: 'user', parts: [{ text: systemPrompt + '\n\n' + reviewPrompt }] }
                ],
                generationConfig: {
                    responseMimeType: 'application/json'
                }
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('[Critic] API error:', data.error.message);
            return { approved: false, issues: ['Critic API returned an error: ' + data.error.message], suggestions: [], error: data.error.message };
        }

        const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textContent) {
            console.error('[Critic] No response from API');
            return { approved: false, issues: ['Critic received no response from API'], suggestions: [], error: 'no_response' };
        }

        // Parse JSON response
        try {
            const review = JSON.parse(textContent);
            console.log(`[Critic] Review complete: ${review.approved ? 'APPROVED' : 'ISSUES FOUND'}`);
            if (review.issues?.length > 0) {
                console.log(`[Critic] Issues: ${review.issues.join(', ')}`);
            }
            return review;
        } catch (parseError) {
            console.error('[Critic] Failed to parse response:', textContent.substring(0, 200));
            return { approved: false, issues: ['Critic failed to parse API response'], suggestions: [], error: 'parse_error' };
        }

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
