jest.mock('expo-server-sdk', () => ({ Expo: class { static isExpoPushToken() { return true; } chunkPushNotifications(messages) { return [messages]; } async sendPushNotificationsAsync(messages) { global.__pushCopy = messages[0]; return [{status:'ok',id:'receipt'}]; } } }));
const push = require('../push-service');
test('task push names the work and explains the review state', async () => {
  push.init({ markPushTokenSuccess: async () => {}, getActivePushTokens: async () => [{ token: 'test-token' }] });
  await push.notifyTaskUpdate({ id: 'task-42', name: 'Repair calendar sync', status: 'ready_for_review' }, 'in_progress');
  expect(global.__pushCopy.title).toContain('Repair calendar sync');
  expect(global.__pushCopy.body).toMatch(/review/i);
  expect(global.__pushCopy.body).not.toContain('→');
  expect(global.__pushCopy.data.taskId).toBe('task-42');
});
