# Gander + CrisperWhisper + Ornith (Phase 1)

This directory contains an isolated experiment for adding Gander as Clipit's realtime perception layer without changing the current production video Q&A path.

Target stack:

- Gander: continuous audiovisual perception and interaction.
- CrisperWhisper: external ASR candidate using Gander's existing HTTP ASR contract.
- Ornith: delegated reasoning Brain through Gander's WorkerProvider contract.
- Clipit persistent video memory: intentionally not connected in Phase 1.

## Guardrails

This experiment must not alter the current notes-first / footage-fallback production search path.

CrisperWhisper is a candidate, not an assumed winner. We need to measure realtime latency, interruption handling, timing accuracy, GPU use, and cost before choosing it over Faster-Whisper.

The CrisperWhisper repository code is MIT-licensed, but its standard model weights require a commercial license for commercial use. Do not deploy those weights commercially until licensing is resolved.

Ornith is not treated as a drop-in Codex replacement. Gander expects a WorkerProvider lifecycle, so the adapter in this directory implements that contract explicitly and declares only the capabilities it actually supports.

## Phase 1 success criteria

1. Live camera and microphone can reach Gander.
2. CrisperWhisper can satisfy Gander's external `/health` and `/transcribe` ASR contract.
3. Audio timestamps remain aligned to Gander's source timeline.
4. Gander can delegate a reasoning task to Ornith.
5. Ornith returns a result to the correct Gander task.
6. Gander can keep perceiving while the delegated task is running.
7. Every unsupported provider capability is reported honestly rather than emulated incorrectly.

## Modal

Do not deploy this experiment to Modal until the local contracts are working. The first Modal build should be used to measure the actual GPU footprint and latency of Gander Thinker/Talker, CrisperWhisper, and Ornith rather than assuming the upstream reference topology is the final architecture.
