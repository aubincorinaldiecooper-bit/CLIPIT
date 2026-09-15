# Gander upstream provenance

CLIPIT vendors the runtime required to run and test Gander so the production build no longer depends on another repository.

- Upstream project: `Omni-Interaction-Gander/Omni-Interaction-Agent`
- Clipit fork used for this import: `aubincorinaldiecooper-bit/Omni-Interaction-Agent`
- Imported fork commit: `e5f3f755c39dcda30ab0638ce332d3b2dca6526e`
- Import scope: `gander_runtime/`, `minicpm_ft/mcpmft/`, their tests/package metadata, and Apache-2.0 license.
- Deliberately excluded: docs, report/images, training/examples, caches/bytecode.

## Syncing upstream later

Compare a future upstream/fork revision against the imported commit above, review runtime changes, then intentionally port the relevant changes into `gander/`. Do not make production builds clone the external repository.

Clipit's Ornith provider is maintained directly under `gander/gander_runtime/gander_runtime/providers/ornith.py` and is registered alongside the upstream Codex provider.
