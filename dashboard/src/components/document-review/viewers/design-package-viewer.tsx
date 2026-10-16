"use client";

/**
 * Design package stage (contract §2): directions across the top, a screen
 * filmstrip, one large screen on the stage with before/after and region
 * comments, a compare mode that lines the same screen up across directions,
 * and tabs for the interactive previews, tokens and evidence the package
 * carries. Everything is addressed by asset key, so a comment made here says
 * exactly which screen of which revision it is about.
 */

import { useEffect, useMemo, useState } from "react";
import { Columns3, Moon, Sun, Star } from "lucide-react";
import { assetUrl, type DesignManifest, type Region, type RevisionAsset } from "@/lib/document-review";
import { ImageViewer, type ImagePin } from "./image-viewer";
import { PrototypeViewer, type PointPin } from "./prototype-viewer";

export interface DesignPins {
    /** Pins per asset key (screens and previews). */
    byAsset: Record<string, (ImagePin & { point?: { x: number; y: number } | null; viewport?: string | null })[]>;
    selectedId: string | null;
    onSelect: (id: string) => void;
}

export interface DesignPackageViewerProps {
    documentId: string;
    revisionId: string | null;
    manifest: DesignManifest;
    assets: RevisionAsset[];
    pins: DesignPins;
    annotate?: boolean;
    onScreenRegion?: (assetKey: string, region: Region) => void;
    onPreviewPoint?: (assetKey: string, point: { x: number; y: number; viewport: string }) => void;
    onLoadState?: (assetKey: string, state: "loaded" | "failed") => void;
    /** The screen the review rail asked for (a comment tapped). */
    requestedAssetKey?: string | null;
    /** The direction the operator selected on approval, if any. */
    selectedDirection?: string | null;
    onActiveScreenChange?: (asset: RevisionAsset | null) => void;
}

type Tab = "screens" | "previews" | "tokens" | "evidence";

export function DesignPackageViewer({ documentId, revisionId, manifest, assets, pins, annotate = false, onScreenRegion, onPreviewPoint, onLoadState, requestedAssetKey, selectedDirection, onActiveScreenChange }: DesignPackageViewerProps) {
    const screens = useMemo(() => assets.filter((a) => a.role === "screen"), [assets]);
    const directions = manifest.directions ?? [];
    const [direction, setDirection] = useState<string | "all">(directions.length > 1 ? (directions.find((d) => d.recommended)?.id ?? directions[0].id) : "all");
    const [appearance, setAppearance] = useState<"light" | "dark" | "all">(() => (screens.some((s) => s.appearance === "light") ? "light" : screens.some((s) => s.appearance === "dark") ? "dark" : "all"));
    const [activeKey, setActiveKey] = useState<string | null>(null);
    const [compare, setCompare] = useState(false);
    const [tab, setTab] = useState<Tab>("screens");
    const [tokens, setTokens] = useState<string | null>(null);

    const visible = useMemo(() => screens.filter((s) => (direction === "all" || !s.direction || s.direction === direction) && (appearance === "all" || !s.appearance || s.appearance === appearance)), [screens, direction, appearance]);
    const active = visible.find((s) => s.asset_key === activeKey) ?? screens.find((s) => s.asset_key === activeKey) ?? visible[0] ?? screens[0] ?? null;

    useEffect(() => {
        if (!requestedAssetKey) return;
        const asset = assets.find((a) => a.asset_key === requestedAssetKey);
        if (!asset) return;
        if (asset.role === "screen") {
            setTab("screens");
            setActiveKey(asset.asset_key);
            if (asset.direction && direction !== "all" && asset.direction !== direction) setDirection(asset.direction);
            if (asset.appearance && appearance !== "all" && asset.appearance !== appearance) setAppearance(asset.appearance);
        } else if (asset.role === "preview") {
            setTab("previews");
            setActiveKey(asset.asset_key);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestedAssetKey]);

    useEffect(() => { onActiveScreenChange?.(tab === "screens" ? active : null); }, [active, tab, onActiveScreenChange]);

    useEffect(() => {
        if (tab !== "tokens" || tokens !== null) return;
        const tokenAsset = assets.find((a) => a.asset_key === "tokens");
        if (!tokenAsset) { setTokens(""); return; }
        fetch(assetUrl(documentId, "tokens", { revision: revisionId }), { credentials: "include" })
            .then((r) => r.text())
            .then((text) => { try { setTokens(JSON.stringify(JSON.parse(text), null, 2)); } catch { setTokens(text); } })
            .catch(() => setTokens("Could not load tokens."));
    }, [tab, tokens, assets, documentId, revisionId]);

    const url = (key: string) => assetUrl(documentId, key, { revision: revisionId });
    const screenMeta = (s: RevisionAsset) => [s.direction && directions.find((d) => d.id === s.direction)?.title, s.appearance, s.viewport, s.state].filter(Boolean).join(" · ");
    const previews = assets.filter((a) => a.role === "preview");
    const evidence = assets.filter((a) => a.role === "evidence");
    const activePreview = previews.find((p) => p.asset_key === activeKey) ?? previews[0] ?? null;

    // Compare: the same screen title in every direction (for the chosen appearance).
    const compareRows = useMemo(() => {
        if (!compare || directions.length < 2) return [];
        const titles = [...new Set(screens.filter((s) => appearance === "all" || !s.appearance || s.appearance === appearance).map((s) => s.label))];
        return titles.map((title) => ({ title, cells: directions.map((d) => screens.find((s) => s.label === title && s.direction === d.id && (appearance === "all" || !s.appearance || s.appearance === appearance)) ?? null) }));
    }, [compare, directions, screens, appearance]);

    const tabButton = (id: Tab, label: string, count?: number) => (
        <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id} className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${tab === id ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`} data-design-tab={id}>
            {label}{typeof count === "number" ? <span className="ml-1 text-slate-500">{count}</span> : null}
        </button>
    );

    return (
        <div className="space-y-3" data-design-viewer="">
            {/* Directions */}
            {directions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2" data-design-directions="">
                    {directions.length > 1 && (
                        <button type="button" onClick={() => setDirection("all")} aria-pressed={direction === "all"} className={`rounded-full border px-3 py-1 text-xs ${direction === "all" ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-100" : "border-slate-700 text-slate-300 hover:border-slate-500"}`}>All</button>
                    )}
                    {directions.map((d) => (
                        <button key={d.id} type="button" onClick={() => { setDirection(d.id); setCompare(false); }} aria-pressed={direction === d.id} data-design-direction={d.id} title={d.summary ?? undefined}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${direction === d.id ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-100" : "border-slate-700 text-slate-300 hover:border-slate-500"}`}>
                            <span className="font-mono text-[10px] text-slate-400">{d.id}</span> {d.title}
                            {d.recommended && <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-400/15 px-1.5 text-[10px] text-amber-200" title="Recommended by the producer"><Star size={9} /> rec.</span>}
                            {selectedDirection === d.id && <span className="rounded-full bg-sky-400/20 px-1.5 text-[10px] text-sky-100" data-design-selected="">selected</span>}
                        </button>
                    ))}
                    {directions.length > 1 && (
                        <button type="button" onClick={() => setCompare((c) => !c)} aria-pressed={compare} className={`ml-auto inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs ${compare ? "border-cyan-400/60 text-cyan-100" : "border-slate-700 text-slate-300 hover:border-slate-500"}`} data-design-compare="">
                            <Columns3 size={13} /> Compare directions
                        </button>
                    )}
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-2">
                {tabButton("screens", "Screens", screens.length)}
                {previews.length > 0 && tabButton("previews", "Previews", previews.length)}
                {assets.some((a) => a.asset_key === "tokens") && tabButton("tokens", "Tokens")}
                {evidence.length > 0 && tabButton("evidence", "Evidence", evidence.length)}
                {screens.some((s) => s.appearance) && (
                    <div className="ml-auto inline-flex rounded-md border border-slate-700 p-0.5 text-[11px]" role="group" aria-label="Appearance">
                        {(["light", "dark", "all"] as const).map((mode) => (
                            <button key={mode} type="button" onClick={() => setAppearance(mode)} aria-pressed={appearance === mode} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${appearance === mode ? "bg-slate-800 text-white" : "text-slate-400"}`} data-design-appearance={mode}>
                                {mode === "light" ? <Sun size={11} /> : mode === "dark" ? <Moon size={11} /> : null} {mode === "all" ? "Both" : mode}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {tab === "screens" && compare && compareRows.length > 0 && (
                <div className="space-y-4" data-design-compare-grid="">
                    {compareRows.map((row) => (
                        <div key={row.title ?? ""}>
                            <div className="mb-1 text-xs font-semibold text-slate-200">{row.title}</div>
                            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${directions.length}, minmax(0, 1fr))` }}>
                                {row.cells.map((cell, i) => (
                                    <div key={directions[i].id} className="min-w-0">
                                        <div className="mb-1 text-[11px] text-slate-400"><span className="font-mono">{directions[i].id}</span> {directions[i].title}</div>
                                        {cell ? (
                                            <button type="button" onClick={() => { setCompare(false); setDirection(directions[i].id); setActiveKey(cell.asset_key); }} className="block w-full overflow-hidden rounded-lg border border-slate-800 hover:border-cyan-500/60" aria-label={`Open ${cell.label} in ${directions[i].title}`}>
                                                <img src={url(cell.asset_key)} alt={`${cell.label} (${directions[i].title})`} className="block w-full" onLoad={() => onLoadState?.(cell.asset_key, "loaded")} onError={() => onLoadState?.(cell.asset_key, "failed")} />
                                            </button>
                                        ) : (
                                            <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-slate-800 text-[11px] text-slate-600">no screen</div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {tab === "screens" && !compare && (
                <div className="lg:grid lg:grid-cols-[132px_minmax(0,1fr)] lg:gap-3">
                    {/* Filmstrip */}
                    <ol className="mb-3 flex gap-2 overflow-x-auto pb-1 lg:mb-0 lg:max-h-[72vh] lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden" data-design-filmstrip="">
                        {visible.map((s, i) => {
                            const count = pins.byAsset[s.asset_key]?.length ?? 0;
                            const isActive = active?.asset_key === s.asset_key;
                            return (
                                <li key={s.asset_key} className="shrink-0">
                                    <button type="button" onClick={() => setActiveKey(s.asset_key)} aria-pressed={isActive} data-design-screen={s.asset_key}
                                        className={`relative block w-28 overflow-hidden rounded-lg border text-left ${isActive ? "border-cyan-400/70 ring-1 ring-cyan-400/40" : "border-slate-800 hover:border-slate-600"}`}>
                                        <img src={url(s.asset_key)} alt="" className="block h-20 w-full object-cover object-top" loading="lazy" />
                                        <span className="block truncate px-1.5 py-1 text-[10px] text-slate-300"><span className="text-slate-500">{i + 1}</span> {s.label}</span>
                                        {count > 0 && <span className="absolute right-1 top-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-slate-950">{count}</span>}
                                    </button>
                                </li>
                            );
                        })}
                        {visible.length === 0 && <li className="text-[11px] text-slate-500">No screens for this direction and appearance.</li>}
                    </ol>
                    {active && (
                        <div className="min-w-0">
                            <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-xs">
                                <span className="font-semibold text-slate-100" data-design-active-title="">{active.label}</span>
                                <span className="text-slate-400">{screenMeta(active)}</span>
                                {active.width && active.height && <span className="ml-auto font-mono text-[10px] text-slate-500">{active.width}×{active.height}</span>}
                            </div>
                            <ImageViewer
                                key={active.asset_key}
                                src={url(active.asset_key)}
                                alt={active.label ?? active.asset_key}
                                assetKey={active.asset_key}
                                width={active.width}
                                height={active.height}
                                beforeSrc={active.before_asset_key ? url(active.before_asset_key) : null}
                                pins={pins.byAsset[active.asset_key] ?? []}
                                selectedPinId={pins.selectedId}
                                onSelectPin={pins.onSelect}
                                annotate={annotate}
                                onRegion={onScreenRegion ? (region) => onScreenRegion(active.asset_key, region) : undefined}
                                onLoadState={onLoadState}
                            />
                            {manifest.screens.find((s) => `screen:${s.id}` === active.asset_key)?.notes && (
                                <p className="mt-2 rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-300" data-design-notes="">
                                    {manifest.screens.find((s) => `screen:${s.id}` === active.asset_key)?.notes}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {tab === "previews" && activePreview && (
                <div>
                    {previews.length > 1 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                            {previews.map((p) => (
                                <button key={p.asset_key} type="button" onClick={() => setActiveKey(p.asset_key)} aria-pressed={activePreview.asset_key === p.asset_key} className={`rounded-md border px-2 py-1 text-[11px] ${activePreview.asset_key === p.asset_key ? "border-cyan-400/60 text-cyan-100" : "border-slate-700 text-slate-300"}`}>{p.label}</button>
                            ))}
                        </div>
                    )}
                    {activePreview.media_type === "html" ? (
                        <PrototypeViewer
                            key={activePreview.asset_key}
                            src={url(activePreview.asset_key)}
                            assetKey={activePreview.asset_key}
                            title={activePreview.label ?? "Preview"}
                            pins={(pins.byAsset[activePreview.asset_key] ?? []).filter((p) => p.point).map((p) => ({ id: p.id, index: p.index, x: p.point!.x, y: p.point!.y, viewport: p.viewport, label: p.label, resolved: p.resolved }) as PointPin)}
                            selectedPinId={pins.selectedId}
                            onSelectPin={pins.onSelect}
                            annotate={annotate}
                            onPoint={onPreviewPoint ? (point) => onPreviewPoint(activePreview.asset_key, point) : undefined}
                            onLoadState={onLoadState}
                            defaultViewport={activePreview.viewport}
                        />
                    ) : (
                        <ImageViewer key={activePreview.asset_key} src={url(activePreview.asset_key)} alt={activePreview.label ?? "Preview"} assetKey={activePreview.asset_key} width={activePreview.width} height={activePreview.height} pins={pins.byAsset[activePreview.asset_key] ?? []} selectedPinId={pins.selectedId} onSelectPin={pins.onSelect} annotate={annotate} onRegion={onScreenRegion ? (region) => onScreenRegion(activePreview.asset_key, region) : undefined} onLoadState={onLoadState} />
                    )}
                </div>
            )}

            {tab === "tokens" && (
                <pre className="max-h-[70vh] overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-300" data-design-tokens="">{tokens ?? "Loading tokens…"}</pre>
            )}

            {tab === "evidence" && (
                <ul className="space-y-2" data-design-evidence="">
                    {evidence.map((e) => (
                        <li key={e.asset_key} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs">
                            <span className="font-medium text-slate-100">{e.label}</span>
                            <span className="font-mono text-[10px] text-slate-500" title={e.content_hash}>{e.media_type} · {e.content_hash.slice(0, 12)}</span>
                            <a href={url(e.asset_key)} target="_blank" rel="noopener noreferrer" className="ml-auto text-cyan-300 hover:underline">Open</a>
                        </li>
                    ))}
                    {manifest.source?.project_url && (
                        <li className="text-[11px] text-slate-400">Source: {manifest.source.provider ?? "design tool"} · <a href={manifest.source.project_url} target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:underline">open the design project</a> (external; this package is the record)</li>
                    )}
                </ul>
            )}
        </div>
    );
}
