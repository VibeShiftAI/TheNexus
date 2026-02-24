import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AnnotatedMarkdown } from '../annotated-markdown';
import * as nexus from '@/lib/nexus';

// Mock the nexus API
jest.mock('@/lib/nexus', () => ({
    getInlineComments: jest.fn(),
    addInlineComment: jest.fn(),
    resolveInlineComment: jest.fn()
}));

describe('AnnotatedMarkdown', () => {
    const defaultProps = {
        content: '# Test Header\n\nThis is test content for the markdown viewer.',
        stage: 'research' as const,
        taskId: 'test-task-id',
        projectId: 'test-project-id',
        readOnly: false
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (nexus.getInlineComments as jest.Mock).mockResolvedValue([]);
    });

    it('renders markdown content correctly', async () => {
        render(<AnnotatedMarkdown {...defaultProps} />);

        await waitFor(() => {
            expect(screen.getByRole('heading', { name: /Test Header/i })).toBeInTheDocument();
        });
        expect(screen.getByText(/This is test content/i)).toBeInTheDocument();
    });

    it('loads comments on mount', async () => {
        const mockComments = [
            {
                id: 'comment-1',
                taskId: 'test-task-id',
                stage: 'research',
                selectionText: 'test content',
                comment: 'This is a test comment',
                resolved: false,
                createdAt: new Date().toISOString()
            }
        ];
        (nexus.getInlineComments as jest.Mock).mockResolvedValue(mockComments);

        render(<AnnotatedMarkdown {...defaultProps} />);

        await waitFor(() => {
            expect(nexus.getInlineComments).toHaveBeenCalledWith(
                'test-project-id',
                'test-task-id',
                'research'
            );
        });
    });

    it('shows comment count when comments exist', async () => {
        const mockComments = [
            {
                id: 'comment-1',
                taskId: 'test-task-id',
                stage: 'research',
                selectionText: 'test',
                comment: 'Comment 1',
                resolved: false,
                createdAt: new Date().toISOString()
            },
            {
                id: 'comment-2',
                taskId: 'test-task-id',
                stage: 'research',
                selectionText: 'content',
                comment: 'Comment 2',
                resolved: false,
                createdAt: new Date().toISOString()
            }
        ];
        (nexus.getInlineComments as jest.Mock).mockResolvedValue(mockComments);

        render(<AnnotatedMarkdown {...defaultProps} />);

        await waitFor(() => {
            expect(screen.getByText('2')).toBeInTheDocument();
        });
    });

    it('does not show comment input in readOnly mode', async () => {
        render(<AnnotatedMarkdown {...defaultProps} readOnly={true} />);

        // Select some text (simulated)
        const content = screen.getByText(/This is test content/i);
        fireEvent.mouseUp(content);

        // Comment input should not appear
        expect(screen.queryByPlaceholderText(/Add your comment/i)).not.toBeInTheDocument();
    });

    it('resolves a comment when resolve button is clicked', async () => {
        const mockComment = {
            id: 'comment-1',
            taskId: 'test-task-id',
            stage: 'research',
            selectionText: 'test',
            comment: 'Test comment',
            resolved: false,
            createdAt: new Date().toISOString()
        };
        (nexus.getInlineComments as jest.Mock).mockResolvedValue([mockComment]);
        (nexus.resolveInlineComment as jest.Mock).mockResolvedValue({
            success: true,
            comment: { ...mockComment, resolved: true, resolvedAt: new Date().toISOString() }
        });

        render(<AnnotatedMarkdown {...defaultProps} />);

        await waitFor(() => {
            expect(screen.getByText('Test comment')).toBeInTheDocument();
        });

        const resolveButton = screen.getByRole('button', { name: /Resolve/i });
        fireEvent.click(resolveButton);

        await waitFor(() => {
            expect(nexus.resolveInlineComment).toHaveBeenCalledWith(
                'test-project-id',
                'test-task-id',
                'comment-1',
                true
            );
        });
    });

    it('handles empty markdown content', async () => {
        render(<AnnotatedMarkdown {...defaultProps} content="" />);

        // Should still render without errors
        expect(screen.getByRole('article') || document.body).toBeInTheDocument();
    });
});
