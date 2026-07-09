import { z } from "zod";

export const PACTRecordSchema = z.object({
  current_state: z.string(),
  action_taken: z.string(),
  target_goal: z.string(),
  dependency_keys: z.array(z.string()),
});

export type PACTRecord = z.infer<typeof PACTRecordSchema>;
