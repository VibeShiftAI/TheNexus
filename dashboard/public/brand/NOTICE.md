# Provider logos: source and usage terms

The Ops graphic (`dashboard/src/components/bridge/dispatch-map.tsx`, through
`provider-logo.tsx`) identifies each executor with its vendor's mark. The four
SVG files in this folder are byte-for-byte copies from one licensed icon
package. Nothing was redrawn, traced, recoloured in the file or otherwise
edited.

## Source

- Package: `@lobehub/icons-static-svg`, version `1.106.0`
- Registry tarball: `https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-1.106.0.tgz`
- Tarball SHA-256: `fb1900cf0cfddf6a5ef947db57f951335602ad422bffff03ba9dc31390572b34`
- npm integrity: `sha512-yRLkEGfCsOh6ZDSIPsA6HrI1ynh9gI1LECZaeFIzpuEHv9ON2i+SzwLnE2iYfW/agsms54QL+OhPde9WpEi/uA==`
- Upstream repository: `https://github.com/lobehub/lobe-icons`
- Retrieved: 2026-11-23

| File here | Path in the package | Node it marks | SHA-256 of the file |
| --- | --- | --- | --- |
| `claude-color.svg` | `icons/claude-color.svg` | Claude Code | `a3101f3047a119aa11825ad9369510f0c472428c8c52d420e31bc62db44a8364` |
| `codex.svg` | `icons/codex.svg` | Codex | `d08b4e824cd6727e89617f59e4737273ff53e44c1da849d016dd64dfd08b33e1` |
| `antigravity-color.svg` | `icons/antigravity-color.svg` | Antigravity | `652128cf55a28bb958563ee372d0bd00208d9e6fd446f523f77aafd811eef8ca` |
| `lmstudio.svg` | `icons/lmstudio.svg` | Local LLM (LM Studio) | `4a575e8382b52ce742ac5d21d361a7d2a08cea7c12390ee1bbb755ef7d3cc25b` |

To check a file against its source: download the tarball, compare its SHA-256
with the value above, then compare `package/icons/<name>.svg` with the file here.

## Usage terms

- **The files.** The package is published under the MIT License, copyright (c)
  2023 LobeHub (`"license": "MIT"` in its `package.json`; full text at
  `https://github.com/lobehub/lobe-icons/blob/master/LICENSE`). MIT allows
  copying and redistribution as long as the copyright and permission notice
  travel with the copies. This file is that notice for the four files above.
- **The marks.** The MIT licence covers the SVG files, not the trademarks they
  show. "Claude" and its mark belong to Anthropic, "Codex" and its mark to
  OpenAI, "Antigravity" and its mark to Google, and "LM Studio" and its mark to
  Element Labs. No trademark licence was sought or obtained from any of them.
  The marks are used here only to name the vendor's own product inside a
  private operations dashboard, at small size, unaltered, with no suggestion of
  endorsement.
- **Rendering.** `codex.svg` and `lmstudio.svg` are single-colour files that
  paint with `currentColor`. The dashboard shows them through a CSS mask so the
  unchanged shape takes a light colour on the dark panel. The two `-color`
  files are shown as images with their own colours.

## Nodes that kept their previous icon

- **OpenRouter** keeps its arrow glyph. The task named four vendors (Claude,
  Codex, Antigravity, LM Studio); OpenRouter was not one of them.
- **A worker the dashboard has no logo for** (a new executor name reported by
  Praxis) shows the first letter of its name, as before.
- **The Praxis hub** keeps its own mark, as the task asked.
