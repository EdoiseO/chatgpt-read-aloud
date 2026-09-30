"""Real local Kokoro RPC regression checks; production voice settings stay untouched."""
import base64
from collections import Counter
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import wave

SOURCE = Path(__file__).resolve().parent
RUNTIME = Path.home() / "Library/Application Support/ChatGPT Read Aloud/kokoro"
PYTHON = RUNTIME / ".venv/bin/python"
PROFILE = "(version 1)(allow default)(deny network*)"


class Worker:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.process = subprocess.Popen(
            ["/usr/bin/sandbox-exec", "-p", PROFILE, str(PYTHON), "-u", str(self.directory / "kokoro_worker.py")],
            cwd=self.directory,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
            env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"},
        )
        self.responses = queue.Queue()
        self.deferred = {}
        self.history = []
        self.last_rpc = 0
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        ready = self.responses.get(timeout=20)
        assert ready == {"event": "ready", "engine": "mlx", "protocolVersion": 2}, ready

    def read(self):
        for line in self.process.stdout:
            try:
                value = json.loads(line)
            except ValueError:
                value = {"invalidJSON": True}
            self.history.append(value)
            self.responses.put(value)

    def raw(self, line):
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()

    def send(self, **payload):
        self.last_rpc += 1
        rpc = self.last_rpc
        self.raw(json.dumps({"rpcId": rpc, **payload}))
        return rpc

    def receive(self, rpc, timeout=60):
        if rpc in self.deferred:
            return self.deferred.pop(rpc)
        deadline = time.monotonic() + timeout
        while True:
            response = self.responses.get(timeout=max(0.01, deadline - time.monotonic()))
            assert "rpcId" in response, response
            if response["rpcId"] == rpc:
                return response
            assert response["rpcId"] not in self.deferred, "Duplicate RPC response"
            self.deferred[response["rpcId"]] = response

    def request(self, **payload):
        return self.receive(self.send(**payload))

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                # This is our test worker only, never a running application worker.
                self.process.kill()
                self.process.wait(timeout=10)
        self.reader.join(timeout=2)
        stderr = self.process.stderr.read()
        assert self.process.returncode == 0, (self.process.returncode, stderr[:200])
        assert not stderr.strip(), "Worker leaked diagnostics to stderr"
        counts = Counter(value.get("rpcId") for value in self.history if "rpcId" in value)
        assert all(count == 1 for count in counts.values()), "Duplicate RPC response"


def prepare_test_root(parent, name, settings=None):
    directory = parent / name
    directory.mkdir(mode=0o700)
    shutil.copyfile(SOURCE / "kokoro_worker.py", directory / "kokoro_worker.py")
    shutil.copyfile(RUNTIME / "engine.json", directory / "engine.json")
    (directory / "models").symlink_to(RUNTIME / "models", target_is_directory=True)
    if settings is not None:
        path = directory / "settings.json"
        path.write_text(settings)
        path.chmod(0o600)
    return directory


def error_code(response, expected):
    assert response.get("error", {}).get("code") == expected, response


def verify_audio(response):
    result = response.get("result", {})
    assert result.get("done") is False and result.get("mimeType") == "audio/wav"
    data = base64.b64decode(result["audioBase64"], validate=True)
    with wave.open(io.BytesIO(data), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 24000)
        frames = wav.getnframes()
        pcm = wav.readframes(frames)
        assert frames > 0 and any(pcm) and frames <= 24000 * 45
    return {"frames": frames, "audioSeconds": frames / 24000, "waveBytes": len(data)}


def main():
    started = time.monotonic()
    settings = RUNTIME / "settings.json"
    settings_before = settings.read_bytes() if settings.exists() else None
    source_worker_bytes = (SOURCE / "kokoro_worker.py").read_bytes()
    # A candidate v2 run must preserve an active v1 helper as well as an
    # already-installed v2 helper. Fresh installations may only contain v2.
    permanent_workers = [RUNTIME / "worker-sentences-v1.py", RUNTIME / "worker-sentences-v2.py"]
    runtime_worker_bytes = {path: path.read_bytes() if path.exists() else None for path in permanent_workers}
    assert any(value is not None for value in runtime_worker_bytes.values()), "No permanent sentence worker is installed"
    checks = []
    audio = []

    denial_program = (
        "import socket,errno; s=socket.socket(); s.settimeout(1); "
        "\ntry: s.connect(('1.1.1.1',443))"
        "\nexcept OSError as e: assert e.errno in (errno.EPERM,errno.EACCES); print(e.errno)"
        "\nelse: raise AssertionError('Network is available')"
    )
    proof = subprocess.run(["/usr/bin/sandbox-exec", "-p", PROFILE, str(PYTHON), "-c", denial_program],
                           text=True, capture_output=True, check=True)
    assert int(proof.stdout.strip()) in (errno.EPERM, errno.EACCES)
    checks.append("OS-level network denial proven; every real worker runs under the same profile")

    with tempfile.TemporaryDirectory(prefix="kokoro-rpc-tests-", dir=SOURCE) as temporary:
        parent = Path(temporary)
        directory = prepare_test_root(parent, "main")
        worker = Worker(directory)
        try:
            worker.raw("{not valid json")
            metadata = worker.request(action="voices")["result"]
            assert len(metadata["voices"]) == 28 and metadata["selectedVoice"] is None
            assert metadata["engine"] == "mlx" and metadata["speed"] == 1
            languages = {voice["id"]: voice["lang"] for voice in metadata["voices"]}
            assert languages["af_heart"] == "en-US" and languages["bm_george"] == "en-GB"
            assert not (directory / "settings.json").exists()
            checks.append("Malformed first JSON survives; 28 English voices and no initial selection")
            error_code(worker.request(action="start", requestId="no-selection", text="A local voice preview."), "VOICE_NOT_SELECTED")
            error_code(worker.request(action="set_voice", voice="af_missing"), "INVALID_VOICE")
            error_code(worker.request(action="start", requestId="empty", text=" ", voice="af_heart"), "INVALID_TEXT")
            assert not (directory / "settings.json").exists()
            checks.append("No forced voice; invalid voice and empty text leave settings absent")

            for voice, locale in [("af_heart", "American"), ("bm_george", "British")]:
                request = f"preview-{voice}"
                response = worker.request(action="start", requestId=request, voice=voice,
                                          text=f"This is a {locale} voice preview.")
                audio.append({"case": request, **verify_audio(response)})
                assert worker.request(action="next", requestId=request)["result"] == {"done": True}
                assert not (directory / "settings.json").exists()
            checks.append("Real US/UK explicit previews produce valid audio without saving a choice")

            assert worker.request(action="set_voice", voice="af_bella")["result"] == {"selectedVoice": "af_bella"}
            selected_file = directory / "settings.json"
            assert json.loads(selected_file.read_text())["selectedVoice"] == "af_bella"
            assert selected_file.stat().st_mode & 0o777 == 0o600
            assert worker.request(action="voices")["result"]["selectedVoice"] == "af_bella"
            checks.append("Voice choice saved atomically with private settings permissions")

            long_text = "The local speech worker reads only the current response and stops when another response starts. " * 15
            pending = worker.send(action="start", requestId="cancel-a", text=long_text)
            time.sleep(0.15)
            canceled = worker.send(action="cancel", requestId="cancel-a")
            assert worker.receive(canceled, timeout=2)["result"] == {"done": True}
            error_code(worker.receive(pending), "CANCELED")
            error_code(worker.request(action="next", requestId="cancel-a"), "CANCELED")
            checks.append("Cancel acknowledges while inference is active and suppresses stale audio")

            stale = worker.send(action="start", requestId="switch-a", text=long_text, voice="af_heart")
            time.sleep(0.15)
            replacement = worker.send(action="start", requestId="switch-b", text="The new British response is active.", voice="bm_george")
            error_code(worker.receive(stale), "CANCELED")
            audio.append({"case": "switch-b", **verify_audio(worker.receive(replacement))})
            error_code(worker.request(action="next", requestId="switch-a"), "CANCELED")
            assert worker.request(action="next", requestId="switch-b")["result"] == {"done": True}
            assert worker.request(action="voices")["result"]["selectedVoice"] == "af_bella"
            checks.append("A→B switch rejects A's stale result; preview does not overwrite saved choice")

            queued_start = worker.send(action="start", requestId="queue-a", text=long_text, voice="af_heart")
            time.sleep(0.15)
            queued_next = worker.send(action="next", requestId="queue-a")
            queued_last = worker.send(action="next", requestId="queue-a")
            latest = worker.send(action="start", requestId="queue-b", text="Only the newest response is spoken.", voice="af_bella")
            for rpc in [queued_start, queued_next]:
                error_code(worker.receive(rpc), "CANCELED")
            assert worker.receive(queued_last).get("error", {}).get("code") in {"CANCELED", "BUSY"}
            audio.append({"case": "queue-b", **verify_audio(worker.receive(latest))})
            assert worker.request(action="next", requestId="queue-b")["result"] == {"done": True}
            checks.append("Superseded queued batches are rejected; only newest context returns audio")

            before_invalid = worker.last_rpc
            worker.raw("[")
            assert worker.request(action="voices")["result"]["selectedVoice"] == "af_bella"
            assert worker.last_rpc == before_invalid + 1
            checks.append("Malformed later JSON neither crashes nor reuses a prior RPC ID")
        finally:
            worker.close()

        reopened = Worker(directory)
        try:
            assert reopened.request(action="voices")["result"]["selectedVoice"] == "af_bella"
            response = reopened.request(action="start", requestId="saved-default", text="The saved voice is used after reopening.")
            audio.append({"case": "saved-default", **verify_audio(response)})
            assert reopened.request(action="next", requestId="saved-default")["result"] == {"done": True}
            checks.append("Saved selection survives fresh worker startup and drives default speech")
        finally:
            reopened.close()

        for index, malformed in enumerate(["null", "[]", "{broken", '{"selectedVoice":"af_missing"}']):
            other = prepare_test_root(parent, f"invalid-settings-{index}", settings=malformed)
            isolated = Worker(other)
            try:
                assert isolated.request(action="voices")["result"]["selectedVoice"] is None
            finally:
                isolated.close()
        checks.append("Null/list/malformed/unknown saved settings safely produce no selection")

        sentence_directory = prepare_test_root(parent, "sentences", settings='{"version":1,"selectedVoice":"af_aoede"}')
        sentences = Worker(sentence_directory)
        try:
            assert sentences.request(action="voices")["result"]["selectedVoice"] == "af_aoede"
            first, second = "The first selected sentence.", "The second 😀 selected sentence."
            text = first + " " + second
            units = lambda value: len(value.encode("utf-16-le")) // 2
            ranges = [{"start": 0, "end": units(first)}, {"start": units(first) + 1, "end": units(text)}]
            error_code(sentences.request(action="start", requestId="bad-ranges", text=text,
                                          sentenceRanges=[{"start": 0, "end": units(first)}]), "INVALID_SENTENCE_RANGES")
            payload = {"action": "start", "requestId": "two-selected", "text": text, "sentenceRanges": ranges}
            assert "voice" not in payload
            first_started = time.monotonic()
            first_response = sentences.request(**payload)
            first_seconds = time.monotonic() - first_started
            first_audio = verify_audio(first_response)
            assert (first_response["result"]["sentenceStart"], first_response["result"]["sentenceEnd"]) == (0, units(first))
            next_started = time.monotonic()
            second_response = sentences.request(action="next", requestId="two-selected")
            second_seconds = time.monotonic() - next_started
            second_audio = verify_audio(second_response)
            assert (second_response["result"]["sentenceStart"], second_response["result"]["sentenceEnd"]) == (units(first) + 1, units(text))
            assert sentences.request(action="next", requestId="two-selected")["result"] == {"done": True}
            audio.extend([{"case": "aoede-first-selected-sentence", "generationSeconds": first_seconds, **first_audio},
                          {"case": "aoede-second-selected-sentence", "generationSeconds": second_seconds, **second_audio}])
            checks.append("Real Aoede default renders two individual selected sentences with exact UTF-16 emoji offsets")

            for pieces in [["}", "After."], ["Before.", "}", "After."], ["Before.", "---"],
                           ["}", "---", "After."], ["}", "---"]]:
                text = "\n".join(pieces)
                ranges, offset = [], 0
                for piece in pieces:
                    ranges.append({"start": offset, "end": offset + units(piece)})
                    offset += units(piece) + 1
                result = sentences.request(action="start", requestId="silent-ranges", text=text, sentenceRanges=ranges)
                for index, piece in enumerate(pieces):
                    value = result["result"]
                    assert (value["sentenceStart"], value["sentenceEnd"]) == (ranges[index]["start"], ranges[index]["end"])
                    if piece in {"}", "---"}:
                        assert value == {"done": False, "skipped": True,
                                         "sentenceStart": ranges[index]["start"], "sentenceEnd": ranges[index]["end"]}
                    else:
                        audio.append({"case": f"aoede-silent-range-{index}-of-{len(pieces)}", **verify_audio(result)})
                    result = sentences.request(action="next", requestId="silent-ranges")
                assert result["result"] == {"done": True}
            checks.append("Protocol 2 acknowledges silent symbol ranges at the start, middle, end, consecutively and alone; following Aoede prose renders normally")

            long_sentence = "The selected words stay in order while a long sentence is split into shorter audio pieces " * 5 + "."
            long_range = {"start": 0, "end": units(long_sentence)}
            result = sentences.request(action="start", requestId="long-sentence", text=long_sentence,
                                       sentenceRanges=[long_range])
            part_count = 0
            while not result["result"].get("done"):
                assert (result["result"]["sentenceStart"], result["result"]["sentenceEnd"]) == (long_range["start"], long_range["end"])
                audio.append({"case": f"aoede-long-sentence-part-{part_count}", **verify_audio(result)})
                part_count += 1
                assert part_count <= 10
                result = sentences.request(action="next", requestId="long-sentence")
            assert part_count > 1
            checks.append("Real long sentence uses multiple bounded audio parts carrying the same sentence range")
        finally:
            sentences.close()

    settings_after = settings.read_bytes() if settings.exists() else None
    assert settings_after == settings_before, "Production voice settings changed during tests"
    checks.append("Production selection preserved; isolated initial selection stays unset")
    for path, before in runtime_worker_bytes.items():
        assert (path.read_bytes() if path.exists() else None) == before, "Permanent runtime worker was changed during candidate tests"
    assert (SOURCE / "kokoro_worker.py").read_bytes() == source_worker_bytes
    # A private parent protects the virtual environment; pip package modes need
    # not be rewritten. Check the files holding model and runtime state directly.
    critical = [*[path for path in permanent_workers if path.exists()], RUNTIME / "engine.json", *[p for p in (RUNTIME / "models").rglob("*") if p.is_file()]]
    critical += [p for p in (settings, RUNTIME / "installation.json") if p.exists()]
    private = [p for p in critical if p.is_symlink() or p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077]
    assert not private and RUNTIME.stat().st_mode & 0o077 == 0
    checks.append("Candidate source tested in isolation; permanent worker unchanged and runtime remains private")

    report = {"passed": True, "checks": checks, "audio": audio, "durationSeconds": time.monotonic() - started,
              "runtime": str(RUNTIME), "engine": "mlx", "dtype": "float32", "initialSelectedVoice": None,
              "settingsPreserved": settings_before == settings_after,
              "workerSha256": hashlib.sha256(source_worker_bytes).hexdigest(),
              "permanentWorkerUnchanged": True}
    path = SOURCE / "test-kokoro-worker-results.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": True, "checks": len(checks), "audioCases": len(audio),
                      "durationSeconds": report["durationSeconds"], "report": str(path)}, indent=2))


if __name__ == "__main__":
    main()
