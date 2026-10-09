/**
 * Which Nexus tasks carry the Groundrules blind-labelling packet.
 *
 * The originating task is the one Robert opens; the related tasks are the
 * packet's own history (preparation, protocol, later scoring) and are linked
 * from the workbench rather than duplicated. GROUNDRULES_LABELING_TASK_IDS
 * (comma or space separated) can add task ids without a code change.
 */
const ORIGINATING_TASK_ID = '2617e7be-7026-454d-8705-7a37e04e0144';
const PROJECT_ID = '040c7a02-5665-4bff-9ddd-abe61abd7484';
const RELATED_TASKS = [
    { id: 'f70448bc-5075-4243-b5ab-bd6785464b07', role: 'packet preparation' },
    { id: '1d1fac51-7f6c-41fd-9b92-5e368d31128c', role: 'blind protocol' },
    { id: '1d0feb38-3fc5-4245-9aac-c28c303d626b', role: 'later scoring' },
];
const NEED_ID = '163e050c';

function linkedTaskIds() {
    const extra = (process.env.GROUNDRULES_LABELING_TASK_IDS || '').split(/[\s,]+/).filter(Boolean);
    return Array.from(new Set([ORIGINATING_TASK_ID, ...extra]));
}

function isLinked(taskId) {
    return linkedTaskIds().includes(taskId);
}

function routeFor(taskId) {
    return `/task/${encodeURIComponent(taskId)}/labeling`;
}

module.exports = { ORIGINATING_TASK_ID, PROJECT_ID, RELATED_TASKS, NEED_ID, linkedTaskIds, isLinked, routeFor };
