# Later experiments

## BES reasoning layer

BES (Embodied-Minds-Lab/BES) is intentionally excluded from Phase 1.

Evaluate it only after the Gander, CrisperWhisper, and Ornith baseline works and Ornith can access persistent Clipit video memory/tools.

Compare plain Ornith against Ornith plus BES on the same fixed evaluation set. Measure answer quality, evidence grounding, tool planning quality, latency, and compute cost. Prefer invoking BES only for difficult tasks if it proves useful.

## Alternate speech renderer

Phase 1 uses Gander's native detached Talker and speech decoder. Only evaluate an external streaming TTS/voice model if the native Talker is the measured weak link in voice quality, first-audio latency, interruption recovery, expressiveness, or GPU cost.
