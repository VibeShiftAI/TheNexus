import Link from "next/link";
import { ChevronRight } from "lucide-react";

type Breadcrumb = { label: string; href: string };

/** Explicit ancestry keeps navigation useful even when a page is opened directly. */
export function Breadcrumbs({
  current,
  parents = [],
  className = "",
}: {
  current: string;
  parents?: Breadcrumb[];
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={`min-w-0 max-w-full shrink-0 text-sm ${className}`}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        {[{ label: "Dashboard", href: "/" }, ...parents].map(({ label, href }) => (
          <li key={href} className="flex min-w-0 max-w-full items-center gap-1.5">
            <Link
              href={href}
              title={label}
              className="max-w-48 truncate rounded py-1 text-slate-400 transition-colors hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            >
              {label}
            </Link>
            <ChevronRight size={14} className="shrink-0 text-slate-600" aria-hidden="true" />
          </li>
        ))}
        <li className="min-w-0 max-w-full">
          <span aria-current="page" title={current} className="block max-w-48 truncate py-1 text-slate-200">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}
