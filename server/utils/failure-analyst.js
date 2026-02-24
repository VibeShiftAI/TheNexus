/**
 * Failure Analyst Module
 * Analyzes implementation failures and generates fix tasks.
 * Fully migrated to database-centric architecture.
 */

const { GoogleGenAI } = require('@google/genai');
const db = require('../../db');

// Configuration
const ANALYST_MODEL = 'gemini-2.5-flash';
const MAX_HISTORY_MESSAGES = 20; // Truncate to last N messages
const MAX_ERROR_LOG_LENGTH = 10000; // Characters

/**
 * Error types that should NOT trigger AI analysis (to prevent cascades)
 */
const SKIP_ANALYSIS_ERRORS = [
    'rate limit',
    'quota exceeded',
    '429',
    'too many requests',
    'resource exhausted'
];

/**
 * Build a failure context object from an error and agent state
 * @param {Error} error - The caught error
 * @param {Array} history - The conversation history
 * @param {Object} options - Additional context (toolCalls, projectId, taskId)
 * @returns {Object} Structured failure context
 */
function buildFailureContext(error, history = [], options = {}) {
    const { toolCalls = [], projectId, taskId, taskTitle } = options;

    // Get the last tool call if available
    const lastToolCall = toolCalls.length > 0
        ? toolCalls[toolCalls.length - 1]
        : null;

    // Truncate history to last N messages
    const truncatedHistory = history.slice(-MAX_HISTORY_MESSAGES);

    // Summarize history for the analyst
    const historySummary = truncatedHistory.map((msg, idx) => {
        const role = msg.role || 'unknown';
        const content = msg.parts?.map(p => {
            if (p.text) return p.text.slice(0, 200) + (p.text.length > 200 ? '...' : '');
            if (p.functionCall) return `[Tool Call: ${p.functionCall.name}]`;
            if (p.functionResponse) return `[Tool Response: ${p.functionResponse.name}]`;
            return '[Unknown content]';
        }).join(' | ') || '[Empty]';
        return `${idx + 1}. [${role}]: ${content}`;
    }).join('\n');

    // Classify error type
    let errorType = 'UnknownError';
    const errorMsg = (error.message || '').toLowerCase();

    if (errorMsg.includes('rate') || errorMsg.includes('429') || errorMsg.includes('quota')) {
        errorType = 'RateLimitError';
    } else if (errorMsg.includes('timeout') || errorMsg.includes('deadline')) {
        errorType = 'TimeoutError';
    } else if (errorMsg.includes('syntax') || errorMsg.includes('parse')) {
        errorType = 'ParseError';
    } else if (errorMsg.includes('enoent') || errorMsg.includes('not found')) {
        errorType = 'FileNotFoundError';
    } else if (errorMsg.includes('permission') || errorMsg.includes('access')) {
        errorType = 'PermissionError';
    } else if (errorMsg.includes('network') || errorMsg.includes('fetch') || errorMsg.includes('econnrefused')) {
        errorType = 'NetworkError';
    }

    return {
        timestamp: new Date().toISOString(),
        projectId,
        taskId,
        taskTitle,
        errorType,
        errorMessage: error.message || 'Unknown error',
        errorStack: (error.stack || '').slice(0, MAX_ERROR_LOG_LENGTH),
        lastToolCall: lastToolCall ? {
            tool: lastToolCall.tool,
            args: JSON.stringify(lastToolCall.args).slice(0, 500),
            result: lastToolCall.result
        } : null,
        toolCallCount: toolCalls.length,
        historyLength: history.length,
        historySummary: historySummary.slice(0, MAX_ERROR_LOG_LENGTH)
    };
}

/**
 * Generate a user-friendly error note for the task status
 * @param {Object} failureContext - The structured failure context
 * @returns {string} Human-readable error note
 */
function generateErrorNote(failureContext) {
    const { errorType, errorMessage, lastToolCall, toolCallCount, timestamp } = failureContext;

    let note = `## Implementation Failed\n\n`;
    note += `**Time:** ${new Date(timestamp).toLocaleString()}\n`;
    note += `**Error Type:** ${errorType}\n`;
    note += `**Message:** ${errorMessage.slice(0, 200)}\n\n`;

    if (lastToolCall) {
        note += `**Last Action:** \`${lastToolCall.tool}\` → ${lastToolCall.result}\n`;
    }

    note += `**Progress:** ${toolCallCount} tool calls completed before failure\n\n`;
    note += `---\n`;
    note += `🔄 **Self-correction triggered.** The system is analyzing this failure and will create a fix task automatically.\n`;

    return note;
}

/**
 * Check if analysis should be skipped for this error type
 * @param {Object} failureContext - The failure context
 * @returns {boolean} True if analysis should be skipped
 */
function shouldSkipAnalysis(failureContext) {
    const errorMsg = (failureContext.errorMessage || '').toLowerCase();
    return SKIP_ANALYSIS_ERRORS.some(pattern => errorMsg.includes(pattern));
}

/**
 * Check for duplicate fix tasks
 * @param {Array} plannedTasks - Existing planned tasks
 * @param {string} errorType - The error type to check for
 * @param {string} taskTitle - The original task title
 * @returns {boolean} True if a similar fix already exists
 */
function hasDuplicateFix(plannedTasks = [], errorType, taskTitle) {
    const searchTerms = [
        `fix: ${errorType.toLowerCase()}`,
        `fix ${errorType.toLowerCase()}`,
        `investigate: ${errorType.toLowerCase()}`,
        `fix: ${taskTitle?.toLowerCase() || ''}`
    ];

    return plannedTasks.some(t => {
        const source = t.metadata?.source || t.source;
        if (source !== 'failure-recovery') return false;
        const title = (t.name || t.title || '').toLowerCase();
        return searchTerms.some(term => title.includes(term));
    });
}

/**
 * Analyze failure using Gemini 2.5 Flash and generate a fix task
 * @param {Object} failureContext - The structured failure context
 * @returns {Promise<Object|null>} The generated fix task or null
 */
async function analyzeFailureWithAI(failureContext) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('[FailureAnalyst] No API key configured, skipping AI analysis');
        return null;
    }

    const prompt = buildAnalysisPrompt(failureContext);

    try {
        const genAI = new GoogleGenAI(apiKey);
        const model = genAI.getGenerativeModel({ model: ANALYST_MODEL });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const responseText = response.text();

        console.log('[FailureAnalyst] AI response:', responseText.slice(0, 500));

        // Attempt to parse JSON from response (handling potential markdown blocks)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in AI response');

        return JSON.parse(jsonMatch[0]);

    } catch (error) {
        console.error('[FailureAnalyst] AI analysis failed:', error.message);
        return null;
    }
}

/**
 * Build the analysis prompt for the Failure Analyst
 */
function buildAnalysisPrompt(failureContext) {
    return `You are a Lead Engineer analyzing a crash report from an AI agent implementation system.

## Crash Report

**Task Being Implemented:** ${failureContext.taskTitle || 'Unknown'}
**Project:** ${failureContext.projectId || 'Unknown'}
**Error Type:** ${failureContext.errorType}
**Error Message:** ${failureContext.errorMessage}

**Stack Trace:**
\`\`\`
${failureContext.errorStack || 'Not available'}
\`\`\`

**Last Tool Call:**
${failureContext.lastToolCall
            ? `Tool: ${failureContext.lastToolCall.tool}\nArgs: ${failureContext.lastToolCall.args}\nResult: ${failureContext.lastToolCall.result}`
            : 'Not available'}

**Conversation History Summary:**
${failureContext.historySummary || 'Not available'}

---

## Your Task

1. **Identify the root cause** of this failure based on the evidence above.
2. **Classify the failure** as either:
   - **Environment Issue** (missing dependencies, network errors)
   - **Code Logic Issue** (syntax errors, logic bugs)
   - **Information Issue** (ambiguous requirements, missing context)
   - **Transient Issue** (timeouts, rate limits)

3. **Generate a Fix Task** that an AI agent can execute to resolve this.
   - If it's a code issue, the task should be to fix the code.
   - If it's an info issue, the task should be to ask clarifying questions or research.

## Output Format

Return ONLY a JSON object with this structure:

{
    "analysis": "Brief explanation of the root cause...",
    "classification": "Environment Issue",
    "fixTask": {
        "title": "Fix: [Short description of fix]",
        "description": "Detailed instructions on how to fix the issue...",
        "type": "task",
        "priority": 1
    }
}
`;
}

module.exports = {
    buildFailureContext,
    generateErrorNote,
    analyzeFailureWithAI,
    shouldSkipAnalysis,
    hasDuplicateFix
};