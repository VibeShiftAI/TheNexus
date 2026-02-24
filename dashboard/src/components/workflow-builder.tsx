'use client';

/**
 * WorkflowBuilder - Visual workflow editor using React Flow
 * 
 * This component allows users to visually design agent workflows
 * by dragging and dropping nodes, connecting them with edges,
 * and configuring each node's behavior.
 */

import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  BackgroundVariant,
  Panel,
  NodeTypes,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Import custom node components
import { ResearcherNode } from './workflow-nodes/researcher-node';
import { PlannerNode } from './workflow-nodes/planner-node';
import { CoderNode } from './workflow-nodes/coder-node';
import { ReviewerNode } from './workflow-nodes/reviewer-node';
import { SupervisorNode } from './workflow-nodes/supervisor-node';
import { FleetNode } from './workflow-nodes/fleet-node';
import { AgentNode } from './workflow-nodes/agent-node';
import { getNodeTypes, saveTemplate } from '@/lib/nexus';

// Import Tool Dock for MCP tool binding (Nexus Protocol Phase 2)
import { ToolDock } from './tool-dock';

// === Nexus Protocol Phase 4 ===
import { ProcessorCard } from './workflow-nodes/processor-card';
import { ActionNode } from './workflow-nodes/action-node';
import { SuperNode } from './workflow-nodes/super-node';
import {
  ConditionalEdge,
  SuccessEdge,
  FailureEdge,
  RetryEdge,
} from './workflow-nodes/conditional-edge';

// === n8n-Inspired Node System (Phase 3.6) ===
import { NodeConfigPanel, NodeProperty } from './workflow-nodes/node-config-panel';
import { useNodeSchema } from '@/hooks/useNodeSchema';

// === Nexus Protocol Phase 5 ===
import { StateInspector } from './state-inspector';

// ═══════════════════════════════════════════════════════════════════════════
// NodeConfigPanelWrapper - Fetches schema from backend for selected node
// ═══════════════════════════════════════════════════════════════════════════

interface NodeConfigPanelWrapperProps {
  selectedNode: Node;
  onDelete: () => void;
  onConfigChange: (config: Record<string, unknown>) => void;
  onClose: () => void;
}

function NodeConfigPanelWrapper({ selectedNode, onDelete, onConfigChange, onClose }: NodeConfigPanelWrapperProps) {
  // Use shared hook for schema fetching
  const { properties, loading, error } = useNodeSchema(selectedNode.type);

  const nodeConfig = (selectedNode.data as Record<string, unknown>)?.config as Record<string, unknown> || {};

  if (loading) {
    return (
      <div className="node-config-panel" style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
        Loading configuration...
      </div>
    );
  }

  if (error) {
    return (
      <div className="node-config-panel" style={{ padding: '20px' }}>
        <div style={{
          padding: '16px',
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '8px',
          color: '#f87171',
          marginBottom: '16px'
        }}>
          <strong>Error:</strong> {error}
        </div>
        <button
          className="btn btn-danger btn-sm"
          style={{ width: '100%' }}
          onClick={onDelete}
        >
          🗑️ Delete Node
        </button>
      </div>
    );
  }

  return (
    <div className="node-config-panel">
      <NodeConfigPanel
        nodeId={selectedNode.id}
        nodeName={String((selectedNode.data as Record<string, unknown>)?.label || selectedNode.type)}
        nodeIcon={String((selectedNode.data as Record<string, unknown>)?.icon || '⚙️')}
        properties={properties}
        values={nodeConfig}
        onChange={onConfigChange}
        onClose={onClose}
      />
      <button
        className="btn btn-danger btn-sm"
        style={{ marginTop: '12px', width: '100%' }}
        onClick={onDelete}
      >
        🗑️ Delete Node
      </button>
    </div>
  );
}

const BUILTIN_NODE_TYPES: NodeTypes = {
  researcher: ResearcherNode,
  planner: PlannerNode,
  coder: CoderNode,
  reviewer: ReviewerNode,
  supervisor: SupervisorNode,
  fleet: FleetNode,
  // Nexus Protocol Phase 4
  processor: ProcessorCard,
  action: ActionNode,
  supernode: SuperNode,
};

// Custom edge types for conditional flows
const EDGE_TYPES = {
  conditional: ConditionalEdge,
  success: SuccessEdge,
  failure: FailureEdge,
  retry: RetryEdge,
};

// No default palette - nodes come from backend only
const DEFAULT_PALETTE: { type: string; label: string; icon: string; description: string }[] = [];

// Initial nodes for a new workflow
const initialNodes: Node[] = [];
const initialEdges: Edge[] = [];

interface WorkflowBuilderProps {
  workflowId?: string;
  projectId?: string;
  taskId?: string;
  templateName?: string;
  initialNodes?: Node[];
  initialEdges?: Edge[];
  onSave?: (graphConfig: { nodes: Node[]; edges: Edge[] }) => void;
  onRun?: (graphConfig: { nodes: Node[]; edges: Edge[] }) => void;
  onTemplateNameChange?: (name: string) => void;
}

export function WorkflowBuilder({
  workflowId,
  projectId,
  taskId,
  templateName: propsTemplateName,
  initialNodes: propsInitialNodes,
  initialEdges: propsInitialEdges,
  onSave,
  onRun,
  onTemplateNameChange,
}: WorkflowBuilderProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(propsInitialNodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(propsInitialEdges || []);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  // Save Template Modal State
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Template name state
  const [currentTemplateName, setCurrentTemplateName] = useState(propsTemplateName || '');
  const [isEditingTemplateName, setIsEditingTemplateName] = useState(false);

  // Workflow level state (dashboard, project, feature)
  const [workflowLevel, setWorkflowLevel] = useState<'dashboard' | 'project' | 'task'>('task');

  // Tool Dock visibility (Nexus Protocol Phase 2)
  const [showToolDock, setShowToolDock] = useState(true);

  // Dynamic node palette (fetched from backend)
  const [nodePalette, setNodePalette] = useState<{ type: string; label: string; icon: string; description: string; levels?: string[] }[]>([]);

  // Dynamic node types from backend (just the type IDs for lookup)
  const [dynamicNodeTypeIds, setDynamicNodeTypeIds] = useState<string[]>([]);

  // Fetch node types from Python backend on mount
  useEffect(() => {
    async function fetchNodeTypes() {
      try {
        const types = await getNodeTypes();

        // Build palette from fetched types
        const palette: { type: string; label: string; icon: string; description: string; levels?: string[] }[] = [];
        const dynamicNodeTypes: NodeTypes = { ...BUILTIN_NODE_TYPES };

        for (const [typeId, typeDef] of Object.entries(types)) {
          const def = typeDef as { name?: string; icon?: string; description?: string; levels?: string[] };
          palette.push({
            type: typeId,
            label: def.name || typeId,
            icon: def.icon || '🤖',
            description: def.description || '',
            levels: def.levels || ['dashboard', 'project', 'task'],
          });

          // If not a built-in type, use AgentNode
          if (!BUILTIN_NODE_TYPES[typeId]) {
            dynamicNodeTypes[typeId] = AgentNode;
          }
        }

        if (palette.length > 0) {
          setNodePalette(palette);
          // Store just the type IDs of dynamic nodes (not built-ins)
          const dynamicIds = Object.keys(types).filter(id => !BUILTIN_NODE_TYPES[id]);
          setDynamicNodeTypeIds(dynamicIds);
        }
      } catch (err) {
        console.log('[WorkflowBuilder] Using default palette (backend unavailable)');
      }
    }

    fetchNodeTypes();
  }, []);

  // Memoized nodeTypes to prevent React Flow re-render warning
  // See: https://reactflow.dev/error#002
  const nodeTypes = useMemo<NodeTypes>(() => {
    const types: NodeTypes = { ...BUILTIN_NODE_TYPES };
    // Add dynamic types (all non-builtins use AgentNode)
    for (const typeId of dynamicNodeTypeIds) {
      types[typeId] = AgentNode;
    }
    return types;
  }, [dynamicNodeTypeIds]);

  // Update nodes/edges when props change (template loaded)
  useEffect(() => {
    if (propsInitialNodes) {
      setNodes(propsInitialNodes);
    }
  }, [propsInitialNodes, setNodes]);

  useEffect(() => {
    if (propsInitialEdges) {
      setEdges(propsInitialEdges);
    }
  }, [propsInitialEdges, setEdges]);

  // Update template name when props change
  useEffect(() => {
    if (propsTemplateName !== undefined) {
      setCurrentTemplateName(propsTemplateName);
    }
  }, [propsTemplateName]);

  // Handle template name change
  const handleTemplateNameSave = () => {
    setIsEditingTemplateName(false);
    if (onTemplateNameChange) {
      onTemplateNameChange(currentTemplateName);
    }
  };

  // Handle new connections between nodes
  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({
      ...params,
      animated: true,
      style: { stroke: '#6366f1', strokeWidth: 2 },
    }, eds)),
    [setEdges]
  );

  // Handle dropping a new node from the palette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow/type');
      const label = event.dataTransfer.getData('application/reactflow/label');

      if (!type || !reactFlowInstance) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode: Node = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: { label, config: {} },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, setNodes]
  );

  // Handle node selection for config panel
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  // Handle saving the workflow as a template
  const handleSaveClick = () => {
    setSaveName(currentTemplateName || '');
    setSaveDescription('');
    setShowSaveModal(true);
  };

  const performSave = async (overwrite = false) => {
    if (!saveName) return;

    setIsSaving(true);
    try {
      await saveTemplate(saveName, saveDescription, nodes, edges, workflowLevel, overwrite);
      setShowSaveModal(false);
      alert('Template saved successfully!');
    } catch (err: any) {
      if (err.message === 'DUPLICATE_NAME') {
        if (confirm(`A template named "${saveName}" already exists. Overwrite it?`)) {
          await performSave(true);
        }
      } else {
        alert(`Error saving template: ${err.message}`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Validate the graph
  const isValidGraph = nodes.length > 0;

  return (
    <div className="workflow-builder">
      {/* Toolbar */}
      <div className="workflow-toolbar">
        <div className="toolbar-left">
          <h3>Workflow Builder</h3>
          {projectId && <span className="project-badge">Project: {projectId}</span>}

          {/* Template Name Field */}
          <div className="template-name-container">
            {isEditingTemplateName ? (
              <input
                type="text"
                value={currentTemplateName}
                onChange={(e) => setCurrentTemplateName(e.target.value)}
                onBlur={handleTemplateNameSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleTemplateNameSave();
                  if (e.key === 'Escape') {
                    setCurrentTemplateName(propsTemplateName || '');
                    setIsEditingTemplateName(false);
                  }
                }}
                className="template-name-input"
                placeholder="Template name..."
                autoFocus
              />
            ) : (
              <button
                className="template-name-display"
                onClick={() => setIsEditingTemplateName(true)}
                title="Click to edit template name"
              >
                📝 {currentTemplateName || 'Untitled Template'}
              </button>
            )}
          </div>

          {/* Workflow Level Selector */}
          <div className="level-selector">
            <button
              className={`level-btn ${workflowLevel === 'dashboard' ? 'active' : ''}`}
              onClick={() => setWorkflowLevel('dashboard')}
              title="Dashboard-level workflows run across multiple projects"
            >
              🏠 Dashboard
            </button>
            <button
              className={`level-btn ${workflowLevel === 'project' ? 'active' : ''}`}
              onClick={() => setWorkflowLevel('project')}
              title="Project-level workflows run within a single project"
            >
              📁 Project
            </button>
            <button
              className={`level-btn ${workflowLevel === 'task' ? 'active' : ''}`}
              onClick={() => setWorkflowLevel('task')}
              title="Task-level workflows implement individual tasks"
            >
              ⚡ Task
            </button>
          </div>
        </div>
        <div className="toolbar-right">
          <button
            className="btn btn-primary"
            onClick={handleSaveClick}
            disabled={!isValidGraph}
          >
            💾 Save Template
          </button>
        </div>
      </div>

      <div className="workflow-content">
        {/* Node Palette */}
        <div className="node-palette">
          <h4>Nodes</h4>
          <p className="palette-hint">Drag to canvas</p>
          {nodePalette
            .filter(node => !node.levels || node.levels.includes(workflowLevel))
            .map((node) => (
              <div
                key={node.type}
                className="palette-node"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/reactflow/type', node.type);
                  e.dataTransfer.setData('application/reactflow/label', node.label);
                  e.dataTransfer.effectAllowed = 'move';
                }}
              >
                <span className="node-icon">{node.icon}</span>
                <span className="node-label">{node.label}</span>
              </div>
            ))}
        </div>

        {/* React Flow Canvas */}
        <div className="workflow-canvas" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onInit={setReactFlowInstance}
            nodeTypes={nodeTypes}
            edgeTypes={EDGE_TYPES}
            fitView
            snapToGrid
            snapGrid={[15, 15]}
            defaultEdgeOptions={{
              animated: true,
              style: { stroke: '#6366f1', strokeWidth: 2 },
            }}
          >
            <Controls />
            <MiniMap
              nodeStrokeColor="#6366f1"
              nodeColor="#1e1e2e"
              nodeBorderRadius={8}
            />
            <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="#333" />

            {/* Empty state hint */}
            {nodes.length === 0 && (
              <Panel position="top-center">
                <div className="empty-hint">
                  <p>👈 Drag nodes from the palette to build your workflow</p>
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        {/* Node Config Panel - Dynamic Schema-Driven (Phase 3.6) */}
        {selectedNode && (
          <NodeConfigPanelWrapper
            selectedNode={selectedNode}
            onDelete={() => {
              setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
              setSelectedNode(null);
            }}
            onConfigChange={(config) => {
              setNodes((nds) =>
                nds.map((n) =>
                  n.id === selectedNode.id
                    ? { ...n, data: { ...n.data, config } }
                    : n
                )
              );
            }}
            onClose={() => setSelectedNode(null)}
          />
        )}

        {/* Tool Dock - MCP Server Management (Nexus Protocol Phase 2) */}
        {/* TODO: Future upgrades:
            - Highlight nodes that support tool binding when dragging
            - Show tool count per node
            - Auto-suggest tools based on node type (e.g., filesystem for builder)
            - Persist MCP server configs to database
        */}
        {showToolDock && (
          <ToolDock className="w-64" />
        )}
      </div>

      {/* State Inspector - Bottom Panel (Nexus Protocol Phase 5) */}
      {/* TODO: Future upgrades:
          - Connect to live Python backend execution (websocket)
          - Show real trace data during actual workflow runs
          - Persist cost estimates to usage_statistics table
          - Add breakpoint debugging support
      */}
      <StateInspector workflowId="workflow-builder" nodes={nodes} />

      {/* Save Template Modal */}
      {showSaveModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h4>Save as Template</h4>

            <div className="form-group">
              <label>Template Name</label>
              <input
                type="text"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                placeholder="e.g. Research & Plan"
                autoFocus
              />
            </div>

            <div className="form-group">
              <label>Description</label>
              <textarea
                value={saveDescription}
                onChange={e => setSaveDescription(e.target.value)}
                placeholder="What does this workflow do?"
                rows={3}
              />
            </div>

            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setShowSaveModal(false)}
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => performSave(false)}
                disabled={!saveName || isSaving}
              >
                {isSaving ? 'Saving...' : 'Save Template'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .workflow-builder {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: #0a0a0f;
          border-radius: 12px;
          overflow: hidden;
        }

        .workflow-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          background: #1e1e2e;
          border-bottom: 1px solid #333;
        }

        .toolbar-left h3 {
          margin: 0;
          font-size: 1rem;
          color: #fff;
        }

        .project-badge {
          margin-left: 12px;
          padding: 4px 8px;
          background: #6366f1;
          border-radius: 4px;
          font-size: 0.75rem;
        }

        .template-name-container {
          margin-left: 16px;
          padding-left: 16px;
          border-left: 1px solid #444;
        }

        .template-name-input {
          padding: 6px 12px;
          background: #2a2a3e;
          border: 1px solid #6366f1;
          border-radius: 6px;
          color: #fff;
          font-size: 0.875rem;
          min-width: 200px;
        }

        .template-name-input:focus {
          outline: none;
          box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3);
        }

        .template-name-display {
          padding: 6px 12px;
          background: transparent;
          border: 1px dashed #444;
          border-radius: 6px;
          color: #888;
          font-size: 0.875rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .template-name-display:hover {
          border-color: #6366f1;
          color: #fff;
          background: rgba(99, 102, 241, 0.1);
        }

        .toolbar-right {
          display: flex;
          gap: 8px;
        }

        .level-selector {
          display: flex;
          gap: 4px;
          margin-left: 16px;
          padding-left: 16px;
          border-left: 1px solid #444;
        }

        .level-btn {
          padding: 6px 12px;
          background: transparent;
          border: 1px solid #444;
          border-radius: 6px;
          color: #888;
          font-size: 0.75rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .level-btn:hover {
          border-color: #6366f1;
          color: #fff;
          background: rgba(99, 102, 241, 0.1);
        }

        .level-btn.active {
          background: #6366f1;
          border-color: #6366f1;
          color: #fff;
        }

        .btn {
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          font-size: 0.875rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-primary {
          background: #6366f1;
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: #5558dd;
        }

        .btn-secondary {
          background: #333;
          color: white;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #444;
        }

        .btn-danger {
          background: #ef4444;
          color: white;
        }

        .btn-sm {
          padding: 6px 12px;
          font-size: 0.75rem;
        }

        .workflow-content {
          display: flex;
          flex: 1;
          min-height: 0;
        }

        .node-palette {
          width: 160px;
          padding: 12px;
          background: #1e1e2e;
          border-right: 1px solid #333;
          overflow-y: auto;
        }

        .node-palette h4 {
          margin: 0 0 4px 0;
          font-size: 0.875rem;
          color: #fff;
        }

        .palette-hint {
          margin: 0 0 12px 0;
          font-size: 0.75rem;
          color: #666;
        }

        .palette-node {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          margin-bottom: 8px;
          background: #2a2a3e;
          border: 1px solid #444;
          border-radius: 8px;
          cursor: grab;
          transition: all 0.2s;
        }

        .palette-node:hover {
          background: #3a3a4e;
          border-color: #6366f1;
        }

        .palette-node:active {
          cursor: grabbing;
        }

        .node-icon {
          font-size: 1.25rem;
        }

        .node-label {
          font-size: 0.875rem;
          color: #fff;
        }

        .workflow-canvas {
          flex: 1;
          min-width: 0;
        }

        .node-config-panel {
          width: 220px;
          padding: 16px;
          background: #1e1e2e;
          border-left: 1px solid #333;
        }

        .node-config-panel h4 {
          margin: 0 0 16px 0;
          font-size: 0.875rem;
          color: #fff;
        }

        .config-field {
          margin-bottom: 12px;
        }

        .config-field label {
          display: block;
          font-size: 0.75rem;
          color: #888;
          margin-bottom: 4px;
        }

        .config-value {
          font-size: 0.875rem;
          color: #fff;
          word-break: break-all;
        }

        .empty-hint {
          padding: 16px 24px;
          background: rgba(99, 102, 241, 0.1);
          border: 1px dashed #6366f1;
          border-radius: 8px;
        }

        .empty-hint p {
          margin: 0;
          color: #6366f1;
          font-size: 0.875rem;
        }

        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal-content {
          background: #1e1e2e;
          padding: 24px;
          border-radius: 12px;
          border: 1px solid #333;
          width: 400px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
        }

        .modal-content h4 {
          margin: 0 0 20px 0;
          color: #fff;
          font-size: 1.25rem;
        }

        .form-group {
          margin-bottom: 16px;
        }

        .form-group label {
          display: block;
          margin-bottom: 8px;
          color: #fff;
          font-size: 0.875rem;
        }

        .form-group input,
        .form-group textarea {
          width: 100%;
          padding: 8px 12px;
          background: #2a2a3e;
          border: 1px solid #444;
          border-radius: 6px;
          color: #fff;
          font-size: 0.875rem;
        }

        .form-group input:focus,
        .form-group textarea:focus {
          outline: none;
          border-color: #6366f1;
        }

        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          margin-top: 24px;
        }
      `}</style>
    </div>
  );
}

// Wrap with provider for standalone use
export function WorkflowBuilderWithProvider(props: WorkflowBuilderProps) {
  return (
    <ReactFlowProvider>
      <WorkflowBuilder {...props} />
    </ReactFlowProvider>
  );
}
