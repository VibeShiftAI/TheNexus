# Review media and design packages: consumer contract v1

Owner: Nexus review surface redesign, 2026-10-16 (Robert's request; technical
upgrades proposed by Astra). Consumers: the Praxis document delivery handoff
(`Praxis/src/documents/delivery.ts`), the Praxis design pipeline
(`Praxis/src/design/`), and the Nexus dashboard reviewer
(`dashboard/src/components/document-review/`).

This contract extends the Markdown document registry and the declared
deliverable contract (`document-review-deliverables.md`). Everything there
still holds: server-issued ids, allowlisted project roots, immutable
revisions identified by the SHA-256 of the exact delivered bytes, append-only
decisions pinned to one revision, review rounds whose feedback is delivered
verbatim to Praxis. This document adds:

1. a media model: which file types the registry accepts, how each is hashed,
   stored and served;
2. the design package: one manifest file that binds screens, directions,
   before/after pairs, tokens, previews and evidence into one versioned
   deliverable with one content hash;
3. anchored comments for non-text media (regions, timestamps, pages, screens);
4. direct editing of text media from the reviewer, producing a new revision;
5. a readiness check that says whether a revision's required visuals actually
   load through the authenticated review routes, and the completion rule that
   depends on it.

## 1. Media model

A registered file is classified by its extension (both as given and after
symlink resolution; a mismatch is refused as before).

| media_type | Extensions | Stored as | Max bytes | Editable in Nexus | Viewer |
|---|---|---|---|---|---|
| `markdown` | `.md` `.markdown` | normalized text + exact bytes | 2 MB | yes | rendered Markdown with per-block comments |
| `text` | `.txt` `.csv` `.tsv` `.yaml` `.yml` `.toml` `.env.example` | text | 2 MB | yes | monospace text |
| `code` | `.js` `.mjs` `.cjs` `.ts` `.tsx` `.jsx` `.py` `.swift` `.kt` `.java` `.go` `.rs` `.rb` `.sh` `.zsh` `.css` `.scss` `.sql` | text | 2 MB | yes | code editor |
| `json` | `.json` (not `.design.json`) | text | 2 MB | yes | code editor |
| `html` | `.html` `.htm` | text | 8 MB | yes | sandboxed prototype frame + source |
| `svg` | `.svg` | text | 4 MB | yes | image (sandboxed) + source |
| `image` | `.png` `.jpg` `.jpeg` `.webp` `.gif` `.avif` | bytes (blob store) | 40 MB | no | zoomable image, region comments |
| `video` | `.mp4` `.m4v` `.webm` `.mov` | bytes (blob store up to 512 MB, otherwise disk) | 2 GB | no | player with frame step, timestamp comments |
| `audio` | `.mp3` `.m4a` `.wav` `.ogg` | bytes (blob store) | 200 MB | no | player, timestamp comments |
| `pdf` | `.pdf` | bytes (blob store) | 100 MB | no | page viewer, page comments |
| `design` | `.design.json` | manifest text + member assets | manifest 1 MB, members per their own type | manifest yes | design package viewer |

"Text" types keep today's two identities: a legacy (undeclared) registration is
identified by the line-normalized text, a declared deliverable by the exact
bytes. Binary types are always identified by the exact bytes. Line counts are
`0` for binary types.

### 1.1 Blob store

Binary revisions are copied, content-addressed, into the review blob store on
capture so a later edit or deletion of the file on disk never loses the bytes a
decision was recorded against. Location: `NEXUS_REVIEW_BLOB_DIR`, default
`<repo>/data/review-blobs/<hash[0:2]>/<hash>`. A video above 512 MB is not
copied; its route serves from disk and refuses with `409 asset_changed` when
the bytes on disk no longer hash to the revision.

### 1.2 Routes

- `GET /api/documents/:id/raw?revision=&download=1` serves the bytes of a
  text revision as today. For a binary or design revision it serves the same
  bytes as the primary asset route below (the manifest for a design package),
  with the media type's content type.
- `GET /api/documents/:id/assets/:assetKey?revision=&download=1` streams one
  asset of a revision with `Accept-Ranges: bytes` (Range requests honoured for
  video and audio), `X-Content-Type-Options: nosniff`, `X-Document-Revision`
  (the revision content hash) and `X-Asset-Hash`. HTML and SVG assets are
  served with `Content-Security-Policy: sandbox allow-scripts; default-src
  'self' data: blob:` so a prototype can run but cannot reach the dashboard
  session. The asset key of a single-file document is `primary`.
- `GET /api/documents/:id/readiness?revision=` runs the readiness check (§5).
- `PUT /api/documents/:id/content` edits a text revision (§4).

Every route is relative, same-origin and behind the dashboard session, so it
works from the phone shell through the tunnel without any other sign-in.

### 1.3 Registration and receipts

`POST /api/documents` is unchanged in shape. `kind` gains the values
`design`, `image`, `video`, `audio`, `prototype`, `pdf` and `data`; kind
remains the producer's description of purpose, media_type is derived from the
file and is authoritative for how the file is handled. The document record,
the list entry and the receipt carry:

- `media_type` (table above), `mime_type`;
- `asset_count`: 1 for a single file, the number of members plus one for a
  design package;
- `readiness_path`: `/api/documents/<id>/readiness?revision=<revision_id>`;
- `preview_asset_key`: the asset to show as a thumbnail (`primary` for images;
  the first screen of a design package; null otherwise).

The receipt's `content_hash` is the revision hash defined in §2.3 for a design
package and the exact-bytes SHA-256 for every other type. A producer that
pre-computes `expected_content_hash` must use the same algorithm.

## 2. Design package

A design package is a directory of exports described by one manifest file
whose name ends in `.design.json`. The manifest is what gets registered; its
members are resolved relative to the manifest's directory and must sit inside
the same project root, be of an allowed media type and respect that type's
size limit. Members outside the root, through a symlink or otherwise, refuse
the whole registration (`403 symlink_escape` / `outside_roots`).

### 2.1 Manifest schema (`format: "nexus-design-package/1"`)

```json
{
  "format": "nexus-design-package/1",
  "title": "Succession redesign (HWC09)",
  "summary": "Three statement directions across eleven screens.",
  "directions": [
    { "id": "1a", "title": "Editorial hairline", "summary": "…", "recommended": true },
    { "id": "1b", "title": "Ink masthead" },
    { "id": "1c", "title": "Parchment surfaces" }
  ],
  "screens": [
    {
      "id": "S1-light-1a",
      "title": "Statement",
      "direction": "1a",
      "appearance": "light",
      "viewport": "iphone-15-pro",
      "state": "default",
      "file": "export/s1-1a-light.png",
      "before": "before/s1.png",
      "notes": "Hairline rules, oxblood debits."
    }
  ],
  "tokens": "export/tokens.json",
  "previews": [
    { "id": "proto-light", "title": "Screens (light)", "file": "export/screens-light.dc.html", "viewport": "iphone-15-pro" }
  ],
  "evidence": [
    { "id": "sums", "label": "SHA256SUMS", "file": "export/SHA256SUMS" },
    { "id": "session", "label": "Claude Design session record", "file": "design-session.md" }
  ],
  "source": {
    "provider": "claude-design",
    "project_id": "efc6cadb-239c-4931-8375-6540904b213e",
    "project_url": "https://claude.ai/design/p/efc6cadb-239c-4931-8375-6540904b213e",
    "session_id": "hwc09-2026-10-16",
    "stage": "review_direction"
  }
}
```

Rules:

- `format`, `title` and at least one `screens` entry are required. `screens[].id`,
  `screens[].title` and `screens[].file` are required; `file` must be an
  `image` or `svg`, `before` likewise when present. Ids are unique within
  their array and match `^[A-Za-z0-9._-]{1,80}$`.
- `direction`, when present, names an id in `directions`. A package with two
  or more directions is a direction-selection package: approving it records
  the selected direction (§3.3).
- `appearance` is `light` or `dark` when present; `viewport` and `state` are
  free short labels (max 60 chars).
- `tokens`, when present, is a `json` member. `previews[].file` is `html`,
  `svg` or `image`. `evidence[].file` is any allowed text media type or `pdf`.
- At most 400 members in total; the manifest itself at most 1 MB.

### 2.2 Asset keys

Every member gets a stable asset key used in the asset route and in comment
anchors: `screen:<id>`, `before:<screen id>`, `tokens`, `preview:<id>`,
`evidence:<id>`. The manifest itself is `primary`.

### 2.3 Package hash

```
package_hash = sha256(
  sha256(manifest bytes) + "\n" +
  for each member sorted by asset key (byte order): asset_key + "\t" + sha256(member bytes) + "\n"
)
```

encoded as lowercase hex. This is the revision `content_hash` of a design
package. Any change to the manifest or to any member therefore yields a new
revision, so a decision or receipt on an earlier revision never covers new
pixels. Member bytes are copied into the blob store on capture like any
binary revision.

### 2.3.1 Test vector

Added 2026-10-16 by the Praxis consumer (`Praxis/src/documents/media.ts`,
`packageHash`; asserted in `Praxis/tests/document_media.test.ts`). It pins the
two readings §2.3 leaves open: every inner `sha256(...)` is its lowercase hex
text (64 characters), and "byte order" means the UTF-8 bytes of the asset key,
so `before:S1` < `screen:S1` < `tokens` regardless of manifest order.

Manifest bytes (one line, then a single `\n`; 155 bytes):

```
{"format":"nexus-design-package/1","title":"Vector","screens":[{"id":"S1","title":"One","file":"s1.png","before":"before/s1.png"}],"tokens":"tokens.json"}
```

| asset key | member bytes | sha256 |
|---|---|---|
| (manifest) | as above | `ad228764673cf36461c810083ac144119c4f9edac82dcc39e6a27f82c4ceb0bc` |
| `screen:S1` | `PNG-S1\n` | `0f2ec07e3779e7ccc21ab1ca6b2622325fabdb60e3a0fd370ae110a7f0c02f41` |
| `before:S1` | `PNG-S1-before\n` | `ba8fec3b8fa76404f1fa3e2751482ee87cf52a197ae9471b18272e1c987b740c` |
| `tokens` | `{}\n` | `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356` |

Hash preimage (tabs and newlines shown escaped):

```
ad228764673cf36461c810083ac144119c4f9edac82dcc39e6a27f82c4ceb0bc\n
before:S1\tba8fec3b8fa76404f1fa3e2751482ee87cf52a197ae9471b18272e1c987b740c\n
screen:S1\t0f2ec07e3779e7ccc21ab1ca6b2622325fabdb60e3a0fd370ae110a7f0c02f41\n
tokens\tca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356\n
```

```
package_hash = 67a549e813692da05f2f29238e5b23d32df92a3cc6a8923d955878c8f1154cf6
```

A producer or consumer whose implementation yields a different value for
these inputs is not computing the §2.3 revision hash.

### 2.4 Revision assets

`GET /api/documents/:id` and `GET /api/documents/:id/revisions/:revisionId`
return, for a design revision, `assets`: the ordered list of
`{ asset_key, role, path, media_type, mime_type, byte_length, content_hash,
label, direction, appearance, viewport, state, before_asset_key, order,
width, height }` (`width`/`height` for images when known) and `manifest`: the
parsed manifest. Comments and the viewer address members only by asset key.

## 3. Comments and decisions on media

### 3.1 Comment anchors

`POST /api/documents/reviews/:reviewId/comments` keeps `kind: "passage" |
"document"` for Markdown and text. It adds:

| kind | anchor object | Verified against the pinned revision |
|---|---|---|
| `region` | `{ asset_key, x, y, w, h }` normalized 0..1, `w`,`h` > 0 | asset exists in the revision and is `image`/`svg`/`html`/`pdf` |
| `point` | `{ asset_key, x, y, viewport? }` | asset exists; used for prototypes |
| `time` | `{ asset_key, t_start, t_end? }` seconds ≥ 0, `t_end ≥ t_start` | asset is `video`/`audio` |
| `page` | `{ asset_key, page, x?, y?, w?, h? }` page ≥ 1 | asset is `pdf` |
| `screen` | `{ asset_key, region? }` | asset is a `screen:` member of a design revision |

The stored comment carries `anchor` (JSON) and `target_label` (for example
"S1 Statement · 1a · light", "0:42", "page 3"), which Finish review includes
verbatim in the feedback message so Praxis receives the same addressing the
reviewer saw. Anchor state for media comments is `intact` when the asset's
hash is unchanged in the current revision, `moved` when the same hash exists
under another key, otherwise `orphaned`.

### 3.2 Comment threads

Comments gain `parent_id` (a reply in the same review) and `resolved_at`
(set by the reviewer; purely organisational, carried in the feedback payload
as `resolved: true`). The existing flat comment list remains valid: a comment
without `parent_id` is a root.

### 3.3 Decision selection

`POST /api/documents/:id/decisions` accepts `selection`, a small JSON object
(≤ 2 KB). For a direction-selection design package an `approve` decision
must carry `selection.direction` naming one of the manifest's direction ids,
otherwise `400 selection_required`. The decision row stores `selection`; the
history and the receipt consumer check expose it. Praxis reads the selected
direction from the decision, never from prose.

## 4. Direct editing

`PUT /api/documents/:id/content` with
`{ base_revision_id, content, client_edit_id, summary? }`:

- operator authority (the same check as a decision), same-origin only;
- the document's media type must be editable (§1) and the file must still
  resolve inside a project root;
- the current revision must equal `base_revision_id`, otherwise
  `409 stale_revision` with the current revision (nothing is written);
- content is written atomically (temp file + rename) with the same encoding;
  a design manifest is validated before it is written (`400 invalid_manifest`);
- the new bytes are captured as a new revision whose `source` is `nexus_edit`
  and whose `edited_by` is the operator; an append-only
  `review_document_edits` row links base to result with the summary;
- an identical retry (same `client_edit_id`) answers the recorded result;
- a pending outgoing grant on the document is invalidated as for any binding
  change.

The reviewer's "Edit" produces exactly this. Decisions never carry over: the
new revision needs its own decision, as for any registered revision.

## 5. Readiness and the completion rule

`GET /api/documents/:id/readiness?revision=` answers

```json
{
  "document_id": "…", "revision_id": "…", "content_hash": "…",
  "ready": true,
  "checked_at": "2026-10-16T14:00:00Z",
  "checks": [
    { "asset_key": "screen:S1-light-1a", "role": "screen", "required": true, "ok": true, "status": "servable", "byte_length": 184233, "content_hash": "…", "mime_type": "image/png" },
    { "asset_key": "preview:proto-light", "role": "preview", "required": false, "ok": true, "status": "servable" }
  ],
  "required_total": 11, "required_ok": 11
}
```

A check is `ok` when the asset's bytes are available to the asset route (blob
store or disk) and hash to the revision's recorded hash, and for images when
the bytes decode to a non-empty raster. Statuses: `servable`, `missing`,
`changed`, `undecodable`, `too_large`. Screens and `before` images are
required; previews, tokens and evidence are not. `ready` is true only when
every required check is `ok`.

Completion rule (Praxis): a deliverable of media type `design`, `image`,
`video`, `audio`, `pdf`, `html` or `svg` is announced as delivered only after
its receipt revision reads `ready: true`. A not-ready revision keeps the
handoff `incomplete` with the failing checks in its message, and is retried
like any registration failure. An HTTP 200 on the document route is never
sufficient on its own.

The dashboard viewer performs the second half of the rule: it reports, per
asset, whether the image or video actually loaded in the browser, and shows
"Visuals verified in this browser" or the failing assets in the Evidence
drawer. Praxis's automated browser check (the design pipeline's
`review_direction` and `review_implementation` stages) opens the review route
headless and requires the same per-asset signal before marking the stage
ready for Robert.

## 6. Feedback payload additions

`buildSubmissionPayload` adds `media_type`, per-comment `anchor`,
`target_label`, `parent_id`, `resolved`, and for a design package the
`selected_direction` of the latest approve decision when one exists. The chat
message lists media comments as `- [S1 Statement · 1a · light] at (12%, 40%)
140×60: <body>` and timestamp comments as `- [0:42] <body>`.
