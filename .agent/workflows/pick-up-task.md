---
description: Pick up and work on tasks dispatched from Gravity Claw
---

# Pick Up Task from Gravity Claw

This workflow picks up a pending task from the shared Antigravity queue and executes it.

## Steps

// turbo-all

1. **Read the queue directory** to find pending tasks:
```bash
ls -la /Volumes/Projects/.antigravity-queue/*.json 2>/dev/null
```

2. **Find the oldest pending task** by reading each JSON file using `view_file` and checking for `"status": "pending"`. Pick the oldest one by `createdAt`.

3. **Mark the task as in-progress** by editing the JSON file:
   - Set `"status": "in-progress"`
   - Set `"updatedAt"` to the current ISO timestamp

4. **Read the task details**:
   - `title`: What the task is about
   - `description`: Detailed instructions for what to do
   - `workspace`: The project directory to work in
   - `replyWebhook`: The callback URL to notify Gravity Claw when done

5. **Execute the task** based on the `description` field. Apply the changes described to the codebase.

6. **After completion**, update the task JSON file:
   - Set `"status": "done"` (or `"failed"` if something went wrong)
   - Set `"result"` to a brief summary of what was accomplished
   - Set `"updatedAt"` to the current ISO timestamp

7. **Notify Gravity Claw** by sending a POST request to the `replyWebhook` URL:
```bash
curl -X POST <replyWebhook> \
  -H "Content-Type: application/json" \
  -d '{"taskId": "<taskId>", "nexusProjectId": "<nexusProjectId>", "nexusTaskId": "<nexusTaskId>", "result": "<summary of what you did>"}'
```
This closes the loop — Gravity Claw will receive the callback, notify the user on Telegram, and sync artifacts to The Nexus.

## Important Notes
- Only pick up tasks where `workspace` matches the current project directory
- If no pending tasks exist, report that the queue is empty
- If the task fails, set `"status": "failed"`, populate `"error"`, and still send the callback
- The callback is **critical** — without it, Gravity Claw won't know the task is done
