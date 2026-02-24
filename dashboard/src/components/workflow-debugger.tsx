'use client';

/**
 * WorkflowDebugger - Time-travel debugging UI for LangGraph workflows
 * 
 * Features:
 * - Timeline visualization of checkpoints
 * - State inspector at each checkpoint
 * - Rewind to specific checkpoints
 * - Branch from checkpoint
 */

import React, { useState, useEffect, useCallback } from 'react';

interface Checkpoint {
    checkpoint_id: string;
    thread_id: string;
    created_at: string;
    step: number;
    node: string;
}

interface WorkflowState {
    messages?: Array<{ role: string; content: string }>;
    outputs?: Record<string, unknown>;
    current_step?: string;
    context?: Record<string, unknown>;
}

interface WorkflowDebuggerProps {
    runId: string;
    projectId?: string;
    onRewind?: (checkpointId: string) => Promise<void>;
    onClose?: () => void;
}

export function WorkflowDebugger({
    runId,
    projectId,
    onRewind,
    onClose,
}: WorkflowDebuggerProps) {
    const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
    const [selectedCheckpoint, setSelectedCheckpoint] = useState<Checkpoint | null>(null);
    const [runStatus, setRunStatus] = useState<{
        status: string;
        current_node?: string;
        error?: string;
    } | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isRewinding, setIsRewinding] = useState(false);

    // Fetch checkpoints and run status
    const fetchData = useCallback(async () => {
        try {
            // Fetch run status
            const statusRes = await fetch(`/api/langgraph/runs/${runId}`);
            if (statusRes.ok) {
                setRunStatus(await statusRes.json());
            }

            // Fetch checkpoints
            const checkpointsRes = await fetch(`/api/langgraph/runs/${runId}/checkpoints`);
            if (checkpointsRes.ok) {
                const data = await checkpointsRes.json();
                setCheckpoints(data.checkpoints || []);
            }
        } catch (error) {
            console.error('Failed to fetch debugger data:', error);
        } finally {
            setIsLoading(false);
        }
    }, [runId]);

    // Poll for updates while running
    useEffect(() => {
        fetchData();

        const interval = setInterval(() => {
            if (runStatus?.status === 'running') {
                fetchData();
            }
        }, 2000);

        return () => clearInterval(interval);
    }, [fetchData, runStatus?.status]);

    // Handle rewind
    const handleRewind = async (checkpoint: Checkpoint) => {
        if (!onRewind) return;

        setIsRewinding(true);
        try {
            await onRewind(checkpoint.checkpoint_id);
            await fetchData();
        } finally {
            setIsRewinding(false);
        }
    };

    // Get node icon based on type
    const getNodeIcon = (nodeName: string) => {
        if (nodeName.includes('research')) return '🔬';
        if (nodeName.includes('plan')) return '📋';
        if (nodeName.includes('code')) return '💻';
        if (nodeName.includes('review')) return '👀';
        if (nodeName.includes('supervisor')) return '👔';
        return '⚙️';
    };

    // Get status color
    const getStatusColor = (status: string) => {
        switch (status) {
            case 'running': return '#22c55e';
            case 'completed': return '#3b82f6';
            case 'failed': return '#ef4444';
            case 'cancelled': return '#f59e0b';
            default: return '#6b7280';
        }
    };

    return (
        <div className="workflow-debugger">
            {/* Header */}
            <div className="debugger-header">
                <div className="header-info">
                    <h3>🕐 Time-Travel Debugger</h3>
                    <span className="run-id">Run: {runId.slice(0, 8)}...</span>
                </div>
                <div className="header-status">
                    {runStatus && (
                        <span
                            className="status-badge"
                            style={{ backgroundColor: getStatusColor(runStatus.status) }}
                        >
                            {runStatus.status}
                        </span>
                    )}
                    {onClose && (
                        <button className="close-btn" onClick={onClose}>×</button>
                    )}
                </div>
            </div>

            {/* Timeline */}
            <div className="timeline-container">
                <div className="timeline-label">Checkpoints</div>
                {isLoading ? (
                    <div className="loading">Loading checkpoints...</div>
                ) : checkpoints.length === 0 ? (
                    <div className="empty">No checkpoints yet</div>
                ) : (
                    <div className="timeline">
                        {checkpoints.map((checkpoint, index) => (
                            <div
                                key={checkpoint.checkpoint_id}
                                className={`checkpoint ${selectedCheckpoint?.checkpoint_id === checkpoint.checkpoint_id ? 'selected' : ''}`}
                                onClick={() => setSelectedCheckpoint(checkpoint)}
                            >
                                <div className="checkpoint-marker">
                                    <span className="node-icon">{getNodeIcon(checkpoint.node)}</span>
                                    <span className="step-number">{checkpoint.step}</span>
                                </div>
                                <div className="checkpoint-info">
                                    <span className="node-name">{checkpoint.node}</span>
                                    <span className="timestamp">
                                        {new Date(checkpoint.created_at).toLocaleTimeString()}
                                    </span>
                                </div>
                                {index < checkpoints.length - 1 && (
                                    <div className="connector" />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* State Inspector */}
            {selectedCheckpoint && (
                <div className="state-inspector">
                    <div className="inspector-header">
                        <h4>
                            {getNodeIcon(selectedCheckpoint.node)} {selectedCheckpoint.node}
                        </h4>
                        <span className="step">Step {selectedCheckpoint.step}</span>
                    </div>

                    <div className="inspector-content">
                        <div className="info-row">
                            <span className="label">Checkpoint ID:</span>
                            <code>{selectedCheckpoint.checkpoint_id.slice(0, 16)}...</code>
                        </div>
                        <div className="info-row">
                            <span className="label">Thread ID:</span>
                            <code>{selectedCheckpoint.thread_id.slice(0, 16)}...</code>
                        </div>
                        <div className="info-row">
                            <span className="label">Created:</span>
                            <span>{new Date(selectedCheckpoint.created_at).toLocaleString()}</span>
                        </div>
                    </div>

                    <div className="inspector-actions">
                        <button
                            className="btn btn-rewind"
                            onClick={() => handleRewind(selectedCheckpoint)}
                            disabled={isRewinding || runStatus?.status === 'running'}
                        >
                            {isRewinding ? '⏳ Rewinding...' : '⏪ Rewind Here'}
                        </button>
                    </div>
                </div>
            )}

            {/* Error display */}
            {runStatus?.error && (
                <div className="error-panel">
                    <h4>❌ Error</h4>
                    <pre>{runStatus.error}</pre>
                </div>
            )}

            <style jsx>{`
        .workflow-debugger {
          background: #1e1e2e;
          border: 1px solid #333;
          border-radius: 12px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          max-height: 600px;
        }

        .debugger-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
          background: #252538;
          border-bottom: 1px solid #333;
        }

        .header-info h3 {
          margin: 0;
          font-size: 1rem;
          color: #fff;
        }

        .run-id {
          font-size: 0.75rem;
          color: #888;
          font-family: monospace;
        }

        .header-status {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .status-badge {
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 0.75rem;
          color: white;
          text-transform: uppercase;
          font-weight: 600;
        }

        .close-btn {
          background: none;
          border: none;
          color: #888;
          font-size: 1.5rem;
          cursor: pointer;
          padding: 0 8px;
        }

        .close-btn:hover {
          color: #fff;
        }

        .timeline-container {
          padding: 16px;
          border-bottom: 1px solid #333;
          max-height: 200px;
          overflow-y: auto;
        }

        .timeline-label {
          font-size: 0.75rem;
          color: #888;
          text-transform: uppercase;
          margin-bottom: 12px;
        }

        .loading, .empty {
          color: #666;
          font-size: 0.875rem;
          padding: 16px;
          text-align: center;
        }

        .timeline {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .checkpoint {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 12px;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
          position: relative;
        }

        .checkpoint:hover {
          background: #2a2a3e;
        }

        .checkpoint.selected {
          background: #6366f120;
          border: 1px solid #6366f1;
        }

        .checkpoint-marker {
          display: flex;
          align-items: center;
          gap: 6px;
          background: #333;
          padding: 4px 8px;
          border-radius: 6px;
        }

        .node-icon {
          font-size: 1rem;
        }

        .step-number {
          font-size: 0.75rem;
          color: #888;
          font-weight: 600;
        }

        .checkpoint-info {
          display: flex;
          flex-direction: column;
          flex: 1;
        }

        .node-name {
          font-size: 0.875rem;
          color: #fff;
        }

        .timestamp {
          font-size: 0.75rem;
          color: #666;
        }

        .connector {
          position: absolute;
          left: 32px;
          bottom: -10px;
          width: 2px;
          height: 14px;
          background: #444;
        }

        .state-inspector {
          padding: 16px;
          background: #252538;
          border-top: 1px solid #333;
        }

        .inspector-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .inspector-header h4 {
          margin: 0;
          font-size: 1rem;
          color: #fff;
        }

        .step {
          color: #6366f1;
          font-size: 0.75rem;
          background: #6366f120;
          padding: 4px 8px;
          border-radius: 4px;
        }

        .inspector-content {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 16px;
        }

        .info-row {
          display: flex;
          justify-content: space-between;
          font-size: 0.875rem;
        }

        .info-row .label {
          color: #888;
        }

        .info-row code {
          color: #10b981;
          font-family: monospace;
          font-size: 0.75rem;
        }

        .inspector-actions {
          display: flex;
          gap: 8px;
        }

        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          font-size: 0.875rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-rewind {
          background: linear-gradient(135deg, #f59e0b, #d97706);
          color: white;
          flex: 1;
        }

        .btn-rewind:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
        }

        .error-panel {
          padding: 16px;
          background: #ef444420;
          border-top: 1px solid #ef4444;
        }

        .error-panel h4 {
          margin: 0 0 8px 0;
          color: #ef4444;
        }

        .error-panel pre {
          margin: 0;
          padding: 8px;
          background: #1e1e2e;
          border-radius: 4px;
          overflow-x: auto;
          font-size: 0.75rem;
          color: #fca5a5;
        }
      `}</style>
        </div>
    );
}

export default WorkflowDebugger;
