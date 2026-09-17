/** Keep authored prose readable while preserving its complete metadata. */
export function vaultDocumentParts(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return {
    metadata: match?.[1] ?? "",
    body: match ? content.slice(match[0].length) : content,
  };
}
export function vaultDocumentLink(href: string, currentPath: string) {
  if (/^[a-z][a-z\d+.-]*:|^\/\/|^#/.test(href)) return href;
  const root = /^(memories|skills|projects|incidents|workflows|_journal)\//;
  const relative = href.replace(/^\/Volumes\/Projects\/shared-mind\//, "");
  const path = root.test(relative)
    ? relative
    : new URL(relative, `https://vault.invalid/${currentPath}`).pathname.slice(
        1,
      );
  if (root.test(path) && /\.md(?:#.*)?$/.test(path))
    return `/activity?document=${encodeURIComponent(path.split("#")[0])}`;
  return href;
}
