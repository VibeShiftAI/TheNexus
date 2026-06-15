# YouTube Knowledge Intake Design

## Goal

Make the Knowledge Ingestion page accept human-friendly YouTube channel inputs, immediately ingest the five most recent channel videos after a channel is added, and support ingesting one YouTube video without adding a persistent source.

## Architecture

The Nexus dashboard remains the UI and proxy layer. Praxis owns the ingestion control API, YouTube identifier resolution, transcript discovery, and queueing of normal Cortex ingestion jobs.

Channel sources continue to be stored as canonical YouTube channel IDs because YouTube RSS requires that form. The source registry resolves IDs from channel URLs, `@handle` URLs, bare handles, and existing `UC...` IDs before persisting the source.

Adding a YouTube source triggers a one-source knowledge intake sweep with a cap of five items. The source is still saved for future scheduled sweeps.

A new single-video ingestion endpoint resolves a YouTube video ID or URL, fetches its transcript, creates one standard discovered item, and queues the same `ingest_item` plus finalizer flow used by nightly intake.

## UI

The Content Sources form should make the YouTube input placeholder explicit: channel URL, handle, or channel ID. A separate single-video panel should accept a video URL or ID and show the queued run result.

## Error Handling

If channel resolution fails, Praxis should return a clear verification error rather than storing an unusable source. If a single video has no transcript, the API should return a 400-level response explaining that there is no ingestable transcript.

## Testing

Praxis tests cover:

- YouTube channel cap increases from three to five.
- Adding a YouTube channel can trigger a one-source five-video intake.
- Single-video ingestion resolves a video URL and enqueues one item.

The Nexus proxy/client additions are small and should be validated by TypeScript/build checks where available.
