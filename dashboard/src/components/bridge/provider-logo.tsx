/**
 * ProviderLogo: the vendor's own mark for an executor node on the Ops graphic.
 * The file table, and the note on where the files come from, is in
 * `lib/provider-logos.ts`. A provider with no vendor file renders nothing, so
 * the caller keeps the glyph it used before.
 */
import type { CSSProperties } from "react";
import { providerLogo } from "@/lib/provider-logos";

export function ProviderLogo({ provider, size }: { provider: string; size: number }) {
  const asset = providerLogo(provider);
  if (!asset) return null;
  if (asset.paint === "image") {
    // A plain <img>: next/image adds nothing for a 2 KB local SVG.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="dispatch-logo-mark" data-logo={provider} src={asset.src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
  }
  const mask = `url(${asset.src}) center / contain no-repeat`;
  const style: CSSProperties = { width: size, height: size, WebkitMask: mask, mask };
  return <span className="dispatch-logo-mark dispatch-logo-mask" data-logo={provider} style={style} aria-hidden="true" />;
}
