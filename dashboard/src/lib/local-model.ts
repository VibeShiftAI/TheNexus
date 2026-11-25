/**
 * Display rules for the local model part of the alias manager (task fa032fc0).
 * The data comes from GET /api/model-control/local-model (lib/model-control.ts);
 * these helpers only word it. Kept out of the component module so that module
 * exports components only and stays a Fast Refresh boundary.
 */
import type { LocalModelChoiceResult, LocalModelHandling, LocalModelPanel, LocalModelSwitch, LocalWorkItem } from "@/lib/model-control";
import { readableJobName } from "./local-activity";
export { describeLocalActivity, describeQueuedJob } from "./local-activity";
export type { LocalActivityQueue, LocalActivityRun, LocalStudioState, DescribedLocalRun } from "./local-activity";

/** The Socket.IO event Nexus sends when the setting, a switch or Studio local work changes (server/services/local-model-selection.js, EVENT). */
export const LOCAL_MODEL_EVENT = "model-control:local-model";

/** Size on disk in decimal gigabytes, as LM Studio and Finder show it. */
export function formatModelSize(bytes: number | null | undefined): string {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "size not listed";
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function formatTokens(count: number): string {
    return count.toLocaleString("en-US");
}

export function handlingLabel(handling: LocalModelHandling): string {
    if (handling === "tested") return "tested handling";
    if (handling === "conservative") return "conservative defaults";
    return "handling not known";
}

/** What the handling words mean, for the row's tooltip and the legend. */
export function handlingExplanation(handling: LocalModelHandling): string {
    if (handling === "tested") return "Praxis's capability table has a tested entry for this model.";
    if (handling === "conservative") return "Not in Praxis's capability table, so Praxis calls it with conservative defaults.";
    return "Praxis did not answer, so whether its handling is tested is not known.";
}

/** One option's facts line: size on disk, saved load context, handling. */
export function optionFacts(option: { sizeBytes: number | null; savedContext: number | null; handling: LocalModelHandling }): string {
    const context = option.savedContext !== null ? `context ${formatTokens(option.savedContext)} (saved)` : "no saved context";
    return [formatModelSize(option.sizeBytes), context, handlingLabel(option.handling)].join(" · ");
}

export function surfaceLabel(surface: string | null | undefined): string {
    if (surface === "model-control") return "Model Control";
    if (surface === "alias-editor") return "the alias editor";
    if (surface === "api") return "the API";
    return surface || "an unnamed surface";
}

export function formatWhen(iso: string | null | undefined): string {
    if (!iso) return "";
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "";
    return at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A piece of local work a waiting switch is held by, in words. */
export function describeWork(item: LocalWorkItem): string {
    const since = item.since ? `, since ${formatWhen(item.since)}` : "";
    if (item.kind === "studio_job") return `${item.label} (Studio job in Nexus${since})`;
    if (item.kind === "local_job") {
        const name = item.label.includes("_") ? readableJobName(item.label) : item.label;
        return `${name} (Praxis local job${since})`;
    }
    return `${item.label} in Praxis`;
}

/** Every piece of work the waiting switch is held by: Studio jobs here, then Praxis's own. */
export function waitingWork(panel: LocalModelPanel): LocalWorkItem[] {
    return panel.waiting ? [...panel.waiting.studio, ...panel.waiting.praxis] : [];
}

function resyncClause(panel: LocalModelPanel): string {
    return typeof panel.praxisResyncSeconds === "number" ? ` every ${panel.praxisResyncSeconds} s` : " on its own";
}

/**
 * Why a waiting switch has not taken effect when no work is listed, or null
 * when the listed work is the reason.
 */
export function waitingNote(panel: LocalModelPanel): string | null {
    if (!panel.waiting || waitingWork(panel).length > 0) return null;
    const praxis = panel.praxis;
    if (!praxis.reachable) {
        return `Praxis did not answer (${praxis.error || "no reply"}). It reads the setting at its start-up and${resyncClause(panel)}, and puts the switch into effect when no local work runs.`;
    }
    const pending = praxis.pending;
    if (!pending || pending.model !== panel.waiting.model) {
        return `Praxis has not read this choice yet. It reads the setting${resyncClause(panel)}.`;
    }
    if (pending.applying) return "Praxis is putting it into effect now.";
    if (pending.lastError) {
        return `Praxis could not record it yet (${pending.lastError}). It tries again when local work settles and when it next reads the setting.`;
    }
    return "Praxis puts it into effect as soon as no local work runs.";
}

/** A line about Praxis when it does not follow the model in effect, else null. */
export function praxisNote(panel: LocalModelPanel): string | null {
    const praxis = panel.praxis;
    if (!praxis.reachable) {
        return `Praxis did not answer (${praxis.error || "no reply"}); it reads the setting at its start-up and${resyncClause(panel)}.`;
    }
    if (praxis.source === "env_fallback" && praxis.fallback) {
        return `Praxis is using its start-up fallback, ${praxis.fallback.envModel}, because it has not read the setting from Nexus (${praxis.fallback.reason}).`;
    }
    if (panel.active && praxis.active && praxis.active !== panel.active.model && !panel.waiting) {
        return `Praxis still calls ${praxis.active}; it reads the setting${resyncClause(panel)}.`;
    }
    return null;
}

/** The option to preselect: the waiting choice, else the model in effect, when the list offers it. */
export function defaultPick(panel: LocalModelPanel): string | null {
    const wanted = panel.waiting?.model ?? panel.active?.model ?? null;
    return panel.options.some(option => option.key === wanted) ? wanted : null;
}

/** What the panel says after a choice or a restore came back. */
export function choiceNotice(result: LocalModelChoiceResult, label: string): string {
    const panel = result.panel;
    if (result.result === "unchanged") {
        return panel?.waiting?.model === result.model
            ? `${label} is already the waiting choice; nothing changed.`
            : `${label} is already the local model; nothing changed.`;
    }
    if (result.result === "applied") {
        return `${label} stays the local model and the waiting switch was dropped. Nothing was loaded.`;
    }
    const told = result.praxisTold === false
        ? ` Praxis was not told (${result.praxisError || "no reply"}); it reads the setting${panel ? resyncClause(panel) : " on its own"}.`
        : "";
    if (panel?.active?.model === result.model) {
        return `${label} is now the local model. Nothing was loaded; it loads when a local call next needs it.${told}`;
    }
    return `Chose ${label}. Nothing was loaded; the switch waits until no local work runs, then the next local call uses it.${told}`;
}

export function switchSummary(row: LocalModelSwitch): string {
    const from = row.from_label || row.from_model || "no local model";
    const to = row.to_label || row.to_model;
    return `${from} → ${to}`;
}

export function switchStatus(row: LocalModelSwitch): string {
    if (row.status === "waiting") return "waiting for local work";
    if (row.status === "replaced") return `replaced by a newer choice${row.replaced_at ? ` ${formatWhen(row.replaced_at)}` : ""}`;
    if (row.status === "applied") {
        if (row.details?.note) return "dropped the waiting switch; nothing changed for local calls";
        return `in effect from ${formatWhen(row.applied_at)}`;
    }
    return row.status;
}

export function switchOrigin(row: LocalModelSwitch): string {
    return `${row.action === "restore" ? "Restored" : "Chosen"} under ${surfaceLabel(row.surface)} · ${formatWhen(row.requested_at)}`;
}
