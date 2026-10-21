"use client"

import { useState, useEffect, useId, useRef } from "react";
import { X, BookOpen, Gauge, Settings, Cpu, WifiOff, Route, BrainCircuit, BarChart3, KanbanSquare, Clapperboard, ClipboardList, Send, GraduationCap, Landmark, Smartphone, FileCheck2, ShieldCheck, ExternalLink, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { getLocalOnlyMode, setLocalOnlyMode } from "@/lib/model-control";
import { ModelAliasManager } from "@/components/model-alias-manager";
import { postToShell, useMobileShell } from "@/lib/mobile-shell";

interface NavSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

interface NavItem {
  href: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  color: string;
  external?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The menu is a wide slide-over on desktop (grouped destinations in two
// columns beside the controls) and a full-width sheet on a phone. Projects
// live on the dashboard's Project Reference grid, not here. Header and footer
// stay pinned; only the middle scrolls, so Close and Settings are always on
// screen however short the window or large the text.
// It stacks above the voice dock (z-50) and connection banner (z-60) but
// under the audio mini player (z-90), whose space the footer keeps clear via
// --nexus-floating-overlay-bottom (lib/floating-controls).
export function NavSidebar({ isOpen, onClose, onOpenSettings }: NavSidebarProps) {
  const [localOnly, setLocalOnly] = useState<{ enabled: boolean; reason: string | null }>({ enabled: false, reason: null });
  const mobileShell = useMobileShell();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // True when pinned header + footer would leave the list too little room
  // (a small phone with large text). The whole panel then scrolls as one,
  // the header stays sticky so Close is always on screen, and the footer
  // follows the list.
  const [cramped, setCramped] = useState(false);

  useEffect(() => {
    const panel = panelRef.current;
    const header = headerRef.current;
    const footer = footerRef.current;
    if (!panel || !header || !footer || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = header.offsetHeight + footer.offsetHeight > panel.clientHeight * 0.4;
      setCramped(next);
      // Keyboard focus scrolled into view must clear the sticky header.
      panel.style.scrollPaddingTop = next ? `${header.offsetHeight}px` : "";
    };
    const observer = new ResizeObserver(measure);
    for (const el of [panel, header, footer]) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    getLocalOnlyMode()
      .then(setLocalOnly)
      .catch((err) => console.warn("Failed to load local-only mode:", err.message));
  }, []);

  const toggleLocalOnly = async () => {
    const next = !localOnly.enabled;
    const reason = next ? (localOnly.reason || "manual_override") : null;
    const updated = await setLocalOnlyMode(next, reason);
    setLocalOnly(updated);
  };

  // While open: Escape closes, Tab stays inside the menu, the page behind
  // does not scroll, and focus returns to whatever opened the menu.
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    // Safari and WKWebView do not focus a clicked button, so fall back to the menu trigger.
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body
      ? active
      : document.querySelector<HTMLElement>('button[aria-label="Open navigation menu"]');
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    panel?.focus({ preventScroll: true });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      root.style.overflow = previousOverflow;
      const active = document.activeElement;
      const focusLeftWithMenu = !active || active === document.body || (panel?.contains(active) ?? false);
      if (focusLeftWithMenu && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  const larsDashboardHref = "http://192.168.86.205:7878";

  // First: the queue of delivered documents waiting on Robert's decision.
  const reviewsItem: NavItem = { href: "/documents", label: "Reviews", hint: "Documents for your decision", icon: FileCheck2, color: "text-amber-300 hover:text-amber-200" };

  const navGroups: { title: string; items: NavItem[] }[] = [
    {
      title: "Operate",
      items: [
        { href: "/activity", label: "Activity", hint: "Live system report", icon: BarChart3, color: "text-teal-400 hover:text-teal-300" },
        { href: "/task-board", label: "Task Board", icon: KanbanSquare, color: "text-cyan-400 hover:text-cyan-300" },
        { href: "/ops", label: "Ops", hint: "Dispatch console", icon: Send, color: "text-cyan-400 hover:text-cyan-300" },
        { href: "/session", label: "Session", hint: "Access and operator check", icon: ShieldCheck, color: "text-emerald-400 hover:text-emerald-300" },
      ],
    },
    {
      title: "Knowledge and studio",
      items: [
        { href: "/academy", label: "Academy", hint: "Skill wiki", icon: GraduationCap, color: "text-pink-400 hover:text-pink-300" },
        { href: "/council", label: "Council Chamber", icon: Landmark, color: "text-amber-400 hover:text-amber-300" },
        { href: "/codex", label: "The Codex", icon: BookOpen, color: "text-pink-400 hover:text-pink-300" },
        { href: "/knowledge-ingestion", label: "Knowledge Ingestion", icon: BrainCircuit, color: "text-violet-400 hover:text-violet-300" },
        { href: "/intake-reports", label: "Intake Report Log", icon: ClipboardList, color: "text-teal-400 hover:text-teal-300" },
        { href: "/studio", label: "Studio", icon: Clapperboard, color: "text-violet-400 hover:text-violet-300" },
      ],
    },
    {
      title: "Models and systems",
      items: [
        { href: "/model-control", label: "Model Control", icon: Route, color: "text-cyan-400 hover:text-cyan-300" },
        { href: "/system-monitor", label: "System Monitor", icon: Gauge, color: "text-amber-400 hover:text-amber-300" },
        { href: larsDashboardHref, label: "LARS Dashboard", hint: "Opens in a new tab", icon: BarChart3, color: "text-emerald-400 hover:text-emerald-300", external: true },
      ],
    },
  ];

  const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900";

  const renderItem = (item: NavItem, featured = false) => {
    const className = featured
      ? `group flex min-h-14 items-center gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 transition-colors motion-reduce:transition-none hover:border-amber-300/60 hover:bg-amber-400/15 ${focusRing} ${item.color}`
      : `group flex min-h-11 items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 transition-colors motion-reduce:transition-none hover:border-slate-700 hover:bg-slate-950/80 ${focusRing} ${item.color}`;
    const body = (
      <>
        <item.icon size={featured ? 20 : 18} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={`block font-medium leading-snug [overflow-wrap:anywhere] ${featured ? "text-base" : "text-sm"}`}>{item.label}</span>
          {item.hint ? <span className="block text-xs leading-snug text-slate-400 [overflow-wrap:anywhere]">{item.hint}</span> : null}
        </span>
        {item.external ? <ExternalLink size={14} className="shrink-0 text-slate-500" aria-hidden="true" /> : null}
      </>
    );

    if (item.external) {
      return (
        <a
          key={item.href}
          href={item.href}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
          className={className}
        >
          {body}
        </a>
      );
    }

    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onClose}
        className={className}
      >
        {body}
      </Link>
    );
  };

  const sectionHeading = "flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500";

  // Visibility transitions only on close (hidden once the panel has slid out);
  // on open it must flip at once, or Chrome refuses the focus move into the panel.
  return (
    <div
      data-nav-menu=""
      inert={!isOpen}
      className={`fixed inset-0 z-[70] overflow-hidden ${isOpen ? 'visible' : 'invisible transition-[visibility] delay-300 duration-0 motion-reduce:delay-0'}`}
    >
      {/* Backdrop overlay */}
      <div
        className={`absolute inset-0 bg-slate-950/70 backdrop-blur-sm transition-opacity duration-300 motion-reduce:transition-none ${isOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-cramped={cramped ? "" : undefined}
        className={`absolute inset-y-0 left-0 flex w-full flex-col border-r border-slate-800 bg-slate-900 text-slate-200 shadow-2xl outline-none transition-transform duration-300 ease-in-out motion-reduce:transition-none sm:w-[min(72rem,calc(100%-3rem))] ${cramped ? 'overflow-y-auto overflow-x-hidden overscroll-contain' : ''} ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div ref={headerRef} className={`flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 pb-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:pl-6 ${cramped ? 'sticky top-0 z-10' : ''}`}>
          <h2 id={titleId} className="text-base font-bold leading-tight tracking-tight text-white sm:text-lg">THE NEXUS MENU</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors motion-reduce:transition-none hover:bg-slate-800 hover:text-white ${focusRing}`}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className={`pb-6 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-4 sm:px-6 ${cramped ? 'flex-none' : 'min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain'}`}>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
            <nav aria-label="Nexus destinations" className="min-w-0 space-y-5">
              {renderItem(reviewsItem, true)}
              {navGroups.map((group) => (
                <section key={group.title} aria-label={group.title}>
                  <h3 className={`${sectionHeading} mb-2 px-1`}>{group.title}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {group.items.map((item) => renderItem(item))}
                  </div>
                </section>
              ))}
            </nav>

            <section aria-label="Model controls" className="min-w-0 space-y-3">
              <h3 className={`${sectionHeading} px-1`}>Controls</h3>
              <div className={`rounded-lg border p-3 ${localOnly.enabled ? 'border-amber-500/40 bg-amber-500/10' : 'border-slate-800 bg-slate-950/40'}`}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="flex min-w-0 flex-1 basis-32 items-center gap-2">
                    {localOnly.enabled ? <WifiOff size={16} className="shrink-0 text-amber-300" aria-hidden="true" /> : <Cpu size={16} className="shrink-0 text-slate-400" aria-hidden="true" />}
                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${localOnly.enabled ? 'text-amber-200' : 'text-slate-300'}`}>Local Only</div>
                      <div className="truncate text-xs text-slate-500">{localOnly.enabled ? (localOnly.reason || 'manual_override') : 'Cloud enabled'}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={toggleLocalOnly}
                    className={`flex h-11 w-14 shrink-0 items-center justify-center rounded-full ${focusRing}`}
                    aria-pressed={localOnly.enabled}
                    aria-label="Toggle local-only mode"
                  >
                    <span className={`block h-6 w-11 rounded-full border p-0.5 transition-colors motion-reduce:transition-none ${localOnly.enabled ? 'border-amber-400/50 bg-amber-400/30' : 'border-slate-700 bg-slate-800'}`}>
                      <span className={`block h-4 w-4 rounded-full bg-white transition-transform motion-reduce:transition-none ${localOnly.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </span>
                  </button>
                </div>
              </div>

              {/* Phone-sized touch targets for the alias form without changing the shared component. */}
              <div className="max-lg:[&_button]:min-h-11 max-lg:[&_input]:min-h-11 max-lg:[&_select]:min-h-11">
                <ModelAliasManager compact />
              </div>
            </section>
          </div>
        </div>

        {/* Footer, pinned unless cramped. In the Android shell the two settings buttons share a row when they fit (a rem minimum, so large text stacks them). */}
        <div ref={footerRef} className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(min(10rem,100%),1fr))] gap-2 border-t border-slate-800 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom),var(--nexus-floating-overlay-bottom,0px))] sm:flex sm:flex-wrap sm:px-6">
          {mobileShell ? (
            <button
              type="button"
              onClick={() => {
                postToShell({ type: "open-settings" });
                onClose();
              }}
              className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-left text-slate-400 transition-colors motion-reduce:transition-none hover:bg-slate-950/80 hover:text-white sm:w-auto sm:min-w-64 sm:px-4 ${focusRing}`}
            >
              <Smartphone size={18} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block font-medium leading-snug">Connection settings</span>
                <span className="block truncate font-mono text-[10px] uppercase tracking-wider text-slate-500">app v{mobileShell.appVersion}</span>
              </span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-slate-400 transition-colors motion-reduce:transition-none hover:bg-slate-950/80 hover:text-white sm:w-auto sm:min-w-56 sm:px-4 ${focusRing}`}
          >
            <Settings size={18} className="shrink-0" aria-hidden="true" />
            <span className="font-medium">Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}
