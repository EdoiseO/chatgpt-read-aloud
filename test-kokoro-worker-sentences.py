"""UTF-16 coverage and deterministic cancellation tests without model inference."""
import base64
import importlib.util
from pathlib import Path
import queue
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sentence_worker_under_test", ROOT / "kokoro_worker.py")
worker = importlib.util.module_from_spec(spec)
stdout = sys.stdout
try:
    spec.loader.exec_module(worker)
finally:
    suppressed = sys.stdout
    sys.stdout = stdout
    if suppressed is not stdout:
        suppressed.close()


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def two_ranges(first, second):
    return [{"start": 0, "end": utf16_length(first)},
            {"start": utf16_length(first) + 1, "end": utf16_length(first + " " + second)}]


class FakeEngine:
    voices = ["af_aoede", "bm_george"]

    def __init__(self, block_prepare=False, block_render=False):
        self.prepared = []
        self.rendered = []
        self.prepare_entered = threading.Event()
        self.render_entered = threading.Event()
        self.release = threading.Event()
        self.block_prepare = block_prepare
        self.block_render = block_render

    def prepare(self, text, voice):
        self.prepared.append((text, voice))
        self.prepare_entered.set()
        if self.block_prepare and len(self.prepared) == 1:
            assert self.release.wait(5)
        return iter(worker.phoneme_chunks(text))

    def render(self, phonemes, voice):
        self.rendered.append((phonemes, voice))
        self.render_entered.set()
        if self.block_render and len(self.rendered) == 1:
            assert self.release.wait(5)
        return {"done": False, "mimeType": "audio/wav", "audioBase64": base64.b64encode(b"fixture").decode()}


class Fixture:
    def __init__(self, test, engine):
        self.temporary = tempfile.TemporaryDirectory(prefix="sentence-worker-unit-")
        self.messages = queue.Queue()
        self.deferred = {}
        self.rpc_id = 0
        self.engine = engine
        self.service = worker.Service(engine, Path(self.temporary.name), emit=self.messages.put)
        test.addCleanup(self.close)

    def close(self):
        self.engine.release.set()
        self.service.close()
        self.service.thread.join(timeout=2)
        assert not self.service.thread.is_alive()
        self.temporary.cleanup()

    def send(self, **payload):
        self.rpc_id += 1
        self.service.handle({"rpcId": self.rpc_id, **payload})
        return self.rpc_id

    def receive(self, rpc_id):
        if rpc_id in self.deferred:
            return self.deferred.pop(rpc_id)
        deadline = time.monotonic() + 5
        while True:
            message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            if message["rpcId"] == rpc_id:
                return message
            self.deferred[message["rpcId"]] = message

    def request(self, **payload):
        return self.receive(self.send(**payload))


class SentenceWorkerTests(unittest.TestCase):
    def test_utf16_astral_offsets_and_whitespace_gaps_convert_exactly(self):
        text = " First 😀. \nSecond!\ufeff"
        ranges = [{"start": 1, "end": 10}, {"start": 12, "end": 19}]
        self.assertEqual(worker.validate_sentence_ranges(text, ranges), [(1, 10, 1, 9), (12, 19, 11, 18)])
        self.assertEqual(worker.validate_sentence_ranges("\ufeffA.\u2028B. ", [{"start": 1, "end": 3}, {"start": 4, "end": 6}]),
                         [(1, 3, 1, 3), (4, 6, 4, 6)])
        with self.assertRaises(ValueError):
            worker.validate_sentence_ranges("A.\u0085B.", [{"start": 0, "end": 2}, {"start": 3, "end": 5}])

    def test_malformed_ranges_and_dropped_text_are_rejected(self):
        text = "First 😀. Second."
        invalid = [None, [], {}, [None], [[0, 17]], [{"start": True, "end": 17}],
                   [{"start": 0.5, "end": 17}], [{"start": -1, "end": 17}], [{"start": 0, "end": 18}],
                   [{"start": 0, "end": 0}], [{"start": 1, "end": 17}],
                   [{"start": 0, "end": 7}, {"start": 7, "end": 17}],
                   [{"start": 0, "end": 9}, {"start": 8, "end": 17}],
                   [{"start": 10, "end": 17}, {"start": 0, "end": 9}],
                   [{"start": 0, "end": 9}, {"start": 11, "end": 17}], [{"start": 0, "end": 9}],
                   [{"start": 0, "end": 17}] * 4097]
        for ranges in invalid:
            with self.subTest(ranges=str(ranges)[:100]), self.assertRaises(ValueError):
                worker.validate_sentence_ranges(text, ranges)
        with self.assertRaises(ValueError):
            worker.validate_sentence_ranges("A  B.", [{"start": 0, "end": 1}, {"start": 1, "end": 3}, {"start": 3, "end": 5}])
        for broken in ["\ud800x", "x\udc00"]:
            with self.assertRaises(ValueError):
                worker.validate_sentence_ranges(broken, [{"start": 0, "end": len(broken)}])

    def test_range_count_and_utf16_text_length_are_bounded(self):
        ranges = [{"start": index * 2, "end": index * 2 + 2} for index in range(4096)]
        self.assertEqual(len(worker.validate_sentence_ranges("x." * 4096, ranges)), 4096)
        with self.assertRaises(ValueError):
            worker.validate_sentence_ranges("😀" * 100001, [{"start": 0, "end": 200002}])

    def test_only_selected_sentences_are_prepared_lazily_with_exact_offsets(self):
        engine = FakeEngine()
        fixture = Fixture(self, engine)
        first, second = "Chosen 😀 sentence.", "Another chosen sentence."
        text = first + " " + second
        ranges = two_ranges(first, second)
        result = fixture.request(action="start", requestId="selected", text=text, voice="af_aoede",
                                 sentenceRanges=ranges, responseTextOutsideSelection="Never speak this outside selection.")["result"]
        self.assertEqual((result["sentenceStart"], result["sentenceEnd"]), (ranges[0]["start"], ranges[0]["end"]))
        self.assertEqual(engine.prepared, [(first, "af_aoede")])
        result = fixture.request(action="next", requestId="selected")["result"]
        self.assertEqual((result["sentenceStart"], result["sentenceEnd"]), (ranges[1]["start"], ranges[1]["end"]))
        self.assertEqual(engine.prepared, [(first, "af_aoede"), (second, "af_aoede")])
        self.assertEqual(fixture.request(action="next", requestId="selected")["result"], {"done": True})
        self.assertEqual("".join(part for part, _ in engine.rendered).replace(" ", ""), text.replace(" ", ""))

    def test_long_sentence_parts_share_the_range_and_preserve_every_nonspace_character(self):
        engine = FakeEngine()
        fixture = Fixture(self, engine)
        first, second = "word " * 150 + ".", "The next sentence."
        text = first + " " + second
        ranges = two_ranges(first, second)
        result = fixture.request(action="start", requestId="long", text=text, voice="af_aoede", sentenceRanges=ranges)["result"]
        part_count = 0
        while not result.get("done") and result["sentenceStart"] == 0:
            self.assertEqual(result["sentenceEnd"], ranges[0]["end"])
            self.assertEqual(engine.prepared, [(first, "af_aoede")])
            self.assertLessEqual(len(engine.rendered[-1][0]), 180 if part_count == 0 else 350)
            part_count += 1
            result = fixture.request(action="next", requestId="long")["result"]
        self.assertGreater(part_count, 1)
        self.assertEqual((result["sentenceStart"], result["sentenceEnd"]), (ranges[1]["start"], ranges[1]["end"]))
        self.assertEqual(engine.prepared[-1], (second, "af_aoede"))
        self.assertEqual(fixture.request(action="next", requestId="long")["result"], {"done": True})
        self.assertEqual("".join(part for part, _ in engine.rendered).replace(" ", ""), text.replace(" ", ""))

    def test_cancel_during_prepare_never_tokenizes_future_sentences_or_returns_audio(self):
        engine = FakeEngine(block_prepare=True)
        fixture = Fixture(self, engine)
        first, second = "Old first.", "Old second."
        rpc = fixture.send(action="start", requestId="cancel", text=first + " " + second, voice="af_aoede",
                           sentenceRanges=two_ranges(first, second))
        self.assertTrue(engine.prepare_entered.wait(2))
        self.assertEqual(fixture.request(action="cancel", requestId="cancel")["result"], {"done": True})
        engine.release.set()
        self.assertEqual(fixture.receive(rpc)["error"]["code"], "CANCELED")
        self.assertEqual(engine.prepared, [(first, "af_aoede")])
        self.assertEqual(engine.rendered, [])

    def test_switch_during_render_discards_stale_sentence_and_never_prepares_old_tail(self):
        engine = FakeEngine(block_render=True)
        fixture = Fixture(self, engine)
        first, second = "Old first.", "Old second."
        old = fixture.send(action="start", requestId="old", text=first + " " + second, voice="af_aoede",
                           sentenceRanges=two_ranges(first, second))
        self.assertTrue(engine.render_entered.wait(2))
        new_text = "New 😀."
        new = fixture.send(action="start", requestId="new", text=new_text, voice="bm_george",
                           sentenceRanges=[{"start": 0, "end": utf16_length(new_text)}])
        engine.release.set()
        self.assertEqual(fixture.receive(old)["error"]["code"], "CANCELED")
        result = fixture.receive(new)["result"]
        self.assertEqual((result["sentenceStart"], result["sentenceEnd"]), (0, utf16_length(new_text)))
        self.assertEqual(engine.prepared, [(first, "af_aoede"), (new_text, "bm_george")])

    def test_legacy_no_ranges_keeps_whole_text_chunks_without_tags(self):
        engine = FakeEngine()
        fixture = Fixture(self, engine)
        text = "One sentence. Another sentence."
        result = fixture.request(action="start", requestId="legacy", text=text, voice="af_aoede")["result"]
        self.assertNotIn("sentenceStart", result)
        self.assertNotIn("sentenceEnd", result)
        self.assertEqual(engine.prepared, [(text, "af_aoede")])
        self.assertEqual(fixture.request(action="next", requestId="legacy")["result"], {"done": True})

    def test_invalid_ranges_do_not_interrupt_current_valid_request(self):
        engine = FakeEngine(block_render=True)
        fixture = Fixture(self, engine)
        old = fixture.send(action="start", requestId="valid", text="Keep reading.", voice="af_aoede")
        self.assertTrue(engine.render_entered.wait(2))
        invalid = fixture.request(action="start", requestId="invalid", text="No omissions.", voice="af_aoede",
                                  sentenceRanges=[{"start": 1, "end": 13}])
        self.assertEqual(invalid["error"]["code"], "INVALID_SENTENCE_RANGES")
        engine.release.set()
        self.assertFalse(fixture.receive(old)["result"]["done"])

    def test_ranges_on_nonstart_actions_are_rejected_without_saving_settings(self):
        fixture = Fixture(self, FakeEngine())
        result = fixture.request(action="set_voice", voice="af_aoede", sentenceRanges=[{"start": 0, "end": 1}])
        self.assertEqual(result["error"]["code"], "INVALID_SENTENCE_RANGES")
        self.assertFalse((Path(fixture.temporary.name) / "settings.json").exists())


if __name__ == "__main__":
    unittest.main()
