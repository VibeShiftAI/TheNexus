/**
 * Which vendor logo file marks which executor on the Ops graphic.
 *
 * The SVG files live in `dashboard/public/brand/` and are unmodified copies
 * from a licensed icon package; their source, checksums and usage terms are in
 * `dashboard/public/brand/NOTICE.md`. Kept in lib/ (not beside the component)
 * so the component module exports components only and stays a fast-refresh
 * boundary.
 */

export interface ProviderLogoAsset {
  src: string;
  /**
   * How the file is painted. "image": the file carries its own colours.
   * "mask": the file paints with `currentColor`, which an <img> cannot supply,
   * so the unchanged shape is used as a CSS mask and the panel supplies the fill.
   */
  paint: "image" | "mask";
  /** Product name, as the vendor writes it. */
  name: string;
}

export const PROVIDER_LOGOS: Record<string, ProviderLogoAsset> = {
  "claude-code": { src: "/brand/claude-color.svg", paint: "image", name: "Claude" },
  codex: { src: "/brand/codex.svg", paint: "mask", name: "Codex" },
  antigravity: { src: "/brand/antigravity-color.svg", paint: "image", name: "Antigravity" },
  "local-llm": { src: "/brand/lmstudio.svg", paint: "mask", name: "LM Studio" },
};

/** The asset for a provider, or null when the repo holds no vendor file for it. */
export function providerLogo(provider: string): ProviderLogoAsset | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LOGOS, provider) ? PROVIDER_LOGOS[provider] : null;
}
