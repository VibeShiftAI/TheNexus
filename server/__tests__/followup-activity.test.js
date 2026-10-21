const { materialTaskChanged, notifyTaskEvidenceChange } = require('../services/followup-activity');
test('walkthrough and dependency changes are material, progress and timestamps are not', () => {
 const task={id:'t1',version:1,walkthrough:'before',dependencies:['a'],status:'completed'};
 expect(materialTaskChanged(task,{...task,version:2,status_message:'progress',updated_at:'now'})).toBe(false);
 expect(materialTaskChanged(task,{...task,walkthrough:'new evidence'})).toBe(true);
 expect(materialTaskChanged(task,{...task,dependencies:['b']})).toBe(true);
 expect(materialTaskChanged(null,task)).toBe(true);
});
test('notification uses authenticated narrow payload and failures do not reject board writes', async () => {
 const send=jest.fn().mockResolvedValue({ok:true});
 await notifyTaskEvidenceChange(null,{id:'t1',version:3,walkthrough:'private evidence'}, {send,key:'test-key',warn:jest.fn()});
 expect(send).toHaveBeenCalledWith('/ops/followup-activity',expect.objectContaining({method:'POST',body:{taskId:'t1',version:3},headers:{authorization:'Bearer test-key'}}));
 send.mockRejectedValue(Error('offline'));
 await expect(notifyTaskEvidenceChange(null,{id:'t1',version:4},{send,key:'test-key',warn:jest.fn()})).resolves.toBe(false);
});
