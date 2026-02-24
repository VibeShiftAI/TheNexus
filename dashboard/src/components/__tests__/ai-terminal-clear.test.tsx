import { render, screen, fireEvent } from '@testing-library/react';
import { AITerminal } from '../components/ai-terminal';
import '@testing-library/jest-dom';

describe('AITerminal', () => {
    it('clears messages when the trash button is clicked', () => {
        // Mock the onClose function
        const onClose = jest.fn();

        render(<AITerminal isOpen={true} onClose={onClose} />);

        // Check if the "Clear Console" button exists (it shouldn't yet)
        // We expect this to fail initially
        const clearButton = screen.getByLabelText('Clear Console');

        // If we get here, simulate click (which we can't if it doesn't exist)
        // fireEvent.click(clearButton);

        // Check if messages are cleared (need to mock state or inspecting UI text)
    });
});
