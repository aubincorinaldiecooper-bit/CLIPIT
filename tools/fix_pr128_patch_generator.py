from pathlib import Path

path = Path(__file__).with_name("apply_pr128_fencing_fix.py")
text = path.read_text()
old = '''    # One uncertain-match write lives inside searchSingleChunk.
    marker = "    await recordUncertainMatches(\\n      input.clipRequestId,"
    if marker in text and "input.deckAttemptId," not in text[text.index(marker): text.index(marker) + 1200]:
        start = text.index(marker)
        close = text.index("    );", start)
        text = text[:close] + "      input.deckAttemptId,\\n" + text[close:]
'''
new = '''    # One uncertain-match write lives inside searchSingleChunk. Add the fence
    # to the OUTER repository call, not to mapLocalRangeToGlobal inside the flatMap.
    text = replace_all_required(
        text,
        "      }),\\n    );\\n\\n    input.log.warn('discarded low-confidence matches'",
        "      }),\\n      input.deckAttemptId,\\n    );\\n\\n    input.log.warn('discarded low-confidence matches'",
    )
'''
if old not in text:
    raise SystemExit("uncertain-match generator block not found")
path.write_text(text.replace(old, new, 1))
