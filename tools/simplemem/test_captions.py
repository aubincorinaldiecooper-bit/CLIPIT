"""Run with: python3 -m unittest tools.simplemem.test_captions  (from the repo root)."""
from __future__ import annotations

import logging
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from captions import UNCAPTIONED, CaptionWriter  # noqa: E402


class FakeImage:
    def save(self, buffer, format="JPEG"):
        buffer.write(b"\xff\xd8fake-jpeg")


class FakeClient:
    """Replies in order; each entry is a content value or an exception."""

    def __init__(self, replies):
        self._replies = list(replies)
        self.calls = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        reply = self._replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        content, finish = reply
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason=finish)])


def writer(replies):
    client = FakeClient(replies)
    log = logging.getLogger("test-captions")
    log.addHandler(logging.NullHandler())
    return client, CaptionWriter(lambda: client, "caption-model", log=log)


class CaptionWriterTests(unittest.TestCase):
    def test_a_caption_that_arrives_is_returned_and_counted(self):
        client, w = writer([("  A dog jumps over a fence.  ", "stop")])
        self.assertEqual(w.caption(FakeImage()), "A dog jumps over a fence.")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0]["max_tokens"], 150)
        self.assertEqual(w.stats.as_dict(), {"attempted": 1, "captioned": 1, "retried": 0, "failed": 0, "lastError": None})

    def test_a_none_reply_is_asked_again_with_more_room(self):
        client, w = writer([(None, "length"), ("A man holds a red sign.", "stop")])
        self.assertEqual(w.caption(FakeImage()), "A man holds a red sign.")
        self.assertEqual([c["max_tokens"] for c in client.calls], [150, 600])
        self.assertEqual(w.stats.retried, 1)
        self.assertEqual(w.stats.captioned, 1)
        self.assertEqual(w.stats.failed, 0)

    def test_a_frame_that_never_gets_a_caption_is_counted_not_disguised(self):
        client, w = writer([(None, "length"), ("", "length")])
        self.assertEqual(w.caption(FakeImage()), UNCAPTIONED)
        self.assertNotIn("Image captured", UNCAPTIONED)
        self.assertEqual(w.stats.failed, 1)
        self.assertEqual(w.stats.captioned, 0)
        self.assertIn("finish_reason=length", w.stats.lastError)
        self.assertIn("max_tokens=600", w.stats.lastError)

    def test_a_gateway_error_is_a_counted_failure_with_its_reason(self):
        client, w = writer([RuntimeError("502 Bad Gateway"), RuntimeError("502 Bad Gateway")])
        self.assertEqual(w.caption(FakeImage()), UNCAPTIONED)
        self.assertEqual(w.stats.failed, 1)
        self.assertEqual(w.stats.lastError, "RuntimeError: 502 Bad Gateway")

    def test_list_shaped_content_is_read_too(self):
        client, w = writer([([{"type": "text", "text": "Two people"}, {"type": "text", "text": "shake hands."}], "stop")])
        self.assertEqual(w.caption(FakeImage()), "Two people shake hands.")

    def test_counts_accumulate_across_frames(self):
        client, w = writer([("one", "stop"), (None, "length"), (None, "length"), ("three", "stop")])
        for _ in range(3):
            w.caption(FakeImage())
        self.assertEqual(w.stats.as_dict(), {"attempted": 3, "captioned": 2, "retried": 1, "failed": 1,
                                             "lastError": "empty caption (finish_reason=length, max_tokens=600)"})


if __name__ == "__main__":
    unittest.main()
