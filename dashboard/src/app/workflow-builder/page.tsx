'use client';

/**
 * Workflow Builder Page
 * Full-page visual workflow editor with template support
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { WorkflowBuilderWithProvider } from '@/components/workflow-builder';
import { WorkflowDebugger } from '@/components/workflow-debugger';
import { rewindWorkflow, getWorkflowTemplates, deleteWorkflowTemplate } from '@/lib/nexus';
import { Trash2 } from 'lucide-react';

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  nodes: unknown[];
  edges: unknown[];
  is_system?: boolean;
}

export default function WorkflowBuilderPage() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null);
  const [currentTemplateName, setCurrentTemplateName] = useState<string>('');
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [showDebugger, setShowDebugger] = useState(false);

  // Load templates on mount - SINGLE SOURCE: LangGraph endpoint (Python)
  // This returns visual templates from workflow_templates.default_configuration
  // No fallbacks - if templates fail to load, show error (per No Fallbacks policy)
  useEffect(() => {
    async function loadTemplates() {
      try {
        const langGraphTemplates = await getWorkflowTemplates();
        const templates = langGraphTemplates.map((t: any) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          category: t.category || 'Workflow',
          nodes: t.nodes as unknown[],
          edges: t.edges as unknown[],
          is_system: t.is_system
        }));
        setTemplates(templates);
      } catch (error) {
        console.error('[WorkflowBuilder] Failed to load templates:', error);
        // Templates will be empty - user sees empty state (no silent fallback)
      }
    }
    loadTemplates();
  }, []);

  // Handle saving workflow
  const handleSave = useCallback(async (graphConfig: { nodes: unknown[]; edges: unknown[] }) => {
    try {
      const response = await fetch('/api/langgraph/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(graphConfig),
      });

      const result = await response.json();

      if (result.success) {
        alert(`✅ Workflow valid! ${result.node_count} nodes, ${result.edge_count} edges`);
      } else {
        alert(`❌ Validation failed: ${result.detail || result.error}`);
      }
    } catch (error) {
      console.error('Save error:', error);
      alert('Failed to validate workflow. Is the LangGraph engine running?');
    }
  }, []);

  // Handle running workflow
  const handleRun = useCallback(async (graphConfig: { nodes: unknown[]; edges: unknown[] }) => {
    try {
      const response = await fetch('/api/langgraph/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graph_config: graphConfig,
          project_id: 'demo',
          input_data: {},
        }),
      });

      const result = await response.json();

      if (result.success) {
        setCurrentRunId(result.run_id);
        setShowDebugger(true);
      } else {
        alert(`❌ Failed to start: ${result.detail || result.error}`);
      }
    } catch (error) {
      console.error('Run error:', error);
      alert('Failed to run workflow. Is the LangGraph engine running?');
    }
  }, []);

  // Handle template selection
  const handleLoadTemplate = (template: WorkflowTemplate) => {
    setSelectedTemplate(template);
    setCurrentTemplateName(template.name);
    setShowTemplateModal(false);
  };

  // Handle template name change from the workflow builder
  const handleTemplateNameChange = (name: string) => {
    setCurrentTemplateName(name);
  };

  // Handle template deletion
  const handleDeleteTemplate = async (templateId: string, isSystem: boolean, event: React.MouseEvent) => {
    event.stopPropagation();

    const warningMsg = isSystem
      ? `⚠️ WARNING: This is a system template.\n\nAre you sure you want to delete this template? This cannot be undone.`
      : `Are you sure you want to delete this template? This cannot be undone.`;

    if (window.confirm(warningMsg)) {
      try {
        const result = await deleteWorkflowTemplate(templateId);
        if (result.success) {
          // Optimistic UI update
          setTemplates(prev => prev.filter(t => t.id !== templateId));
        } else {
          alert(`Failed to delete template: ${result.message}`);
        }
      } catch (error: any) {
        console.error('Delete error:', error);
        alert(`Error deleting template: ${error.message}`);
      }
    }
  };

  return (
    <div className="workflow-page">
      <header className="page-header">
        <Link href="/" className="back-link">
          ← Back to Dashboard
        </Link>
        <div className="header-content">
          <div>
            <h1>Workflow Builder</h1>
            <p>Design agent workflows visually</p>
          </div>
          <button
            className="template-btn"
            onClick={() => setShowTemplateModal(true)}
          >
            📋 Load Template
          </button>
        </div>
      </header>

      <main className="page-content">
        <div className="builder-area">
          <WorkflowBuilderWithProvider
            onSave={handleSave}
            onRun={handleRun}
            templateName={currentTemplateName}
            onTemplateNameChange={handleTemplateNameChange}
            initialNodes={selectedTemplate?.nodes as any}
            initialEdges={selectedTemplate?.edges as any}
          />
        </div>

        {/* Debugger Panel */}
        {showDebugger && currentRunId && (
          <div className="debugger-panel">
            <WorkflowDebugger
              runId={currentRunId}
              onRewind={async (checkpointId) => {
                const result = await rewindWorkflow(currentRunId, checkpointId);
                if (result.success && result.new_run_id) {
                  setCurrentRunId(result.new_run_id);
                }
              }}
              onClose={() => setShowDebugger(false)}
            />
          </div>
        )}
      </main>

      {/* Template Modal */}
      {showTemplateModal && (
        <div className="modal-overlay" onClick={() => setShowTemplateModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Load Template</h2>
            <p className="modal-subtitle">Choose a pre-built workflow to get started</p>

            <div className="template-grid">
              {templates.map(template => (
                <div key={template.id} className="template-card-wrapper relative group">
                  <button
                    className="template-card w-full h-full"
                    onClick={() => handleLoadTemplate(template)}
                  >
                    <span className="template-name">{template.name}</span>
                    <span className="template-desc">{template.description}</span>
                    <span className={`template-badge ${template.is_system ? 'system-badge' : ''}`}>
                      {template.category} {template.is_system ? '(System)' : ''}
                    </span>
                  </button>
                  <button
                    className="absolute top-3 right-3 p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => handleDeleteTemplate(template.id, !!template.is_system, e)}
                    title="Delete template"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>

            <button
              className="close-btn"
              onClick={() => setShowTemplateModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <style jsx>{`
        .workflow-page {
          min-height: 100vh;
          background: #0a0a0f;
          color: #fff;
          display: flex;
          flex-direction: column;
        }

        .page-header {
          padding: 20px 24px;
          background: #1e1e2e;
          border-bottom: 1px solid #333;
        }

        .header-content {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
        }

        .back-link {
          display: inline-block;
          margin-bottom: 8px;
          color: #6366f1;
          text-decoration: none;
          font-size: 0.875rem;
        }

        .back-link:hover {
          text-decoration: underline;
        }

        h1 {
          margin: 0;
          font-size: 1.5rem;
          font-weight: 600;
        }

        p {
          margin: 4px 0 0;
          color: #888;
          font-size: 0.875rem;
        }

        .template-btn {
          padding: 10px 20px;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          border: none;
          border-radius: 8px;
          color: white;
          font-size: 0.875rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .template-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        }

        .page-content {
          flex: 1;
          display: flex;
          min-height: 0;
          gap: 16px;
          padding: 16px;
        }

        .builder-area {
          flex: 1;
          min-width: 0;
          display: flex;
        }

        .builder-area > :global(div) {
          flex: 1;
        }

        .debugger-panel {
          width: 380px;
          flex-shrink: 0;
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
        }

        .modal {
          background: #1e1e2e;
          border: 1px solid #333;
          border-radius: 16px;
          padding: 24px;
          width: 90%;
          max-width: 600px;
          max-height: 80vh;
          overflow-y: auto;
        }

        .modal h2 {
          margin: 0 0 4px 0;
          font-size: 1.25rem;
        }

        .modal-subtitle {
          color: #888;
          margin: 0 0 20px 0;
        }

        .template-grid {
          display: grid;
          gap: 12px;
        }

        .template-card {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 6px;
          padding: 16px;
          background: #2a2a3e;
          border: 1px solid #444;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.2s;
          text-align: left;
        }

        .template-card:hover {
          border-color: #6366f1;
          background: #3a3a4e;
        }

        .template-name {
          font-weight: 600;
          color: #fff;
        }

        .template-desc {
          font-size: 0.875rem;
          color: #888;
        }

        .template-badge {
          font-size: 0.75rem;
          padding: 4px 8px;
          background: #6366f120;
          color: #6366f1;
          border-radius: 4px;
        }

        .system-badge {
          background: #334155;
          color: #94a3b8;
          border: 1px solid #475569;
        }

        .close-btn {
          margin-top: 16px;
          width: 100%;
          padding: 12px;
          background: #333;
          border: none;
          border-radius: 8px;
          color: white;
          cursor: pointer;
        }

        .close-btn:hover {
          background: #444;
        }
      `}</style>
    </div>
  );
}
