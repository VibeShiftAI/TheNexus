const { callAI } = require('./ai-service');

/**
 * Validates and classifies an initiative request using AI.
 * 
 * @param {Object} request - The request object
 * @param {string} request.title - The title of the initiative
 * @param {string} [request.description] - The description of the initiative
 * @returns {Promise<Object>} - The classification result
 */
async function validateInitiativeRequest(request) {
    const { title, description } = request;

    if (!title) {
        throw new Error('Title is required for validation');
    }

    const systemPrompt = `You are a sophisticated request router for "The Nexus" developer dashboard. 
Your goal is to analyze user requests and classify them into actionable categories.

CLASSIFICATION CATEGORIES:
- FEATURE: A request to add new functionality, enhance existing features, or modify code behavior.
- BUG: A report of functionality not working as expected, errors, or crashes.
- QUESTION: A query about the codebase, architecture, or how to use the system.
- CLARIFICATION_NEEDED: The request is too vague, ambiguous, or lacks sufficient context to be actionable (e.g., "it doesn't work", "fix the code").

OUTPUT FORMAT:
Return a JSON object with the following structure:
{
    "classification": "FEATURE" | "BUG" | "QUESTION" | "CLARIFICATION_NEEDED",
    "confidence": number, // 0.0 to 1.0
    "reasoning": "string", // Brief explanation of why this classification was chosen
    "requiresClarification": boolean // True if classification is CLARIFICATION_NEEDED or confidence is low (< 0.7)
}
`;

    const userPrompt = `Analyze the following request:
Title: "${title}"
Description: "${description || ''}"

 Respond ONLY with the JSON object.`;

    try {
        // Use 'plan' task type as it likely uses a smart model (Claude/Gemini Pro) good for classification
        // Or we could define a new 'router' task type in ai-service/config, but 'quick' might be enough?
        // Let's use 'quick' first for speed, if it fails we can upgrade. 
        // Actually, classification needs to be reliable. Let's use 'plan' which defaults to a smart model.
        // Wait, 'plan' uses Claude Sonnet usually. 'quick' uses Gemini Flash.
        // Let's stick with 'quick' for responsiveness, but maybe ensure it renders JSON.

        const responseText = await callAI('quick', userPrompt, systemPrompt);

        // Clean up response if it contains markdown code blocks
        let cleanJson = responseText.trim();
        if (cleanJson.startsWith('```json')) {
            cleanJson = cleanJson.replace(/```json\n?/, '').replace(/\n?```/, '');
        } else if (cleanJson.startsWith('```')) {
            cleanJson = cleanJson.replace(/```\n?/, '').replace(/\n?```/, '');
        }

        const result = JSON.parse(cleanJson);

        // Normalize
        return {
            classification: result.classification || 'FEATURE',
            confidence: result.confidence || 0.5,
            reasoning: result.reasoning || 'No reasoning provided',
            requiresClarification: result.requiresClarification || false
        };

    } catch (error) {
        console.error('[InitiativeRouter] Error validating request:', error);
        // Fallback to FEATURE if AI fails, to not block the user
        return {
            classification: 'FEATURE',
            confidence: 0.0,
            reasoning: 'AI validation failed, falling back to default.',
            requiresClarification: false,
            error: error.message
        };
    }
}

module.exports = {
    validateInitiativeRequest
};
