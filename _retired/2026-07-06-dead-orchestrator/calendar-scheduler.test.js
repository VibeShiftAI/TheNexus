const { shouldDispatchCalendarEvent } = require('../services/calendar-scheduler');

describe('calendar scheduler dispatch filtering', () => {
    test('does not dispatch local LLM history windows', () => {
        const now = new Date('2026-05-14T06:00:30.000Z');
        const event = {
            id: 'event-1',
            status: 'scheduled',
            event_type: 'local_llm:knowledge',
            start_time: '2026-05-14T06:00:00.000Z',
        };

        expect(shouldDispatchCalendarEvent(event, now)).toBe(false);
    });

    test('dispatches normal scheduled calendar tasks inside the due window', () => {
        const now = new Date('2026-05-14T13:00:30.000Z');
        const event = {
            id: 'event-2',
            status: 'scheduled',
            event_type: 'praxis_task',
            start_time: '2026-05-14T13:00:00.000Z',
        };

        expect(shouldDispatchCalendarEvent(event, now)).toBe(true);
    });
});
