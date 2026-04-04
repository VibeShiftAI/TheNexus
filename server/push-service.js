/**
 * Nexus Push Notification Service
 * 
 * Server-side module for sending Expo push notifications to registered
 * mobile devices. Handles batching, error tracking, and auto-disabling
 * of invalid tokens.
 * 
 * Usage:
 *   const push = require('./push-service');
 *   push.init(db);  // Call once at startup, passing the db module
 *   push.notify({ title, body, data, channelId });
 */

const { Expo } = require('expo-server-sdk');

// Create the Expo client
// Access token optional — only needed if "Enhanced Push Security" is enabled in EAS
const expo = new Expo({
    accessToken: process.env.EXPO_PUSH_ACCESS_TOKEN || undefined,
});

let dbRef = null;

/**
 * Initialise the push service with the database module.
 * Must be called once at server startup.
 */
function init(db) {
    dbRef = db;
    console.log('[PushService] Initialised');
}

// ─── Core Send ──────────────────────────────────────────────

/**
 * Send a push notification to ALL registered (enabled) devices.
 * 
 * @param {Object} opts
 * @param {string} opts.title     - Notification title
 * @param {string} opts.body      - Notification body text
 * @param {Object} [opts.data]    - Custom data payload for the app
 * @param {string} [opts.channelId] - Android notification channel
 * @param {string} [opts.sound]   - Sound name (default: 'default')
 * @param {string} [opts.categoryId] - Notification action category
 * @param {number} [opts.badge]   - Badge count
 */
async function notify(opts) {
    if (!dbRef) {
        console.warn('[PushService] Not initialised — call push.init(db) first');
        return { sent: 0, errors: 0 };
    }

    const tokens = await dbRef.getActivePushTokens();
    if (tokens.length === 0) {
        return { sent: 0, errors: 0, reason: 'no_tokens' };
    }

    return sendToTokens(
        tokens.map(t => t.token),
        opts
    );
}

/**
 * Send a push notification to specific tokens.
 * 
 * @param {string[]} pushTokens - Array of Expo push tokens
 * @param {Object} opts - Same as notify()
 */
async function sendToTokens(pushTokens, opts) {
    const messages = [];
    const invalidTokens = [];

    for (const token of pushTokens) {
        if (!Expo.isExpoPushToken(token)) {
            console.warn(`[PushService] Invalid token skipped: ${token.substring(0, 30)}...`);
            invalidTokens.push(token);
            continue;
        }

        messages.push({
            to: token,
            title: opts.title,
            body: opts.body,
            data: opts.data || {},
            sound: opts.sound || 'default',
            channelId: opts.channelId || 'nexus-default',
            categoryId: opts.categoryId || undefined,
            badge: opts.badge !== undefined ? opts.badge : undefined,
            priority: 'high',
        });
    }

    if (messages.length === 0) {
        return { sent: 0, errors: invalidTokens.length, invalidTokens };
    }

    // Chunk for Expo API efficiency
    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];
    let errorCount = 0;

    for (const chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            
            // Process each ticket for success/error tracking
            for (let i = 0; i < ticketChunk.length; i++) {
                const ticket = ticketChunk[i];
                const token = chunk[i].to;

                if (ticket.status === 'ok') {
                    tickets.push(ticket);
                    if (dbRef) await dbRef.markPushTokenSuccess(token);
                } else {
                    errorCount++;
                    const errorMsg = ticket.message || ticket.details?.error || 'Unknown error';
                    console.warn(`[PushService] Push failed for ${String(token).substring(0, 30)}...: ${errorMsg}`);
                    
                    if (dbRef) await dbRef.markPushTokenError(String(token), errorMsg);

                    // If the device is not registered, mark for removal
                    if (ticket.details?.error === 'DeviceNotRegistered') {
                        console.warn(`[PushService] Device not registered, disabling token`);
                        if (dbRef) {
                            await dbRef.markPushTokenError(String(token), 'DeviceNotRegistered');
                            // Force 10 errors to auto-disable
                            for (let j = 0; j < 10; j++) {
                                await dbRef.markPushTokenError(String(token), 'DeviceNotRegistered');
                            }
                        }
                    }
                }
            }
        } catch (err) {
            errorCount += chunk.length;
            console.error('[PushService] Chunk send error:', err.message);
        }
    }

    const result = {
        sent: messages.length - errorCount,
        errors: errorCount + invalidTokens.length,
        total: pushTokens.length,
        tickets: tickets.length,
    };

    if (result.sent > 0) {
        console.log(`[PushService] Sent ${result.sent}/${result.total} notifications: "${opts.title}"`);
    }

    return result;
}

// ─── Convenience Methods ────────────────────────────────────

/**
 * Notify about a task status change.
 */
async function notifyTaskUpdate(task, oldStatus) {
    const statusEmoji = {
        'completed': '✅',
        'in_progress': '🔄',
        'failed': '❌',
        'blocked': '🚫',
        'awaiting_approval': '⏳',
        'cancelled': '🗑️',
    };

    const emoji = statusEmoji[task.status] || '📋';
    const title = `${emoji} Task Update`;
    const body = `"${task.name || task.title || 'Unnamed task'}" → ${task.status.replace(/_/g, ' ')}`;

    return notify({
        title,
        body,
        data: {
            type: 'task_update',
            taskId: task.id,
            projectId: task.project_id,
            status: task.status,
            oldStatus,
            route: '/(tabs)/index',
        },
        channelId: 'nexus-default',
    });
}

/**
 * Notify about a Praxis/Cortex artifact (code output, analysis, etc.)
 */
async function notifyCortexArtifact(artifact) {
    return notify({
        title: '🧠 Praxis Output',
        body: artifact.title || artifact.type || 'New artifact ready',
        data: {
            type: 'cortex_artifact',
            artifactType: artifact.type,
            route: '/(tabs)/praxis',
        },
        channelId: 'praxis-agent',
    });
}

/**
 * Notify about a system alert (Antigravity event).
 */
async function notifySystemAlert(event) {
    const severityEmoji = {
        'critical': '🔴',
        'warning': '🟡',
        'info': '🔵',
    };

    const emoji = severityEmoji[event.severity] || '📢';

    return notify({
        title: `${emoji} ${event.title}`,
        body: event.message || '',
        data: {
            type: 'system_alert',
            eventType: event.event_type,
            severity: event.severity,
            eventId: event.id,
            requiresAction: event.requires_action,
            route: '/(tabs)/settings',
        },
        channelId: event.severity === 'critical' ? 'nexus-default' : 'praxis-agent',
    });
}

/**
 * Notify about an incoming chat message from Praxis.
 */
async function notifyPraxisMessage({ preview, conversationId }) {
    return notify({
        title: '🧠 Praxis',
        body: preview || 'New message',
        data: {
            type: 'praxis_message',
            conversationId,
            route: '/(tabs)/praxis',
        },
        channelId: 'praxis-agent',
    });
}

module.exports = {
    init,
    notify,
    sendToTokens,
    notifyTaskUpdate,
    notifyCortexArtifact,
    notifySystemAlert,
    notifyPraxisMessage,
};
