'use client';

/**
 * Node Property Renderer - Phase 9: Advanced Parameter UI
 * 
 * Dynamically renders form inputs based on node property schemas from the Python backend.
 * Mirrors n8n's Node Details View (NDV) parameter panel.
 * 
 * Features:
 * - Type-specific inputs (string, number, boolean, options, json, code, modelSelector)
 * - Conditional display (show/hide based on other values)
 * - Collection/FixedCollection for nested repeatable groups
 * - MultiOptions for checkbox lists
 * - Dynamic model fetching from API
 * - Expression mode toggle with {{ expression }} support
 * - Monaco code editor for JSON/code properties
 * 
 * Reference: packages/editor-ui/src/components/ParameterInput.vue
 */

import React, { useState, useCallback, useEffect, Suspense } from 'react';
import dynamic from 'next/dynamic';

// Dynamically import Monaco to avoid SSR issues
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then(mod => mod.default), {
    ssr: false,
    loading: () => <div className="monaco-loading">Loading editor...</div>
});

// ═══════════════════════════════════════════════════════════════════════════
// TYPES (mirrors nodes/core/schema.py)
// ═══════════════════════════════════════════════════════════════════════════

export type PropertyType =
    | 'string'
    | 'number'
    | 'boolean'
    | 'options'
    | 'multiOptions'
    | 'collection'
    | 'json'
    | 'code'
    | 'modelSelector'
    | 'fixedCollection'
    | 'prompt';

export interface PropertyOption {
    name: string;
    value: string | number | boolean;
    description?: string;
}

export interface TypeOptions {
    rows?: number;
    password?: boolean;
    minValue?: number;
    maxValue?: number;
    placeholder?: string;
    editor?: string;
}

export interface DisplayCondition {
    show?: Record<string, any[]>;
    hide?: Record<string, any[]>;
}

export interface NodeProperty {
    displayName: string;
    name: string;
    type: PropertyType;
    default: any;
    description?: string;
    hint?: string;
    placeholder?: string;
    required?: boolean;
    options?: PropertyOption[];
    typeOptions?: TypeOptions;
    displayOptions?: DisplayCondition;
    properties?: NodeProperty[]; // For nested collections
}

// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY RENDERERS
// ═══════════════════════════════════════════════════════════════════════════

export interface PropertyInputProps {
    property: NodeProperty;
    value: any;
    onChange: (name: string, value: any) => void;
    allValues: Record<string, any>;
}

function StringInput({ property, value, onChange }: PropertyInputProps) {
    const rows = property.typeOptions?.rows;
    const isPassword = property.typeOptions?.password;

    const commonProps = {
        className: "property-input",
        placeholder: property.placeholder || property.hint || '',
        value: value ?? property.default ?? '',
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            onChange(property.name, e.target.value),
    };

    if (rows && rows > 1) {
        return (
            <textarea
                {...commonProps}
                rows={rows}
                className="property-input property-textarea"
            />
        );
    }

    return (
        <input
            type={isPassword ? 'password' : 'text'}
            {...commonProps}
        />
    );
}

function NumberInput({ property, value, onChange }: PropertyInputProps) {
    const min = property.typeOptions?.minValue;
    const max = property.typeOptions?.maxValue;

    return (
        <input
            type="number"
            className="property-input"
            min={min}
            max={max}
            value={value ?? property.default ?? 0}
            onChange={(e) => onChange(property.name, parseFloat(e.target.value) || 0)}
        />
    );
}

function BooleanInput({ property, value, onChange }: PropertyInputProps) {
    const checked = value ?? property.default ?? false;

    return (
        <label className="property-toggle">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(property.name, e.target.checked)}
            />
            <span className="toggle-slider" />
            <span className="toggle-label">{checked ? 'Enabled' : 'Disabled'}</span>
        </label>
    );
}

function OptionsInput({ property, value, onChange }: PropertyInputProps) {
    const options = property.options || [];
    const selected = value ?? property.default ?? (options[0]?.value ?? '');

    return (
        <select
            className="property-input property-select"
            value={selected}
            onChange={(e) => onChange(property.name, e.target.value)}
        >
            {options.map((opt) => (
                <option key={String(opt.value)} value={String(opt.value)}>
                    {opt.name}
                </option>
            ))}
        </select>
    );
}

function JsonInput({ property, value, onChange }: PropertyInputProps) {
    const jsonStr = typeof value === 'string' ? value : JSON.stringify(value ?? property.default ?? {}, null, 2);

    return (
        <textarea
            className="property-input property-textarea property-code"
            rows={6}
            value={jsonStr}
            onChange={(e) => {
                try {
                    const parsed = JSON.parse(e.target.value);
                    onChange(property.name, parsed);
                } catch {
                    // Keep as string if invalid JSON
                    onChange(property.name, e.target.value);
                }
            }}
        />
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// MONACO CODE EDITOR (for code/json types)
// ═══════════════════════════════════════════════════════════════════════════

export function MonacoCodeInput({ property, value, onChange }: PropertyInputProps) {
    const language = property.type === 'json' ? 'json' :
        property.typeOptions?.editor === 'jsEditor' ? 'javascript' :
            property.typeOptions?.editor === 'htmlEditor' ? 'html' :
                property.typeOptions?.editor === 'cssEditor' ? 'css' :
                    property.typeOptions?.editor === 'sqlEditor' ? 'sql' : 'javascript';

    const codeValue = typeof value === 'string'
        ? value
        : JSON.stringify(value ?? property.default ?? '', null, 2);

    return (
        <div className="monaco-wrapper">
            <MonacoEditor
                height="200px"
                language={language}
                theme="vs-dark"
                value={codeValue}
                onChange={(newValue) => {
                    if (property.type === 'json' && newValue) {
                        try {
                            const parsed = JSON.parse(newValue);
                            onChange(property.name, parsed);
                        } catch {
                            onChange(property.name, newValue);
                        }
                    } else {
                        onChange(property.name, newValue ?? '');
                    }
                }}
                options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: 'off',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                    wordWrap: 'on',
                    padding: { top: 8, bottom: 8 },
                }}
            />
            <style jsx>{`
                .monaco-wrapper {
                    border: 1px solid #3d3d5c;
                    border-radius: 6px;
                    overflow: hidden;
                }
                :global(.monaco-loading) {
                    height: 200px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: #1e1e2e;
                    color: #666;
                    font-size: 0.85rem;
                }
            `}</style>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESSION TOGGLE WRAPPER
// ═══════════════════════════════════════════════════════════════════════════

interface ExpressionWrapperProps {
    property: NodeProperty;
    value: any;
    onChange: (name: string, value: any) => void;
    allValues: Record<string, any>;
    children: (isExpression: boolean, expressionValue: string, setExpressionValue: (v: string) => void) => React.ReactNode;
}

function ExpressionWrapper({ property, value, onChange, children }: ExpressionWrapperProps) {
    // Check if current value is an expression (starts with {{ or =)
    const isExpressionValue = typeof value === 'string' && (value.startsWith('{{') || value.startsWith('='));
    const [isExpressionMode, setIsExpressionMode] = useState(isExpressionValue);
    const [expressionValue, setExpressionValue] = useState(
        isExpressionValue ? value : `{{ $json.${property.name} }}`
    );

    const toggleMode = () => {
        if (isExpressionMode) {
            // Switching to fixed mode - clear value or keep last fixed value
            onChange(property.name, property.default ?? '');
        } else {
            // Switching to expression mode
            onChange(property.name, expressionValue);
        }
        setIsExpressionMode(!isExpressionMode);
    };

    const handleExpressionChange = (newExpr: string) => {
        setExpressionValue(newExpr);
        onChange(property.name, newExpr);
    };

    return (
        <div className="expression-wrapper">
            <div className="expression-toggle-row">
                <button
                    type="button"
                    className={`expression-toggle-btn ${isExpressionMode ? 'active' : ''}`}
                    onClick={toggleMode}
                    title={isExpressionMode ? 'Switch to fixed value' : 'Switch to expression'}
                >
                    <span className="toggle-icon">{isExpressionMode ? '{ }' : 'fx'}</span>
                </button>
            </div>
            <div className="expression-content">
                {isExpressionMode ? (
                    <div className="expression-input-wrapper">
                        <input
                            type="text"
                            className="property-input expression-input"
                            value={expressionValue}
                            onChange={(e) => handleExpressionChange(e.target.value)}
                            placeholder="{{ $json.fieldName }}"
                        />
                        <span className="expression-hint">Use {"{{ }}"} for dynamic values</span>
                    </div>
                ) : (
                    children(isExpressionMode, expressionValue, handleExpressionChange)
                )}
            </div>
            <style jsx>{`
                .expression-wrapper {
                    position: relative;
                }
                .expression-toggle-row {
                    position: absolute;
                    right: 0;
                    top: -24px;
                    z-index: 1;
                }
                .expression-toggle-btn {
                    background: #2a2a4a;
                    border: 1px solid #3d3d5c;
                    color: #888;
                    padding: 2px 6px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.7rem;
                    font-family: monospace;
                    transition: all 0.2s;
                }
                .expression-toggle-btn:hover {
                    border-color: #6366f1;
                    color: #6366f1;
                }
                .expression-toggle-btn.active {
                    background: #6366f1;
                    border-color: #6366f1;
                    color: white;
                }
                .toggle-icon {
                    font-weight: bold;
                }
                .expression-content {
                    /* Content area */
                }
                .expression-input-wrapper {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                :global(.expression-input) {
                    font-family: 'Fira Code', monospace;
                    background: #1a1a2e;
                    border-color: #6366f1 !important;
                }
                .expression-hint {
                    font-size: 0.7rem;
                    color: #6366f1;
                }
            `}</style>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// COLLECTION INPUT (Nested Repeatable Groups)
// ═══════════════════════════════════════════════════════════════════════════

function CollectionInput({ property, value, onChange, allValues }: PropertyInputProps) {
    const nestedProperties = property.properties || [];
    const items: Record<string, any>[] = Array.isArray(value) ? value : [];

    const addItem = () => {
        const newItem: Record<string, any> = {};
        nestedProperties.forEach(p => {
            newItem[p.name] = p.default ?? '';
        });
        onChange(property.name, [...items, newItem]);
    };

    const removeItem = (index: number) => {
        onChange(property.name, items.filter((_, i) => i !== index));
    };

    const updateItem = (index: number, propName: string, propValue: any) => {
        const updated = items.map((item, i) =>
            i === index ? { ...item, [propName]: propValue } : item
        );
        onChange(property.name, updated);
    };

    return (
        <div className="collection-container">
            {items.map((item, index) => (
                <div key={index} className="collection-item">
                    <div className="collection-item-header">
                        <span className="collection-item-index">#{index + 1}</span>
                        <button
                            type="button"
                            className="collection-remove-btn"
                            onClick={() => removeItem(index)}
                        >
                            ✕
                        </button>
                    </div>
                    <div className="collection-item-fields">
                        {nestedProperties.map(nestedProp => (
                            <NodePropertyRenderer
                                key={nestedProp.name}
                                property={nestedProp}
                                value={item[nestedProp.name]}
                                allValues={item}
                                onChange={(name, val) => updateItem(index, name, val)}
                            />
                        ))}
                    </div>
                </div>
            ))}
            <button type="button" className="collection-add-btn" onClick={addItem}>
                + Add {property.displayName}
            </button>
            <style jsx>{`
                .collection-container {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .collection-item {
                    background: rgba(30, 30, 50, 0.5);
                    border: 1px solid #3d3d5c;
                    border-radius: 8px;
                    padding: 12px;
                }
                .collection-item-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 10px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid #3d3d5c;
                }
                .collection-item-index {
                    font-size: 0.75rem;
                    color: #6366f1;
                    font-weight: 600;
                }
                .collection-remove-btn {
                    background: transparent;
                    border: none;
                    color: #ef4444;
                    cursor: pointer;
                    font-size: 0.8rem;
                    padding: 2px 6px;
                    border-radius: 4px;
                }
                .collection-remove-btn:hover {
                    background: rgba(239, 68, 68, 0.2);
                }
                .collection-item-fields {
                    /* Nested fields render here */
                }
                .collection-add-btn {
                    background: transparent;
                    border: 2px dashed #3d3d5c;
                    color: #6366f1;
                    padding: 10px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 0.85rem;
                    transition: all 0.2s;
                }
                .collection-add-btn:hover {
                    border-color: #6366f1;
                    background: rgba(99, 102, 241, 0.1);
                }
            `}</style>
        </div>
    );
}


// ═══════════════════════════════════════════════════════════════════════════
// FIXED COLLECTION INPUT (Single nested object)
// ═══════════════════════════════════════════════════════════════════════════

function FixedCollectionInput({ property, value, onChange, allValues }: PropertyInputProps) {
    const nestedProperties = property.properties || [];
    const item: Record<string, any> = (typeof value === 'object' && value !== null && !Array.isArray(value))
        ? value
        : {};

    const updateItem = (propName: string, propValue: any) => {
        onChange(property.name, { ...item, [propName]: propValue });
    };

    return (
        <div className="fixed-collection-container">
            <div className="collection-item-fields">
                {nestedProperties.map(nestedProp => (
                    <NodePropertyRenderer
                        key={nestedProp.name}
                        property={nestedProp}
                        value={item[nestedProp.name]}
                        allValues={item}
                        onChange={(name, val) => updateItem(name, val)}
                    />
                ))}
            </div>
            <style jsx>{`
                .fixed-collection-container {
                    border: 1px solid #3d3d5c;
                    border-radius: 8px;
                    padding: 12px;
                    background: rgba(30, 30, 50, 0.3);
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
            `}</style>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// MULTIOPTIONS INPUT
// ═══════════════════════════════════════════════════════════════════════════

function MultiOptionsInput({ property, value, onChange }: PropertyInputProps) {
    const options = property.options || [];
    const selectedValues: (string | number | boolean)[] = Array.isArray(value)
        ? value
        : (value ? [value] : []);

    const toggleOption = (optValue: string | number | boolean) => {
        console.log('[MultiOptionsInput] Toggle:', optValue, 'Current values:', selectedValues);
        if (selectedValues.includes(optValue)) {
            const newValues = selectedValues.filter(v => v !== optValue);
            console.log('[MultiOptionsInput] Removing, new values:', newValues);
            onChange(property.name, newValues);
        } else {
            const newValues = [...selectedValues, optValue];
            console.log('[MultiOptionsInput] Adding, new values:', newValues);
            onChange(property.name, newValues);
        }
    };

    return (
        <div className="multi-options-container">
            {options.map((opt) => (
                <label key={String(opt.value)} className="multi-option-item">
                    <input
                        type="checkbox"
                        checked={selectedValues.includes(opt.value)}
                        onChange={() => toggleOption(opt.value)}
                    />
                    <span className="multi-option-checkbox" />
                    <span className="multi-option-label">{opt.name}</span>
                </label>
            ))}
            <style jsx>{`
                .multi-options-container {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .multi-option-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    padding: 6px 10px;
                    background: #1a1a2e;
                    border: 1px solid #3d3d5c;
                    border-radius: 6px;
                    transition: all 0.2s;
                }
                .multi-option-item:hover {
                    border-color: #6366f1;
                }
                .multi-option-item input {
                    display: none;
                }
                .multi-option-checkbox {
                    width: 18px;
                    height: 18px;
                    border: 2px solid #5c5c8a;
                    border-radius: 4px;
                    position: relative;
                    transition: all 0.2s;
                }
                .multi-option-item input:checked + .multi-option-checkbox {
                    background: #6366f1;
                    border-color: #6366f1;
                }
                .multi-option-item input:checked + .multi-option-checkbox::after {
                    content: '✓';
                    position: absolute;
                    color: white;
                    font-size: 12px;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                }
                .multi-option-label {
                    flex: 1;
                    font-size: 0.85rem;
                    color: #e0e0e0;
                }
            `}</style>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL SELECTOR INPUT
// ═══════════════════════════════════════════════════════════════════════════

export function ModelSelectorInput({ property, value, onChange }: PropertyInputProps) {
    const [models, setModels] = useState<{ name: string; value: string }[]>([
        { name: 'Gemini Flash', value: 'gemini-3-flash-preview' },
        { name: 'Gemini Pro', value: 'gemini-3-pro-preview' },
        { name: 'Claude Opus', value: 'claude-sonnet-4-20250514' },
        { name: 'GPT-4', value: 'gpt-4-turbo-preview' },
    ]);
    const [loading, setLoading] = useState(false);

    // Fetch models from API on mount
    useEffect(() => {
        async function fetchModels() {
            try {
                setLoading(true);
                const res = await fetch('/api/models');
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data) && data.length > 0) {
                        setModels(data.map((m: any) => ({
                            name: m.display_name || m.name || m.id,
                            value: m.id || m.name
                        })));
                    }
                }
            } catch (e) {
                console.warn('Could not fetch models from API, using defaults');
            } finally {
                setLoading(false);
            }
        }
        fetchModels();
    }, []);

    // Use empty string to represent "use default" (no override)
    const selected = value === undefined || value === null || value === '' ? '' : value;

    return (
        <div className="model-selector-wrapper">
            <select
                className="property-input property-select model-selector"
                value={selected}
                onChange={(e) => {
                    const val = e.target.value;
                    // If "use default" is selected, pass empty string to clear the override
                    onChange(property.name, val === '' ? '' : val);
                }}
                disabled={loading}
                title="Override the agent's default model for this workflow node only"
            >
                {loading ? (
                    <option value="">Loading models...</option>
                ) : (
                    <>
                        <option value="">Use Default (from Agent Manager)</option>
                        <option disabled>──────────</option>
                        {models.map((m) => (
                            <option key={m.value} value={m.value}>
                                {m.name}
                            </option>
                        ))}
                    </>
                )}
            </select>
            {loading && <span className="model-loading-indicator" />}
            {selected === '' && (
                <div className="default-hint">
                    Using agent&apos;s default model
                </div>
            )}
            <style jsx>{`
                .model-selector-wrapper {
                    position: relative;
                }
                .model-loading-indicator {
                    position: absolute;
                    right: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 12px;
                    height: 12px;
                    border: 2px solid #6366f1;
                    border-top-color: transparent;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                }
                .default-hint {
                    margin-top: 4px;
                    font-size: 0.7rem;
                    color: #10b981;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .default-hint::before {
                    content: '✓';
                    font-weight: bold;
                }
                @keyframes spin {
                    to { transform: translateY(-50%) rotate(360deg); }
                }
            `}</style>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RENDERER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

function shouldShowProperty(
    property: NodeProperty,
    allValues: Record<string, any>
): boolean {
    const displayOptions = property.displayOptions;
    if (!displayOptions) return true;

    // Check show conditions
    if (displayOptions.show) {
        for (const [key, allowedValues] of Object.entries(displayOptions.show)) {
            const currentValue = allValues[key];
            if (!allowedValues.includes(currentValue)) {
                return false;
            }
        }
    }

    // Check hide conditions
    if (displayOptions.hide) {
        for (const [key, hiddenValues] of Object.entries(displayOptions.hide)) {
            const currentValue = allValues[key];
            if (hiddenValues.includes(currentValue)) {
                return false;
            }
        }
    }

    return true;
}

interface NodePropertyRendererProps {
    property: NodeProperty;
    value: any;
    allValues: Record<string, any>;
    onChange: (name: string, value: any) => void;
}

export function NodePropertyRenderer({
    property,
    value,
    allValues,
    onChange,
}: NodePropertyRendererProps) {
    // Check display conditions
    if (!shouldShowProperty(property, allValues)) {
        return null;
    }

    const renderInput = () => {
        const inputProps = { property, value, onChange, allValues };

        switch (property.type) {
            case 'string':
            case 'prompt':
                // Wrap string inputs with expression toggle
                return (
                    <ExpressionWrapper {...inputProps}>
                        {() => <StringInput {...inputProps} />}
                    </ExpressionWrapper>
                );
            case 'number':
                return (
                    <ExpressionWrapper {...inputProps}>
                        {() => <NumberInput {...inputProps} />}
                    </ExpressionWrapper>
                );
            case 'boolean':
                return <BooleanInput {...inputProps} />;
            case 'options':
                return <OptionsInput {...inputProps} />;
            case 'multiOptions':
                return <MultiOptionsInput {...inputProps} />;
            case 'collection':
                return <CollectionInput {...inputProps} />;
            case 'fixedCollection':
                return <FixedCollectionInput {...inputProps} />;
            case 'json':
                return <MonacoCodeInput {...inputProps} />;
            case 'code':
                return <MonacoCodeInput {...inputProps} />;
            case 'modelSelector':
                return <ModelSelectorInput {...inputProps} />;
            default:
                return <StringInput {...inputProps} />;
        }
    };

    return (
        <div className="property-field">
            <label className="property-label">
                {property.displayName}
                {property.required && <span className="required-star">*</span>}
            </label>
            {renderInput()}
            {property.description && (
                <span className="property-description">{property.description}</span>
            )}

            <style jsx>{`
                .property-field {
                    margin-bottom: 16px;
                }
                
                .property-label {
                    display: block;
                    font-size: 0.8rem;
                    font-weight: 500;
                    color: #a0a0a0;
                    margin-bottom: 6px;
                }
                
                .required-star {
                    color: #ef4444;
                    margin-left: 4px;
                }
                
                :global(.property-input) {
                    width: 100%;
                    padding: 8px 12px;
                    background: #1e1e2e;
                    border: 1px solid #3d3d5c;
                    border-radius: 6px;
                    color: #fff;
                    font-size: 0.85rem;
                    transition: border-color 0.2s;
                }
                
                :global(.property-input:focus) {
                    outline: none;
                    border-color: #6366f1;
                }
                
                :global(.property-textarea) {
                    font-family: inherit;
                    resize: vertical;
                    min-height: 60px;
                }
                
                :global(.property-code) {
                    font-family: 'Fira Code', 'Monaco', monospace;
                    font-size: 0.75rem;
                    background: #0d0d14;
                }
                
                :global(.property-select) {
                    cursor: pointer;
                    appearance: none;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236366f1' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
                    background-repeat: no-repeat;
                    background-position: right 12px center;
                    padding-right: 36px;
                }
                
                :global(.model-selector) {
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
                }
                
                .property-toggle {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    cursor: pointer;
                }
                
                .property-toggle input {
                    display: none;
                }
                
                .toggle-slider {
                    width: 40px;
                    height: 22px;
                    background: #3d3d5c;
                    border-radius: 11px;
                    position: relative;
                    transition: background 0.2s;
                }
                
                .toggle-slider::after {
                    content: '';
                    position: absolute;
                    width: 18px;
                    height: 18px;
                    background: #fff;
                    border-radius: 50%;
                    top: 2px;
                    left: 2px;
                    transition: transform 0.2s;
                }
                
                .property-toggle input:checked + .toggle-slider {
                    background: #6366f1;
                }
                
                .property-toggle input:checked + .toggle-slider::after {
                    transform: translateX(18px);
                }
                
                .toggle-label {
                    font-size: 0.8rem;
                    color: #888;
                }
                
                .property-description {
                    display: block;
                    font-size: 0.7rem;
                    color: #666;
                    margin-top: 4px;
                }
            `}</style>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG PANEL COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

interface NodeConfigPanelProps {
    nodeId: string;
    nodeName: string;
    nodeIcon?: string;
    properties: NodeProperty[];
    values: Record<string, any>;
    onChange: (values: Record<string, any>) => void;
    onClose?: () => void;
}

export function NodeConfigPanel({
    nodeId,
    nodeName,
    nodeIcon = '⚙️',
    properties,
    values,
    onChange,
    onClose,
}: NodeConfigPanelProps) {
    // Use local state to track values immediately, sync from props
    const [localValues, setLocalValues] = useState<Record<string, any>>(values);

    // Sync local state when props change (e.g., when switching nodes)
    useEffect(() => {
        setLocalValues(values);
    }, [nodeId, values]);

    const handlePropertyChange = useCallback((name: string, value: any) => {
        const newValues = {
            ...localValues,
            [name]: value,
        };
        setLocalValues(newValues);  // Update local state immediately
        onChange(newValues);        // Propagate to parent
    }, [localValues, onChange]);

    return (
        <div className="config-panel">
            <div className="config-header">
                <div className="config-title">
                    <span className="config-icon">{nodeIcon}</span>
                    <span>{nodeName}</span>
                </div>
                {onClose && (
                    <button className="close-btn" onClick={onClose}>
                        ✕
                    </button>
                )}
            </div>

            <div className="config-body">
                {properties.map((property) => (
                    <NodePropertyRenderer
                        key={property.name}
                        property={property}
                        value={localValues[property.name]}
                        allValues={localValues}
                        onChange={handlePropertyChange}
                    />
                ))}

                {properties.length === 0 && (
                    <div className="no-properties">
                        No configurable properties
                    </div>
                )}
            </div>

            <style jsx>{`
                .config-panel {
                    background: linear-gradient(180deg, #16162a 0%, #1a1a2e 100%);
                    border: 1px solid #3d3d5c;
                    border-radius: 12px;
                    overflow: hidden;
                    width: 320px;
                    max-height: 500px;
                    display: flex;
                    flex-direction: column;
                }
                
                .config-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 16px;
                    background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, transparent 50%);
                    border-bottom: 1px solid #3d3d5c;
                }
                
                .config-title {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-weight: 600;
                    color: #fff;
                }
                
                .config-icon {
                    font-size: 1.2rem;
                }
                
                .close-btn {
                    background: transparent;
                    border: none;
                    color: #666;
                    cursor: pointer;
                    font-size: 1rem;
                    padding: 4px;
                    border-radius: 4px;
                }
                
                .close-btn:hover {
                    color: #fff;
                    background: rgba(255, 255, 255, 0.1);
                }
                
                .config-body {
                    padding: 16px;
                    overflow-y: auto;
                    flex: 1;
                }
                
                .no-properties {
                    color: #666;
                    font-size: 0.85rem;
                    text-align: center;
                    padding: 20px;
                }
            `}</style>
        </div>
    );
}

export default NodePropertyRenderer;
