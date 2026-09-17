import type { ReactNode } from "react";

export const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none";
export const buttonClass =
  "rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-40";
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1 text-xs text-slate-400">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function EvidenceRef({ refValue }: { refValue: string }) {
  if (/^https?:\/\//i.test(refValue))
    return (
      <a
        href={refValue}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-cyan-300 underline"
      >
        {refValue}
      </a>
    );
  return <span className="break-all font-mono text-cyan-300">{refValue}</span>;
}

export function Status({ value }: { value: string }) {
  const color =
    value === "pass" || value === "satisfied"
      ? "text-emerald-300 border-emerald-800"
      : value === "fail" || value === "stale"
        ? "text-amber-300 border-amber-800"
        : "text-slate-300 border-slate-700";
  return (
    <span
      className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] uppercase ${color}`}
    >
      {value.replaceAll("_", " ")}
    </span>
  );
}
