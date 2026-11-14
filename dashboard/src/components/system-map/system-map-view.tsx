"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { Moon, RefreshCw, Sun } from "lucide-react";
import { Breadcrumbs } from "@/components/breadcrumbs";
import {
    SYSTEM_MAP_TABS, SYSTEM_MAP_THEME_KEY, SystemMapError, buildIndex, fetchSystemMap, formatCount, formatGeneratedAt, generatedAgo,
    isSystemMapTab, isTestFolder, warningCount,
    type SystemMap, type SystemMapFailure, type SystemMapTab, type SystemMapTheme,
} from "@/lib/system-map";
import { SystemMapPanel, type PairDetail, type PanelState, type SelectNode } from "./system-map-panel";
import { BoundaryTab, ConnectionsTab, DriftTab, MapTab, RoutesTab, ScheduleTab } from "./system-map-tabs";

const NARROW = "(max-width: 1023px)";

type Failure = { kind: SystemMapFailure; message: string };

/**
 * The System Map page: one fetch of the vault's generated map when the page
 * opens, another only when Refresh is pressed. It reads; it never writes and
 * never polls.
 */
export function SystemMapView() {
    const [map, setMap] = useState<SystemMap | null>(null);
    const [failure, setFailure] = useState<Failure | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadedAt, setLoadedAt] = useState(0);
    const [tab, setTab] = useState<SystemMapTab>("map");
    const [panel, setPanel] = useState<PanelState>(null);
    const [query, setQuery] = useState("");
    const [theme, setTheme] = useState<SystemMapTheme>("dark");
    const [narrow, setNarrow] = useState(false);
    const [announcement, setAnnouncement] = useState("");

    const headingRef = useRef<HTMLHeadingElement>(null);
    const originRef = useRef<HTMLElement | SVGElement | null>(null);
    const revealed = useRef(0);
    const focusNext = useRef(false);
    const restoreFocus = useRef<{ selected: string | null } | null>(null);
    const panelRef = useRef<PanelState>(null);
    panelRef.current = panel;
    const [reveal, setReveal] = useState<{ id: string; seq: number } | null>(null);
    const started = useRef(false);

    const index = useMemo(() => (map ? buildIndex(map) : null), [map]);
    const normalizedQuery = query.trim().toLowerCase();

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const next = await fetchSystemMap();
            setMap(next);
            setFailure(null);
            setLoadedAt(Date.now());
            setAnnouncement(`System map loaded, generated ${formatGeneratedAt(next.generatedAt)}.`);
            // A component that left the map takes its detail with it.
            setPanel((current) => (current?.type === "node" && !next.nodes.some((n) => n.id === current.id) ? null : current));
        } catch (err) {
            const next: Failure = err instanceof SystemMapError
                ? { kind: err.kind, message: err.message }
                : { kind: "unavailable", message: "The system map could not be loaded." };
            setFailure(next);
            setAnnouncement(next.message);
        } finally {
            setLoading(false);
        }
    }, []);

    // One fetch when the page opens. The guard keeps development's doubled
    // effect from making it two; there is no timer and no socket listener.
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void load();
    }, [load]);

    useEffect(() => {
        const requested = new URLSearchParams(window.location.search).get("tab");
        if (isSystemMapTab(requested)) setTab(requested);
        try { if (window.localStorage.getItem(SYSTEM_MAP_THEME_KEY) === "light") setTheme("light"); } catch { /* storage unavailable: stay dark */ }
        const media = window.matchMedia(NARROW);
        const sync = () => setNarrow(media.matches);
        sync();
        media.addEventListener("change", sync);
        return () => media.removeEventListener("change", sync);
    }, []);

    const chooseTab = useCallback((next: SystemMapTab) => {
        setTab(next);
        // Keep the address shareable without a navigation.
        window.history.replaceState(window.history.state, "", next === "map" ? window.location.pathname : `${window.location.pathname}?tab=${next}`);
    }, []);

    const toggleTheme = () => {
        const next: SystemMapTheme = theme === "dark" ? "light" : "dark";
        setTheme(next);
        // A display preference kept in this browser only.
        try { window.localStorage.setItem(SYSTEM_MAP_THEME_KEY, next); } catch { /* not remembered */ }
    };

    const rememberOrigin = () => {
        const active = document.activeElement;
        // Diagram boxes and timeline dots are SVG elements; they take focus back too.
        if ((active instanceof HTMLElement || active instanceof SVGElement) && active !== document.body && !active.closest("[data-sm-panel]")) originRef.current = active;
    };

    const select: SelectNode = useCallback((id, options = {}) => {
        rememberOrigin();
        const current = panelRef.current;
        // Selecting the selected tile again clears the selection.
        if (current?.type === "node" && current.id === id && !options.reveal) { setPanel(null); return; }
        focusNext.current = Boolean(options.keyboard) || window.matchMedia(NARROW).matches;
        if (options.reveal) setReveal((last) => ({ id, seq: (last?.seq ?? 0) + 1 }));
        setPanel({ type: "node", id });
    }, []);

    const showPair = useCallback((pair: PairDetail, keyboard: boolean) => {
        rememberOrigin();
        focusNext.current = keyboard || window.matchMedia(NARROW).matches;
        setPanel({ type: "pair", ...pair });
    }, []);

    const closePanel = useCallback(() => {
        const current = panelRef.current;
        restoreFocus.current = { selected: current?.type === "node" ? current.id : null };
        setPanel(null);
    }, []);

    // After a selection lands, move focus into the detail when it opened over
    // the page (phone) or was made from the keyboard. After the detail closes,
    // hand focus back to where the selection was made, or to its tile. Both
    // run once the change is on the page, so the target can take focus.
    useEffect(() => {
        if (!panel) {
            const restore = restoreFocus.current;
            restoreFocus.current = null;
            if (!restore) return;
            const origin = originRef.current;
            const target = origin?.isConnected ? origin
                : restore.selected ? document.querySelector<HTMLElement>(`[data-sm-id="${CSS.escape(restore.selected)}"]`) : null;
            target?.focus({ preventScroll: true });
            return;
        }
        if (!focusNext.current) return;
        focusNext.current = false;
        headingRef.current?.focus({ preventScroll: !window.matchMedia(NARROW).matches });
    }, [panel]);

    // Bring a component picked from the diagram or the detail into view among the tiles.
    useEffect(() => {
        if (!reveal || tab !== "map" || revealed.current === reveal.seq) return;
        revealed.current = reveal.seq;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        document.querySelector(`[data-sm-id="${CSS.escape(reveal.id)}"]`)?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }, [reveal, tab]);

    // From another tab: go to the Map tab with the selected component's tile in view.
    const showOnMap = () => {
        const id = panelRef.current?.type === "node" ? panelRef.current.id : null;
        if (!id) return;
        chooseTab("map");
        setReveal((last) => ({ id, seq: (last?.seq ?? 0) + 1 }));
    };

    const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const keys = SYSTEM_MAP_TABS.map(([key]) => key);
        const at = keys.indexOf(tab);
        const to = e.key === "ArrowRight" ? (at + 1) % keys.length
            : e.key === "ArrowLeft" ? (at - 1 + keys.length) % keys.length
            : e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1 : -1;
        if (to < 0) return;
        e.preventDefault();
        chooseTab(keys[to]);
        e.currentTarget.querySelector<HTMLElement>(`[data-sm-tab="${keys[to]}"]`)?.focus();
    };

    const selectedId = panel?.type === "node" ? panel.id : null;
    // Only a detail that actually has something to show covers the page.
    const sheetOpen = narrow && panel !== null && (panel.type === "pair" || Boolean(index?.byId.has(panel.id)));
    const counts: Record<SystemMapTab, string | null> = map ? {
        // The components that have a tile; test folders are named in a line under the tiles instead.
        map: formatCount(map.nodes.filter((n) => n.level === 2 && !isTestFolder(n)).length),
        connections: null,
        schedule: formatCount((map.catalogs.crons ?? []).length),
        routes: formatCount((map.catalogs.routes ?? []).length),
        drift: `${warningCount(map.checks)} warning${warningCount(map.checks) === 1 ? "" : "s"}`,
        boundary: null,
    } : { map: null, connections: null, schedule: null, routes: null, drift: null, boundary: null };
    const ago = map ? generatedAgo(map.generatedAt, loadedAt || Date.parse(map.generatedAt)) : "";
    const tabProps = index ? { index, query: normalizedQuery, selectedId, onSelect: select, onPair: showPair } : null;

    return (
        <div className="sm-root" data-sm-root="" data-sm-theme={theme} data-sm-loaded={map ? "true" : "false"}>
            {/* Dashboard chrome: the same dark bar every page carries, whichever theme the map is in. */}
            <header className="border-b border-slate-800 bg-slate-950 text-slate-200" inert={sheetOpen}>
                <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-5">
                    <Breadcrumbs current="System Map" />
                    <Link href="/system-monitor" className="ml-auto rounded py-2 text-sm text-slate-400 underline decoration-slate-600 underline-offset-4 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400">
                        Live health is on System Monitor
                    </Link>
                </div>
            </header>

            <div inert={sheetOpen}>
                <div className="sm-titlebar">
                    <h1>System map</h1>
                    {map ? (
                        <span className="sm-stamp" data-sm-stamp="">
                            Generated <time dateTime={map.generatedAt} data-sm-generated={map.generatedAt}>{formatGeneratedAt(map.generatedAt)}</time>
                            {ago ? ` (${ago})` : ""} · facts <code data-sm-hash="">{map.factsHash}</code>
                        </span>
                    ) : null}
                    <div className="sm-actions">
                        {map ? (
                            <input className="sm-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                                placeholder="Filter components, routes, jobs" aria-label="Filter the current view" data-sm-filter="" />
                        ) : null}
                        <button type="button" className="sm-btn" onClick={() => void load()} disabled={loading} data-sm-refresh="">
                            <RefreshCw size={16} aria-hidden="true" className={loading ? "sm-spin" : undefined} />
                            {loading ? "Loading" : "Refresh"}
                        </button>
                        <button type="button" className="sm-btn" onClick={toggleTheme} data-sm-theme-toggle="" aria-label={theme === "dark" ? "Switch the map to the light theme" : "Switch the map to the dark theme"}>
                            {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
                            {theme === "dark" ? "Light" : "Dark"}
                        </button>
                    </div>
                </div>
                <div className="sm-sr" role="status" aria-live="polite">{announcement}</div>
                {map && failure ? (
                    <div className="sm-notice" role="alert" data-sm-refresh-failed="">
                        Refresh failed, so this is still the map loaded earlier. {failure.message}
                    </div>
                ) : null}
            </div>

            {!map || !tabProps || !index ? (
                <div className="sm-state-page" data-sm-state={loading ? "loading" : failure?.kind ?? "unavailable"}>
                    {loading ? (
                        <><h2>Loading the system map</h2><p>Reading the map that is in the vault now.</p></>
                    ) : failure?.kind === "sign-in" ? (
                        <>
                            <h2>Sign-in needed</h2>
                            <p>{failure.message} The map lists public hostnames and local ports, so it is not shown without one.</p>
                            <div className="sm-actions">
                                <button type="button" className="sm-btn sm-primary" onClick={() => void load()}>Try again</button>
                                <Link href="/session" className="sm-btn">Check my session</Link>
                            </div>
                        </>
                    ) : (
                        <>
                            <h2>{failure?.kind === "missing" ? "No map yet" : "The map could not be loaded"}</h2>
                            <p>{failure?.message}</p>
                            <div className="sm-actions"><button type="button" className="sm-btn sm-primary" onClick={() => void load()}>Try again</button></div>
                        </>
                    )}
                </div>
            ) : (
                <>
                    <div className="sm-tabs" role="tablist" aria-label="System map views" onKeyDown={onTabKey} inert={sheetOpen}>
                        {SYSTEM_MAP_TABS.map(([key, label]) => (
                            <button type="button" key={key} role="tab" id={`sm-tab-${key}`} className="sm-tab" data-sm-tab={key}
                                aria-selected={tab === key} aria-controls="sm-tabpanel" tabIndex={tab === key ? 0 : -1} onClick={() => chooseTab(key)}>
                                {label}{counts[key] ? <span className="sm-n">{counts[key]}</span> : null}
                            </button>
                        ))}
                    </div>
                    <div className="sm-main">
                        <div className="sm-view" role="tabpanel" id="sm-tabpanel" aria-labelledby={`sm-tab-${tab}`} data-sm-view={tab} inert={sheetOpen}>
                            {tab === "map" ? <MapTab {...tabProps} />
                                : tab === "connections" ? <ConnectionsTab {...tabProps} />
                                : tab === "schedule" ? <ScheduleTab {...tabProps} />
                                : tab === "routes" ? <RoutesTab {...tabProps} />
                                : tab === "drift" ? <DriftTab {...tabProps} />
                                : <BoundaryTab {...tabProps} />}
                        </div>
                        <SystemMapPanel index={index} panel={panel} onSelect={select} onClose={closePanel} headingRef={headingRef}
                            onShowOnMap={selectedId && tab !== "map" && !narrow ? showOnMap : null} />
                    </div>
                </>
            )}
        </div>
    );
}
