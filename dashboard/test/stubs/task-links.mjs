// Counting wrapper for @/lib/task-links. splitOnTaskIds runs once per
// TaskLinkedText render (plain-text user/system rows), so the counter tracks
// re-renders of the non-markdown message rows. Everything delegates to the
// real implementation.
import {
    isTaskHref,
    isTaskId,
    remarkTaskLinks,
    splitOnTaskIds as realSplitOnTaskIds,
    taskHref,
} from "../../src/lib/task-links.ts";

export { isTaskHref, isTaskId, remarkTaskLinks, taskHref };

export const splitCounter = { count: 0 };

export function splitOnTaskIds(text) {
    splitCounter.count += 1;
    return realSplitOnTaskIds(text);
}
