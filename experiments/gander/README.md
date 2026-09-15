# Gander + Ornith runtime

This directory contains the current Clipit experiment for using Gander as the realtime audiovisual perception layer with Ornith as the delegated Brain.

Current validated shape:

- Gander Thinker: realtime vision + raw audio perception
- Ornith: longer-horizon reasoning through Gander's WorkerProvider contract
- ASR: disabled for now
- Talker/TTS: disabled for now
- client video: enabled
- provider warmup: implemented and validated

The current goal is to prove a stable Gander + Ornith runtime before wiring it into the Clipit web-video search backend.

## Provider contract

The Ornith adapter is intentionally conservative:

- stateless
- bounded pushed context
- no steering
- no side queries
- no interactions
- no worker tools
- up to four parallel projects declared for the eventual four-scout search architecture

The provider exposes `warmup()` because Gander calls that hook before announcing a realtime session ready.

## Current runtime behavior

Gander owns live audiovisual perception and timing. Ornith receives the delegated task plus bounded context selected by Gander and returns the longer-horizon result.

The current runtime does not depend on CrisperWhisper or Talker. Those can be evaluated later without blocking the web-search integration.

## Next step

Integrate the validated Gander + Ornith runtime into the Clipit backend path:

query -> discovery -> managed browser playback -> Gander observation -> Ornith reasoning when needed -> timestamped result -> existing Clipit frontend
