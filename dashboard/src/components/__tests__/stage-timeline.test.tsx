import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StageTimeline } from '../stage-timeline';
import * as nexus from '@/lib/nexus';

// Mock the nexus API
jest.mock('@/lib/nexus', () => ({
    getTaskTimeline: jest.fn()
}));

describe('StageTimeline', () => {
    const defaultProps = {
        projectId: 'test-project-id',
        taskId: 'test-task-id',
        stage: 'research' as const,
        nextStage: 'plan' as const,
        isComplete: false
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (nexus.getTaskTimeline as jest.Mock).mockResolvedValue([]);
    });

    it('shows loading state initially', () => {
        (nexus.getTaskTimeline as jest.Mock).mockImplementation(() => new Promise(() => { }));
        render(<StageTimeline {...defaultProps} />);

        expect(screen.getByText(/Loading execution history/i)).toBeInTheDocument();
    });

    it('renders nothing when no steps exist', async () => {
        (nexus.getTaskTimeline as jest.Mock).mockResolvedValue([]);

        const { container } = render(<StageTimeline {...defaultProps} />);

        await waitFor(() => {
            expect(nexus.getTaskTimeline).toHaveBeenCalled();
        });

        // Component should not render any timeline content
        expect(screen.queryByText(/Execution Timeline/i)).not.toBeInTheDocument();
    });

    it('renders execution steps correctly', async () => {
        const mockSteps = [
            {
                id: 'step-1',
                node: 'researcher-1',
                stage: 'research',
                step: 1,
                status: 'completed',
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: 45000
            },
            {
                id: 'step-2',
                node: 'planner-1',
                stage: 'plan',
                step: 2,
                status: 'running',
                startedAt: new Date().toISOString()
            }
        ];
        (nexus.getTaskTimeline as jest.Mock).mockResolvedValue(mockSteps);

        render(<StageTimeline {...defaultProps} />);

        await waitFor(() => {
            expect(screen.getByText('Execution Timeline')).toBeInTheDocument();
        });

        expect(screen.getByText('Researcher')).toBeInTheDocument();
        expect(screen.getByText('Planner')).toBeInTheDocument();
        expect(screen.getByText('45.0s')).toBeInTheDocument();
    });

    it('shows handoff indicator when stage is complete', async () => {
        const mockSteps = [
            {
                id: 'step-1',
                node: 'researcher-1',
                stage: 'research',
                step: 1,
                status: 'completed',
                startedAt: new Date().toISOString()
            }
        ];
        (nexus.getTaskTimeline as jest.Mock).mockResolvedValue(mockSteps);

        render(<StageTimeline {...defaultProps} isComplete={true} />);

        await waitFor(() => {
            expect(screen.getByText(/Handed off to Planning/i)).toBeInTheDocument();
        });
    });

    it('does not show handoff when stage is not complete', async () => {
        const mockSteps = [
            {
                id: 'step-1',
                node: 'researcher-1',
                stage: 'research',
                step: 1,
                status: 'running',
                startedAt: new Date().toISOString()
            }
        ];
        (nexus.getTaskTimeline as jest.Mock).mockResolvedValue(mockSteps);

        render(<StageTimeline {...defaultProps} isComplete={false} />);

        await waitFor(() => {
            expect(screen.getByText('Researcher')).toBeInTheDocument();
        });

        expect(screen.queryByText(/Handed off/i)).not.toBeInTheDocument();
    });

    it('expands step to show input/output data', async () => {
        const mockSteps = [
            {
                id: 'step-1',
                node: 'researcher-1',
                stage: 'research',
                step: 1,
                status: 'completed',
                input: { query: 'test query' },
                output: { result: 'test result' },
                startedAt: new Date().toISOString()
            }
        ];
        (nexus.getTaskTimeline as jest.Mock).mockResolvedValue(mockSteps);

        render(<StageTimeline {...defaultProps} />);

        await waitFor(() => {
            expect(screen.getByText('Researcher')).toBeInTheDocument();
        });

        // Click to expand
        const stepCard = screen.getByText('Researcher').closest('[class*="cursor-pointer"]');
        if (stepCard) {
            fireEvent.click(stepCard);
        }

        await waitFor(() => {
            expect(screen.getByText(/Input:/i)).toBeInTheDocument();
            expect(screen.getByText(/test query/i)).toBeInTheDocument();
        });
    });

    it('shows error message for failed steps', async () => {
        const mockSteps = [
            {
                id: 'step-1',
                node: 'researcher-1',
                stage: 'research',
                step: 1,
                status: 'failed',
                error: 'API rate limit exceeded',
                startedAt: new Date().toISOString()
            }
        ];
        (nexus.getTaskTimeline as jest.Mock).mockResolvedValue(mockSteps);

        render(<StageTimeline {...defaultProps} />);

        await waitFor(() => {
            expect(screen.getByText(/Error: API rate limit exceeded/i)).toBeInTheDocument();
        });
    });

    it('calls API with correct stage filter', async () => {
        render(<StageTimeline {...defaultProps} stage="plan" />);

        await waitFor(() => {
            expect(nexus.getTaskTimeline).toHaveBeenCalledWith(
                'test-project-id',
                'test-task-id',
                'plan'
            );
        });
    });
});
