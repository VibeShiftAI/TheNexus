'use client';

/**
 * State Inspector - Live Workflow State Visualization
 * 
 * Per The Nexus Protocol Phase 5, provides:
 * - Live schema editor for defining custom state fields
 * - Real-time trace visualization during execution
 * - Neon-highlighted variable changes
 * - Cost estimation panel
 * 
 * NOTE: Model selector fetches from /api/models for consistency with
 * the atomic node schema system (Phase 10 integration).
 */

import React, { useState, useEffect, useRef } from 'react';
import {
    Eye, Code, Zap, DollarSign, Plus, Trash2, Play, Pause,
    ChevronDown, ChevronUp, RefreshCw, AlertCircle, CheckCircle2,
    Clock, Activity, Sparkles
} from 'lucide-react';

// === Types ===

interface StateField {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    value: unknown;
    changed?: boolean;
    timestamp?: number;
}

interface TraceStep {
    id: string;
    node: string;
    action: string;
    timestamp: number;
    duration?: number;
    status: 'pending' | 'running' | 'success' | 'error';
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    stateChanges?: Record<string, unknown>;
}

interface CostEstimate {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
    model: string;
}

// === Cost Constants ===
// Fallback costs when API unavailable - prefer dynamic /api/models data
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
    'gemini-3-flash-preview': { input: 0.000075, output: 0.0003 },
    'gemini-3-pro-preview': { input: 0.00125, output: 0.01 },
    'gpt-4o': { input: 0.005, output: 0.015 },
    'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-opus': { input: 0.015, output: 0.075 },
};

// === Sub-Components ===

function SchemaEditor({
    fields,
    onUpdate,
    onAdd,
    onRemove,
}: {
    fields: StateField[];
    onUpdate: (index: number, field: Partial<StateField>) => void;
    onAdd: () => void;
    onRemove: (index: number) => void;
}) {
    const [newFieldName, setNewFieldName] = useState('');
    const [newFieldType, setNewFieldType] = useState<StateField['type']>('string');

    const handleAdd = () => {
        if (newFieldName.trim()) {
            onAdd();
            setNewFieldName('');
        }
    };

    return (
        <div className="schema-editor">
            <div className="editor-header">
                <Code size={14} />
                <span>State Schema</span>
            </div>

            <div className="fields-list">
                {fields.map((field, i) => (
                    <div key={i} className={`field-row ${field.changed ? 'changed' : ''}`}>
                        <input
                            type="text"
                            value={field.name}
                            onChange={(e) => onUpdate(i, { name: e.target.value })}
                            placeholder="Field name"
                            className="field-name"
                        />
                        <select
                            value={field.type}
                            onChange={(e) => onUpdate(i, { type: e.target.value as StateField['type'] })}
                            className="field-type"
                        >
                            <option value="string">string</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                            <option value="object">object</option>
                            <option value="array">array</option>
                        </select>
                        <button
                            onClick={() => onRemove(i)}
                            className="remove-btn"
                            title="Remove field"
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                ))}
            </div>

            <button className="add-field-btn" onClick={onAdd}>
                <Plus size={12} />
                Add Field
            </button>

            <style jsx>{`
                .schema-editor {
                    background: #0f0f1a;
                    border: 1px solid #2a2a40;
                    border-radius: 8px;
                    padding: 12px;
                }

                .editor-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: #a78bfa;
                    font-size: 0.75rem;
                    font-weight: 600;
                    margin-bottom: 12px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .fields-list {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    margin-bottom: 12px;
                }

                .field-row {
                    display: flex;
                    gap: 6px;
                    align-items: center;
                    padding: 6px 8px;
                    background: #1a1a2e;
                    border-radius: 6px;
                    border: 1px solid #2a2a40;
                    transition: all 0.3s ease;
                }

                .field-row.changed {
                    border-color: #22c55e;
                    box-shadow: 0 0 12px rgba(34, 197, 94, 0.3);
                    animation: pulse-glow 1s ease-out;
                }

                @keyframes pulse-glow {
                    0% { box-shadow: 0 0 20px rgba(34, 197, 94, 0.6); }
                    100% { box-shadow: 0 0 12px rgba(34, 197, 94, 0.3); }
                }

                .field-name {
                    flex: 1;
                    background: transparent;
                    border: none;
                    color: #fff;
                    font-size: 0.75rem;
                    font-family: monospace;
                }

                .field-name:focus {
                    outline: none;
                }

                .field-type {
                    background: #2a2a40;
                    border: none;
                    color: #a78bfa;
                    font-size: 0.65rem;
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                }

                .remove-btn {
                    background: none;
                    border: none;
                    color: #666;
                    cursor: pointer;
                    padding: 4px;
                    transition: color 0.2s;
                }

                .remove-btn:hover {
                    color: #ef4444;
                }

                .add-field-btn {
                    width: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    padding: 8px;
                    background: rgba(99, 102, 241, 0.1);
                    border: 1px dashed #6366f1;
                    border-radius: 6px;
                    color: #6366f1;
                    font-size: 0.7rem;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .add-field-btn:hover {
                    background: rgba(99, 102, 241, 0.2);
                }
            `}</style>
        </div>
    );
}

function TraceViewer({
    steps,
    isRunning,
}: {
    steps: TraceStep[];
    isRunning: boolean;
}) {
    const traceEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        traceEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [steps]);

    const getStatusIcon = (status: TraceStep['status']) => {
        switch (status) {
            case 'pending': return <Clock size={12} className="text-slate-500" />;
            case 'running': return <RefreshCw size={12} className="text-blue-400 animate-spin" />;
            case 'success': return <CheckCircle2 size={12} className="text-green-400" />;
            case 'error': return <AlertCircle size={12} className="text-red-400" />;
        }
    };

    return (
        <div className="trace-viewer">
            <div className="trace-header">
                <Activity size={14} />
                <span>Execution Trace</span>
                {isRunning && (
                    <span className="live-badge">
                        <span className="pulse" />
                        LIVE
                    </span>
                )}
            </div>

            <div className="trace-list">
                {steps.length === 0 ? (
                    <div className="empty-trace">
                        <Sparkles size={20} />
                        <span>Run workflow to see trace</span>
                    </div>
                ) : (
                    steps.map((step, i) => (
                        <div key={step.id} className={`trace-step status-${step.status}`}>
                            <div className="step-line" />
                            <div className="step-icon">{getStatusIcon(step.status)}</div>
                            <div className="step-content">
                                <div className="step-header">
                                    <span className="step-node">{step.node}</span>
                                    <span className="step-action">{step.action}</span>
                                </div>
                                {step.duration && (
                                    <div className="step-meta">
                                        <span>{step.duration}ms</span>
                                        {step.cost && <span>${step.cost.toFixed(4)}</span>}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}
                <div ref={traceEndRef} />
            </div>

            <style jsx>{`
                .trace-viewer {
                    background: #0f0f1a;
                    border: 1px solid #2a2a40;
                    border-radius: 8px;
                    overflow: hidden;
                }

                .trace-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 10px 12px;
                    background: #1a1a2e;
                    color: #6366f1;
                    font-size: 0.75rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    border-bottom: 1px solid #2a2a40;
                }

                .live-badge {
                    margin-left: auto;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 2px 8px;
                    background: rgba(239, 68, 68, 0.2);
                    border-radius: 10px;
                    color: #ef4444;
                    font-size: 0.6rem;
                }

                .pulse {
                    width: 6px;
                    height: 6px;
                    background: #ef4444;
                    border-radius: 50%;
                    animation: pulse 1s infinite;
                }

                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }

                .trace-list {
                    max-height: 300px;
                    overflow-y: auto;
                    padding: 12px;
                }

                .empty-trace {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 8px;
                    padding: 24px;
                    color: #666;
                    font-size: 0.75rem;
                }

                .trace-step {
                    display: flex;
                    gap: 10px;
                    padding: 8px 0;
                    position: relative;
                }

                .step-line {
                    position: absolute;
                    left: 5px;
                    top: 20px;
                    bottom: -8px;
                    width: 2px;
                    background: #2a2a40;
                }

                .trace-step:last-child .step-line {
                    display: none;
                }

                .step-icon {
                    z-index: 1;
                    background: #0f0f1a;
                    padding: 2px;
                }

                .step-content {
                    flex: 1;
                }

                .step-header {
                    display: flex;
                    gap: 8px;
                    align-items: center;
                }

                .step-node {
                    font-size: 0.75rem;
                    font-weight: 600;
                    color: #fff;
                }

                .step-action {
                    font-size: 0.65rem;
                    color: #666;
                }

                .step-meta {
                    display: flex;
                    gap: 12px;
                    margin-top: 4px;
                    font-size: 0.65rem;
                    color: #888;
                }

                .status-running .step-node {
                    color: #60a5fa;
                }

                .status-success .step-node {
                    color: #4ade80;
                }

                .status-error .step-node {
                    color: #f87171;
                }
            `}</style>
        </div>
    );
}

function CostPanel({
    estimate,
    model,
    onModelChange,
    models,
    error,
}: {
    estimate: CostEstimate;
    model: string;
    onModelChange: (model: string) => void;
    models: Array<{ id: string; name: string }>;
    error: string | null;
}) {
    if (error) {
        return (
            <div className="cost-panel">
                <div className="cost-header">
                    <DollarSign size={14} />
                    <span>Cost Estimation</span>
                </div>
                <div style={{
                    padding: '16px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    color: '#f87171',
                    fontSize: '0.75rem'
                }}>
                    <strong>Error:</strong> {error}
                </div>
            </div>
        );
    }

    return (
        <div className="cost-panel">
            <div className="cost-header">
                <DollarSign size={14} />
                <span>Cost Estimation</span>
            </div>

            <div className="cost-content">
                <div className="model-select">
                    <label>Model</label>
                    <select value={model} onChange={(e) => onModelChange(e.target.value)}>
                        {models.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                    </select>
                </div>

                <div className="cost-grid">
                    <div className="cost-item">
                        <span className="cost-label">Input Tokens</span>
                        <span className="cost-value">{estimate.inputTokens.toLocaleString()}</span>
                    </div>
                    <div className="cost-item">
                        <span className="cost-label">Output Tokens</span>
                        <span className="cost-value">{estimate.outputTokens.toLocaleString()}</span>
                    </div>
                    <div className="cost-item total">
                        <span className="cost-label">Est. Cost</span>
                        <span className="cost-value">${estimate.totalCost.toFixed(4)}</span>
                    </div>
                </div>
            </div>

            <style jsx>{`
                .cost-panel {
                    background: #0f0f1a;
                    border: 1px solid #2a2a40;
                    border-radius: 8px;
                    overflow: hidden;
                }

                .cost-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 10px 12px;
                    background: #1a1a2e;
                    color: #fbbf24;
                    font-size: 0.75rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    border-bottom: 1px solid #2a2a40;
                }

                .cost-content {
                    padding: 12px;
                }

                .model-select {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 12px;
                }

                .model-select label {
                    font-size: 0.7rem;
                    color: #888;
                }

                .model-select select {
                    background: #2a2a40;
                    border: none;
                    color: #fff;
                    font-size: 0.7rem;
                    padding: 6px 10px;
                    border-radius: 4px;
                    cursor: pointer;
                }

                .cost-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 8px;
                }

                .cost-item {
                    padding: 8px;
                    background: #1a1a2e;
                    border-radius: 6px;
                }

                .cost-item.total {
                    grid-column: 1 / -1;
                    background: linear-gradient(135deg, rgba(251, 191, 36, 0.1), transparent);
                    border: 1px solid rgba(251, 191, 36, 0.3);
                }

                .cost-label {
                    display: block;
                    font-size: 0.6rem;
                    color: #888;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 4px;
                }

                .cost-value {
                    font-size: 0.85rem;
                    font-weight: 600;
                    color: #fff;
                    font-family: monospace;
                }

                .total .cost-value {
                    color: #fbbf24;
                }
            `}</style>
        </div>
    );
}

// === Main Component ===

// Import Node type from react-flow for workflow nodes
type WorkflowNode = {
    id: string;
    type?: string;
    data?: { label?: string; config?: Record<string, unknown> };
};

interface StateInspectorProps {
    workflowId?: string;
    className?: string;
    nodes?: WorkflowNode[];  // Workflow nodes from canvas
}

// Model type for API response
interface ApiModel {
    id: string;
    name: string;
    input_price?: number;
    output_price?: number;
}

export function StateInspector({ workflowId, className = '', nodes: workflowNodes = [] }: StateInspectorProps) {
    const [isExpanded, setIsExpanded] = useState(true);
    const [activeTab, setActiveTab] = useState<'state' | 'trace' | 'cost'>('state');
    const [isRunning, setIsRunning] = useState(false);
    const [model, setModel] = useState('');
    const [availableModels, setAvailableModels] = useState<ApiModel[]>([]);
    const [modelsError, setModelsError] = useState<string | null>(null);

    // Fetch models from API
    useEffect(() => {
        async function fetchModels() {
            try {
                const response = await fetch('/api/models');
                if (!response.ok) {
                    throw new Error(`Failed to fetch models: ${response.status}`);
                }
                const data = await response.json();
                if (!Array.isArray(data) || data.length === 0) {
                    throw new Error('No models available from API');
                }
                setAvailableModels(data);
                setModel(data[0]?.id || '');
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to load models';
                setModelsError(message);
                console.error('[StateInspector] Models fetch failed:', message);
            }
        }
        fetchModels();
    }, []);

    // State schema fields
    const [fields, setFields] = useState<StateField[]>([
        { name: 'messages', type: 'array', value: [] },
        { name: 'current_step', type: 'string', value: 'start' },
        { name: 'context', type: 'object', value: {} },
        { name: 'outputs', type: 'object', value: {} },
        { name: 'scratchpad', type: 'string', value: '' },
        { name: 'artifacts', type: 'array', value: [] },
    ]);

    // Trace steps
    const [traceSteps, setTraceSteps] = useState<TraceStep[]>([]);

    // Cost estimate
    const [costEstimate, setCostEstimate] = useState<CostEstimate>({
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        model: '',
    });

    const updateField = (index: number, updates: Partial<StateField>) => {
        setFields(prev => prev.map((f, i) => i === index ? { ...f, ...updates } : f));
    };

    const addField = () => {
        setFields(prev => [...prev, { name: '', type: 'string', value: '' }]);
    };

    const removeField = (index: number) => {
        setFields(prev => prev.filter((_, i) => i !== index));
    };

    // Simulate workflow run for demo
    const simulateRun = async () => {
        // Require models to be loaded
        if (modelsError) {
            console.error('[StateInspector] Cannot simulate: models failed to load');
            return;
        }
        const selectedModel = availableModels.find(m => m.id === model);
        if (!selectedModel) {
            console.error('[StateInspector] Cannot simulate: no model selected');
            return;
        }

        setIsRunning(true);
        setTraceSteps([]);

        // Use actual workflow nodes if provided, otherwise fallback to demo
        const nodeNames = workflowNodes.length > 0
            ? workflowNodes.map(n => n.data?.label || n.id)
            : ['researcher', 'planner', 'coder', 'reviewer'];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        // Get model prices (default to reasonable values if not set)
        const inputPrice = selectedModel.input_price ?? 0.001;
        const outputPrice = selectedModel.output_price ?? 0.003;

        for (const nodeName of nodeNames) {
            const stepId = `step-${Date.now()}`;

            // Add pending step
            setTraceSteps(prev => [...prev, {
                id: stepId,
                node: nodeName,
                action: 'processing',
                timestamp: Date.now(),
                status: 'running',
            }]);

            // Simulate processing
            await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));

            // Update to success with metrics
            const inputTokens = Math.floor(500 + Math.random() * 1500);
            const outputTokens = Math.floor(200 + Math.random() * 800);
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;

            const stepCost = (inputTokens * inputPrice + outputTokens * outputPrice) / 1000;

            setTraceSteps(prev => prev.map(s =>
                s.id === stepId ? {
                    ...s,
                    status: 'success',
                    duration: Math.floor(500 + Math.random() * 1000),
                    inputTokens,
                    outputTokens,
                    cost: stepCost,
                } : s
            ));

            // Flash a random field as "changed"
            const randomIndex = Math.floor(Math.random() * fields.length);
            setFields(prev => prev.map((f, i) =>
                i === randomIndex ? { ...f, changed: true } : f
            ));
            setTimeout(() => {
                setFields(prev => prev.map((f, i) =>
                    i === randomIndex ? { ...f, changed: false } : f
                ));
            }, 1500);
        }

        // Update cost estimate
        setCostEstimate({
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalCost: (totalInputTokens * inputPrice + totalOutputTokens * outputPrice) / 1000,
            model,
        });

        setIsRunning(false);
    };

    const tabs = [
        { id: 'state', label: 'State', icon: <Code size={14} /> },
        { id: 'trace', label: 'Trace', icon: <Activity size={14} /> },
        { id: 'cost', label: 'Cost', icon: <DollarSign size={14} /> },
    ];

    return (
        <div className={`state-inspector ${className} ${isExpanded ? 'expanded' : 'collapsed'}`}>
            {/* Header */}
            <div className="inspector-header">
                <button className="toggle-btn" onClick={() => setIsExpanded(!isExpanded)}>
                    <Eye size={16} />
                    <span>State Inspector</span>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>

                {isExpanded && (
                    <div className="header-actions">
                        <button
                            className={`sim-btn ${isRunning ? 'running' : ''}`}
                            onClick={simulateRun}
                            disabled={isRunning}
                        >
                            {isRunning ? <Pause size={12} /> : <Play size={12} />}
                            {isRunning ? 'Running...' : 'Simulate'}
                        </button>
                    </div>
                )}
            </div>

            {/* Content */}
            {isExpanded && (
                <div className="inspector-content">
                    {/* Tabs */}
                    <div className="tab-bar">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                className={`tab ${activeTab === tab.id ? 'active' : ''}`}
                                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                            >
                                {tab.icon}
                                <span>{tab.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* Tab Content */}
                    <div className="tab-content">
                        {activeTab === 'state' && (
                            <SchemaEditor
                                fields={fields}
                                onUpdate={updateField}
                                onAdd={addField}
                                onRemove={removeField}
                            />
                        )}
                        {activeTab === 'trace' && (
                            <TraceViewer steps={traceSteps} isRunning={isRunning} />
                        )}
                        {activeTab === 'cost' && (
                            <CostPanel
                                estimate={costEstimate}
                                model={model}
                                onModelChange={setModel}
                                models={availableModels}
                                error={modelsError}
                            />
                        )}
                    </div>
                </div>
            )}

            <style jsx>{`
                .state-inspector {
                    background: #12121f;
                    border-top: 1px solid #2a2a40;
                    transition: all 0.3s ease;
                }

                .inspector-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 16px;
                    background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), transparent);
                }

                .toggle-btn {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: none;
                    border: none;
                    color: #fff;
                    font-size: 0.85rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: color 0.2s;
                }

                .toggle-btn:hover {
                    color: #6366f1;
                }

                .header-actions {
                    display: flex;
                    gap: 8px;
                }

                .sim-btn {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 6px 12px;
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    border: none;
                    border-radius: 6px;
                    color: white;
                    font-size: 0.7rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .sim-btn:hover:not(:disabled) {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
                }

                .sim-btn.running {
                    background: linear-gradient(135deg, #f59e0b, #d97706);
                }

                .sim-btn:disabled {
                    opacity: 0.7;
                    cursor: not-allowed;
                }

                .inspector-content {
                    padding: 0 16px 16px;
                }

                .tab-bar {
                    display: flex;
                    gap: 4px;
                    margin-bottom: 12px;
                    padding: 4px;
                    background: #1a1a2e;
                    border-radius: 8px;
                }

                .tab {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    padding: 8px;
                    background: transparent;
                    border: none;
                    border-radius: 6px;
                    color: #888;
                    font-size: 0.7rem;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .tab:hover {
                    color: #fff;
                }

                .tab.active {
                    background: #2a2a40;
                    color: #6366f1;
                }

                .collapsed .inspector-content {
                    display: none;
                }
            `}</style>
        </div>
    );
}
