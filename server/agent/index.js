const { GoogleGenAI } = require('@google/genai');
const { getTool, getGeminiTools } = require('../tools');

// Token truncation settings
const MAX_TOOL_RESULT_LENGTH = 5000;
const HISTORY_PRUNE_INTERVAL = 15;

/**
 * Handles checkpoint reset
 */
function handleCheckpointReset(checkpointResult, currentHistory, systemPrompt) {
    const { checkpointData } = checkpointResult;
    
    console.log('[Agent] Processing checkpoint - resetting conversation history');
    console.log(`[Agent] Archived ${currentHistory.length} messages`);
    
    const newHistory = [];
    
    // Re-inject system prompt
    if (systemPrompt) {
        newHistory.push({
            role: 'user',
            parts: [{ text: systemPrompt }]
        });
        newHistory.push({
            role: 'model',
            parts: [{ text: 'Understood. Ready to assist.' }]
        });
    }
    
    // Add checkpoint summary
    const contextMessage = `
## CONTEXT RESTORED FROM CHECKPOINT

**Summary of Previous Work:**
${checkpointData.summary}

**Next Steps:**
${checkpointData.next_steps}

Continue from here. Previous history has been archived.
`.trim();

    newHistory.push({
        role: 'user',
        parts: [{ text: contextMessage }]
    });
    
    newHistory.push({
        role: 'model', 
        parts: [{ text: 'Checkpoint acknowledged. Continuing with next steps.' }]
    });
    
    return newHistory;
}

/**
 * Truncates tool results to prevent token bloat
 */
function truncateResult(result, maxLength = MAX_TOOL_RESULT_LENGTH) {
    if (typeof result === 'string' && result.length > maxLength) {
        return result.slice(0, maxLength) + '\n... [truncated]';
    }
    if (typeof result === 'object') {
        const str = JSON.stringify(result);
        if (str.length > maxLength) {
            return str.slice(0, maxLength) + '... [truncated]';
        }
    }
    return result;
}

/**
 * Main agent loop
 */
async function runAgent(options) {
    const {
        projectName,
        projectId,
        task,
        systemPrompt: providedSystemPrompt,
        onAction,
        onProgress,
        maxIterations = 50,
        provider = 'google',
        model = 'gemini-2.5-pro-preview-05-06',
        // Optional context for failure analysis
        projectPath = null,
        featureId = null,
        featureTitle = null
    } = options;
    
    // Store system prompt for potential checkpoint restoration
    const systemPrompt = providedSystemPrompt;
    
    // Initialize history with system prompt
    let history = [];
    if (systemPrompt) {
        history.push({
            role: 'user',
            parts: [{ text: systemPrompt }]
        });
        history.push({
            role: 'model',
            parts: [{ text: 'Understood. I will help implement this feature.' }]
        });
    }
    
    // Add the task
    history.push({
        role: 'user',
        parts: [{ text: task }]
    });
    
    // Get tools for the provider
    // Currently hardcoded to Gemini tools as the main driver
    const tools = getGeminiTools();
    
    // Initialize AI client
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenAI({ apiKey });
    
    let iterations = 0;
    let isComplete = false;
    
    // Track tool calls for potential failure analysis
    const allToolCalls = [];
    
    try {
        while (!isComplete && iterations < maxIterations) {
            iterations++;
            
            if (onProgress) {
                onProgress({ iteration: iterations, maxIterations, historyLength: history.length });
            }
            
            // Prune history periodically
            if (iterations % HISTORY_PRUNE_INTERVAL === 0 && history.length > 20) {
                console.log(`[Agent] Pruning history at iteration ${iterations}`);
                // Keep first 4 (system) and last 10 messages
                history = [...history.slice(0, 4), ...history.slice(-10)];
            }
            
            // Call the model
            const response = await genAI.models.generateContent({
                model,
                contents: history,
                config: {
                    tools: [{ functionDeclarations: tools }],
                    thinkingConfig: { thinkingBudget: 5000 }
                }
            });
            
            // Extract response
            const candidate = response.candidates?.[0];
            if (!candidate) {
                throw new Error('No response candidate');
            }
            
            const parts = candidate.content?.parts || [];
            
            // Check for function calls
            const functionCalls = parts.filter(p => p.functionCall);
            
            if (functionCalls.length > 0) {
                // Process each function call
                for (const part of functionCalls) {
                    const { name: toolName, args: toolArgs } = part.functionCall;
                    
                    console.log(`[Agent] Tool call: ${toolName}`);
                    
                    // Get the tool
                    const tool = getTool(toolName);
                    if (!tool) {
                        history.push({
                            role: 'model',
                            parts: [part]
                        });
                        history.push({
                            role: 'user',
                            parts: [{ text: `Error: Unknown tool "${toolName}"` }]
                        });
                        continue;
                    }
                    
                    // Execute with context
                    const executionContext = {
                        history: history,
                        projectId: projectId || projectName
                    };
                    
                    let toolResult;
                    try {
                        toolResult = await tool.execute(toolArgs, executionContext);
                    } catch (execError) {
                        toolResult = { error: execError.message };
                    }
                    
                    // Handle checkpoint specially
                    if (toolResult.isCheckpoint) {
                        if (toolResult.success) {
                            // Reset history with checkpoint
                            history = handleCheckpointReset(toolResult, history, systemPrompt);
                            
                            if (onAction) {
                                onAction({
                                    tool: 'checkpoint_memory',
                                    args: { summary_length: toolResult.checkpointData.summary.length },
                                    result: 'success',
                                    timestamp: new Date().toISOString()
                                });
                            }
                            
                            // Continue loop with fresh history
                            continue;
                        } else {
                            // Checkpoint failed - tell agent to retry
                            history.push({
                                role: 'model',
                                parts: [part]
                            });
                            history.push({
                                role: 'user',
                                parts: [{ text: `Checkpoint failed: ${toolResult.error}` }]
                            });
                            continue;
                        }
                    }
                    
                    // Normal tool - log action
                    const toolRecord = {
                        tool: toolName,
                        args: toolArgs,
                        result: toolResult.error ? 'error' : 'success',
                        timestamp: new Date().toISOString()
                    };
                    allToolCalls.push(toolRecord);

                    if (onAction) {
                        onAction(toolRecord);
                    }
                    
                    // Add model's function call to history
                    history.push({
                        role: 'model',
                        parts: [part]
                    });
                    
                    // Add truncated result
                    const truncatedResult = truncateResult(
                        toolResult.error || toolResult.content || JSON.stringify(toolResult)
                    );
                    
                    history.push({
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: toolName,
                                response: { result: truncatedResult }
                            }
                        }]
                    });
                }
            } else {
                // No function calls - check for completion or text response
                const textParts = parts.filter(p => p.text);
                
                if (textParts.length > 0) {
                    const responseText = textParts.map(p => p.text).join('\n');
                    
                    // Check for completion signals
                    if (responseText.includes('IMPLEMENTATION COMPLETE') || 
                        responseText.includes('Task completed') ||
                        candidate.finishReason === 'STOP') {
                        isComplete = true;
                        
                        return {
                            success: true,
                            response: responseText,
                            iterations,
                            historyLength: history.length
                        };
                    }
                    
                    // Add to history and continue
                    history.push({
                        role: 'model',
                        parts: textParts
                    });
                }
            }
            
        } 
        
        return {
            success: false,
            error: 'Max iterations reached',
            iterations,
            historyLength: history.length
        };

    } catch (error) {
        console.error(`[Agent] Error at iteration ${iterations}:`, error);
        
        // Try to trigger failure analysis if available
        // Note: Avoiding circular dependency by using dynamic import or separate utility
        // For now, we just log it and return the error state
        
        return {
            success: false,
            error: error.message,
            errorType: error.name || 'Error',
            iterations,
            historyLength: history.length,
            toolCallCount: allToolCalls.length,
            selfCorrectionTriggered: false
        };
    }
}

module.exports = { runAgent };
