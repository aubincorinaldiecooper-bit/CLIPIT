from pathlib import Path

path = Path('test/evidenceContract.test.ts')
text = path.read_text()
old = "expect(recordRetrievalOutcome).toHaveBeenCalledWith('request-1', expect.objectContaining({ primary: 'videochat3', system: 'videochat3' }));"
new = "expect(recordRetrievalOutcome).toHaveBeenCalledWith('request-1', expect.objectContaining({ primary: 'videochat3', system: 'videochat3' }), 'attempt-1');"
if old not in text:
    if new in text:
        raise SystemExit(0)
    raise SystemExit('expected recordRetrievalOutcome assertion not found')
path.write_text(text.replace(old, new, 1))
