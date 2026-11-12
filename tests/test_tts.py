"""Озвучка Fish Speech на сервере: настройки, голоса, кеш, прокси, пак. Fish подменён заглушкой (httpx.MockTransport)."""
import base64
import io
import json
import logging
import math
import os
import stat
import struct
import wave
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from server import db as store
from server import tts
from server.main import make_app

PHRASE = "Запись началась. Вперёд."


def make_wav(sec: float = 5.0, rate: int = 16000, channels: int = 1) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(sec * rate)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i / 20))) * channels for i in range(n)))
    return buf.getvalue()


def mp_unpack(b: bytes, i: int = 0):
    """Минимальный разбор msgpack для проверки того, что ушло в Fish."""
    t = b[i]
    if t < 0x80:
        return t, i + 1
    if 0x80 <= t <= 0x8F:
        out, i = {}, i + 1
        for _ in range(t & 15):
            k, i = mp_unpack(b, i)
            v, i = mp_unpack(b, i)
            out[k] = v
        return out, i
    if 0x90 <= t <= 0x9F:
        out, i = [], i + 1
        for _ in range(t & 15):
            v, i = mp_unpack(b, i)
            out.append(v)
        return out, i
    if 0xA0 <= t <= 0xBF:
        n = t & 31
        return b[i + 1:i + 1 + n].decode(), i + 1 + n
    if t == 0xC0:
        return None, i + 1
    if t == 0xC2:
        return False, i + 1
    if t == 0xC3:
        return True, i + 1
    if t == 0xC4:
        n = b[i + 1]
        return b[i + 2:i + 2 + n], i + 2 + n
    if t == 0xC5:
        n = struct.unpack(">H", b[i + 1:i + 3])[0]
        return b[i + 3:i + 3 + n], i + 3 + n
    if t == 0xC6:
        n = struct.unpack(">I", b[i + 1:i + 5])[0]
        return b[i + 5:i + 5 + n], i + 5 + n
    if t == 0xCB:
        return struct.unpack(">d", b[i + 1:i + 9])[0], i + 9
    if t == 0xD3:
        return struct.unpack(">q", b[i + 1:i + 9])[0], i + 9
    if t == 0xD9:
        n = b[i + 1]
        return b[i + 2:i + 2 + n].decode(), i + 2 + n
    if t == 0xDA:
        n = struct.unpack(">H", b[i + 1:i + 3])[0]
        return b[i + 3:i + 3 + n].decode(), i + 3 + n
    if t >= 0xE0:
        return t - 256, i + 1
    raise ValueError(hex(t))


class Fish:
    def __init__(self):
        self.calls: list[dict] = []
        self.health_calls = 0
        self.mode = "ok"  # ok | down | http500 | garbage | denied
        self.wav = make_wav(0.6)

    def handler(self, req: httpx.Request) -> httpx.Response:
        if self.mode == "down":
            raise httpx.ConnectError("refused", request=req)
        if req.url.path == "/v1/health":
            self.health_calls += 1
            return httpx.Response(401 if self.mode == "denied" else 200, json={"status": "ok"})
        assert req.url.path == "/v1/tts"
        body, _ = mp_unpack(req.content)
        self.calls.append({"body": body, "headers": dict(req.headers), "url": str(req.url)})
        if self.mode == "denied":
            return httpx.Response(401)
        if self.mode == "http500":
            return httpx.Response(500, text="boom")
        if self.mode == "garbage":
            return httpx.Response(200, content=b"<html>not audio</html>")
        return httpx.Response(200, content=self.wav, headers={"content-type": "audio/wav"})


@pytest.fixture()
def env(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("FISH_SPEECH_URL", raising=False)
    monkeypatch.delenv("FISH_SPEECH_API_KEY", raising=False)
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    code = store.create_pair_code(app.state.conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    fish = Fish()
    app.state.tts.client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(fish.handler))
    return app, client, h, fish, tmp_path


def add_voice(client, h, wav: bytes | None = None, **over):
    body = {"name": "Мой голос", "transcript": "Это образец моего голоса.", "consent": True,
            "audio": base64.b64encode(wav or make_wav(5)).decode(), **over}
    return client.post("/api/tts/voices", json=body, headers=h)


# ---------- msgpack ----------

def test_msgpack_roundtrip_covers_types_fish_needs():
    obj = {"text": "Привет", "n": 200, "neg": -3, "big": 70000, "f": 0.7, "ok": True, "no": False, "none": None,
           "refs": [{"audio": b"\x00\x01" * 200, "text": "т"}], "long": "я" * 300, "bin": b"x" * 70000}
    out, end = mp_unpack(tts.mp_pack(obj))
    assert out == obj and end == len(tts.mp_pack(obj))


# ---------- настройки ----------

def test_requires_auth(env):
    _, client, _, _, _ = env
    for path in ("/api/tts/config", "/api/tts/status", "/api/tts/voices", "/api/tts/audio/" + "a" * 64):
        assert client.get(path).status_code == 401
    assert client.post("/api/tts/synthesize", json={"voiceId": "v" + "0" * 16, "text": "а"}).status_code == 401


def test_config_defaults_and_secret_never_returned(env):
    _, client, h, _, _ = env
    v = client.get("/api/tts/config", headers=h).json()
    assert v["url"] == "http://127.0.0.1:8080" and v["hasKey"] is False and v["format"] == "mp3"
    r = client.put("/api/tts/config", json={"apiKey": "sk-secret-1234567890", "params": {"temperature": 0.5}}, headers=h)
    assert r.status_code == 200
    v = r.json()
    assert v["hasKey"] and v["keyHint"] == "••••7890" and v["params"]["temperature"] == 0.5 and v["params"]["topP"] == 0.7
    assert "sk-secret" not in json.dumps(client.get("/api/tts/config", headers=h).json())
    assert "sk-secret" not in json.dumps(client.get("/api/tts/status", headers=h).json())


def test_config_rejects_public_urls_and_credentials(env):
    _, client, h, _, _ = env
    for url in ("http://8.8.8.8:8080", "https://example.com", "http://user:pw@127.0.0.1:8080", "ftp://127.0.0.1", "http://169.254.169.254"):
        assert client.put("/api/tts/config", json={"url": url}, headers=h).status_code == 422, url
    assert client.put("/api/tts/config", json={"url": "http://192.168.1.50:8080"}, headers=h).status_code == 200


def test_config_validates_params(env):
    _, client, h, _, _ = env
    for bad in ({"temperature": 5}, {"chunkLength": 5}, {"topP": 0}, {"repetitionPenalty": 9}):
        assert client.put("/api/tts/config", json={"params": bad}, headers=h).status_code == 422, bad
    assert client.put("/api/tts/config", json={"format": "flac"}, headers=h).status_code == 422


def test_changing_url_without_new_key_drops_saved_key(env):
    _, client, h, _, _ = env
    client.put("/api/tts/config", json={"apiKey": "sk-secret-1234567890"}, headers=h)
    v = client.put("/api/tts/config", json={"url": "http://127.0.0.1:9999"}, headers=h).json()
    assert v["hasKey"] is False
    v = client.put("/api/tts/config", json={"url": "http://127.0.0.1:7777", "apiKey": "new-key-abcdefgh"}, headers=h).json()
    assert v["hasKey"] and v["keyHint"] == "••••efgh"


def test_env_key_not_sent_to_url_set_from_app(env, monkeypatch):
    app, client, h, fish, _ = env
    monkeypatch.setenv("FISH_SPEECH_API_KEY", "env-key-123456")
    assert tts.resolve(app.state.conn)["apiKey"] == "env-key-123456"
    client.put("/api/tts/config", json={"url": "http://127.0.0.1:9000"}, headers=h)
    assert tts.resolve(app.state.conn)["apiKey"] == ""


# ---------- голоса ----------

def test_voice_upload_list_delete_and_permissions(env):
    app, client, h, _, tmp = env
    wav = make_wav(4, rate=44100, channels=2)  # ~700 КБ: больше обычного лимита тела 256 КБ
    r = add_voice(client, h, wav)
    assert r.status_code == 201, r.text
    v = r.json()
    assert v["name"] == "Мой голос" and v["ext"] == "wav" and 3.9 < v["durationSec"] < 4.1 and "transcript" not in v
    d = tmp / "tts-voices" / v["id"]
    assert stat.S_IMODE(d.stat().st_mode) == 0o700
    for f in d.iterdir():
        assert stat.S_IMODE(f.stat().st_mode) == 0o600, f
    assert (d / "ref.wav").read_bytes() == wav
    listed = client.get("/api/tts/voices", headers=h).json()["voices"]
    assert [x["id"] for x in listed] == [v["id"]] and "transcript" not in json.dumps(listed)
    assert client.delete(f"/api/tts/voices/{v['id']}", headers=h).status_code == 200
    assert not d.exists()
    assert client.delete(f"/api/tts/voices/{v['id']}", headers=h).status_code == 404
    assert client.delete("/api/tts/voices/..%2Fx", headers=h).status_code in (404, 405, 422)
    assert client.delete("/api/tts/voices/v0000000000000000x", headers=h).status_code == 404


def test_voice_requires_consent_and_real_audio(env):
    _, client, h, _, _ = env
    assert add_voice(client, h, consent=False).status_code == 422
    assert add_voice(client, h, wav=b"this is not audio at all, just text").status_code == 422
    assert add_voice(client, h, audio="!!!не base64!!!" * 3).status_code == 422
    assert add_voice(client, h, wav=make_wav(1.0)).status_code == 422      # короче 3 с
    assert add_voice(client, h, wav=make_wav(70, rate=8000)).status_code == 422  # длиннее 60 с
    assert add_voice(client, h, name="   ").status_code == 422
    assert client.get("/api/tts/voices", headers=h).json()["voices"] == []


def test_voice_size_limit_and_count_limit(env, monkeypatch):
    _, client, h, _, _ = env
    big = make_wav(30, rate=44100, channels=2)  # ~5 МБ — проходит
    assert add_voice(client, h, wav=big).status_code == 201
    huge = b"RIFF\0\0\0\0WAVE" + b"\0" * (9 * 1024 * 1024)
    assert add_voice(client, h, wav=huge).status_code in (413, 422)
    monkeypatch.setattr(tts, "MAX_VOICES", 2)
    assert add_voice(client, h).status_code == 201
    assert add_voice(client, h).status_code == 409


# ---------- синтез и кеш ----------

def test_synthesize_calls_fish_with_reference_and_caches(env):
    app, client, h, fish, tmp = env
    client.put("/api/tts/config", json={"apiKey": "sk-secret-1234567890"}, headers=h)
    vid = add_voice(client, h).json()["id"]
    r = client.post("/api/tts/synthesize", json={"voiceId": vid, "text": PHRASE}, headers=h)
    assert r.status_code == 200, r.text
    info = r.json()
    # mp3 требует ffmpeg: без него сервер честно отдаёт wav, и кеш всё равно должен работать
    assert info["cached"] is False and info["ext"] in ("mp3", "wav") and len(info["hash"]) == 64 and info["bytes"] > 0
    assert 0.5 < info["duration"] < 0.7
    call = fish.calls[0]
    b = call["body"]
    assert b["text"] == PHRASE and b["format"] == "wav" and b["use_memory_cache"] == "on" and b["streaming"] is False
    assert b["references"][0]["text"] == "Это образец моего голоса." and b["references"][0]["audio"][:4] == b"RIFF"
    assert call["headers"]["authorization"] == "Bearer sk-secret-1234567890" and call["headers"]["content-type"] == "application/msgpack"
    assert call["url"].startswith("http://127.0.0.1:8080/")
    # повтор: из кеша, Fish не трогаем
    again = client.post("/api/tts/synthesize", json={"voiceId": vid, "text": PHRASE}, headers=h).json()
    assert again["cached"] is True and again["hash"] == info["hash"] and len(fish.calls) == 1
    # пробелы и переводы строк не создают новую запись
    same = client.post("/api/tts/synthesize", json={"voiceId": vid, "text": "  Запись   началась.\nВперёд. "}, headers=h).json()
    assert same["hash"] == info["hash"] and len(fish.calls) == 1
    # файл отдаётся с авторизацией и лежит с правами 0600
    a = client.get(f"/api/tts/audio/{info['hash']}", headers=h)
    assert a.status_code == 200 and a.headers["content-type"] == tts.MEDIA[info["ext"]]
    p = tmp / "tts-cache" / f"{info['hash']}.{info['ext']}"
    assert stat.S_IMODE(p.stat().st_mode) == 0o600 and stat.S_IMODE(p.parent.stat().st_mode) == 0o700


def test_param_and_voice_changes_change_the_cache_key(env):
    _, client, h, fish, _ = env
    v1, v2 = add_voice(client, h).json()["id"], add_voice(client, h).json()["id"]
    a = client.post("/api/tts/synthesize", json={"voiceId": v1, "text": PHRASE}, headers=h).json()["hash"]
    b = client.post("/api/tts/synthesize", json={"voiceId": v2, "text": PHRASE}, headers=h).json()["hash"]
    client.put("/api/tts/config", json={"params": {"temperature": 0.4}}, headers=h)
    c = client.post("/api/tts/synthesize", json={"voiceId": v1, "text": PHRASE}, headers=h).json()["hash"]
    assert len({a, b, c}) == 3 and len(fish.calls) == 3


def test_wav_format_when_requested_or_no_ffmpeg(env, monkeypatch):
    _, client, h, fish, _ = env
    vid = add_voice(client, h).json()["id"]
    client.put("/api/tts/config", json={"format": "wav"}, headers=h)
    r = client.post("/api/tts/synthesize", json={"voiceId": vid, "text": PHRASE}, headers=h).json()
    assert r["ext"] == "wav"
    client.put("/api/tts/config", json={"format": "mp3"}, headers=h)
    monkeypatch.setattr(tts, "ffmpeg_path", lambda: None)
    r2 = client.post("/api/tts/synthesize", json={"voiceId": vid, "text": "Другая фраза."}, headers=h).json()
    assert r2["ext"] == "wav"


def test_mp3_conversion_failure_falls_back_to_wav(env, monkeypatch):
    _, client, h, _, _ = env
    vid = add_voice(client, h).json()["id"]

    async def broken(_wav):
        return None
    monkeypatch.setattr(tts, "wav_to_mp3", broken)
    assert client.post("/api/tts/synthesize", json={"voiceId": vid, "text": PHRASE}, headers=h).json()["ext"] == "wav"


def test_text_validation(env):
    _, client, h, _, _ = env
    vid = add_voice(client, h).json()["id"]
    for text in ("   ", "а" * 501, "a\x07b"):
        assert client.post("/api/tts/synthesize", json={"voiceId": vid, "text": text}, headers=h).status_code == 422, repr(text)
    assert client.post("/api/tts/synthesize", json={"voiceId": "v" + "0" * 16, "text": PHRASE}, headers=h).status_code == 404
    assert client.post("/api/tts/synthesize", json={"voiceId": "../etc", "text": PHRASE}, headers=h).status_code == 422


@pytest.mark.parametrize("mode,status", [("down", 503), ("http500", 502), ("garbage", 502), ("denied", 502)])
def test_fish_failures_become_clear_errors_and_cache_nothing(env, mode, status):
    _, client, h, fish, tmp = env
    vid = add_voice(client, h).json()["id"]
    fish.mode = mode
    r = client.post("/api/tts/synthesize", json={"voiceId": vid, "text": PHRASE}, headers=h)
    assert r.status_code == status and r.json()["detail"]
    assert not list((tmp / "tts-cache").glob("*")) if (tmp / "tts-cache").exists() else True
    fish.mode = "ok"
    assert client.post("/api/tts/synthesize", json={"voiceId": vid, "text": PHRASE}, headers=h).status_code == 200


def test_audio_endpoint_validates_hash(env):
    _, client, h, _, _ = env
    assert client.get("/api/tts/audio/" + "a" * 64, headers=h).status_code == 404
    assert client.get("/api/tts/audio/..%2F..%2Fworkout.db", headers=h).status_code == 404
    assert client.get("/api/tts/audio/" + "A" * 64, headers=h).status_code == 404


def test_cache_lru_eviction(tmp_path):
    c = tts.AudioCache(tmp_path / "c", 10_000)
    for i in range(3):
        c.put(f"{i:064x}", bytes(1000), "mp3")
        os.utime(c.root / f"{i:064x}.mp3", (1000 + i, 1000 + i))
    c.limit = 2500
    assert c.find(f"{0:064x}")  # «использовали» самую старую: она свежее остальных
    c.put(f"{9:064x}", bytes(1000), "mp3")
    left = {p.stem for p in c.files()}
    assert f"{0:064x}" in left and f"{9:064x}" in left and f"{1:064x}" not in left
    assert c.usage()["bytes"] <= 2500
    assert c.clear() == len(left) and c.usage()["files"] == 0


def test_cache_clear_endpoint(env):
    _, client, h, _, _ = env
    vid = add_voice(client, h).json()["id"]
    client.post("/api/tts/synthesize", json={"voiceId": vid, "text": PHRASE}, headers=h)
    assert client.get("/api/tts/status", headers=h).json()["cache"]["files"] == 1
    assert client.delete("/api/tts/cache", headers=h).json()["removed"] == 1
    assert client.get("/api/tts/status", headers=h).json()["cache"]["files"] == 0


# ---------- статус ----------

def test_status_reports_reachability(env):
    _, client, h, fish, _ = env
    s = client.get("/api/tts/status", headers=h).json()
    assert s["reachable"] is True and s["latencyMs"] is not None and s["voices"] == 0
    fish.mode = "down"
    s = client.get("/api/tts/status", headers=h).json()
    assert s["reachable"] is False and "не отвечает" in s["message"]
    fish.mode = "denied"
    assert "ключ" in client.get("/api/tts/status", headers=h).json()["message"]


# ---------- пак ----------

def read_events(resp) -> list[dict]:
    return [json.loads(line[6:]) for line in resp.text.split("\n\n") if line.startswith("data: ")]


def test_pack_streams_progress_and_is_idempotent(env):
    _, client, h, fish, _ = env
    vid = add_voice(client, h).json()["id"]
    phrases = [{"key": f"p{i}", "text": f"Фраза номер {'раз два три'.split()[i]}."} for i in range(3)]
    ev = read_events(client.post("/api/tts/pack", json={"voiceId": vid, "phrases": phrases}, headers=h))
    assert ev[0] == {"type": "start", "total": 3} and ev[-1] == {"type": "done", "ok": 3, "failed": 0}
    items = [e for e in ev if e["type"] == "item"]
    assert [e["key"] for e in items] == ["p0", "p1", "p2"] and all(not e["cached"] and e["hash"] for e in items)
    assert len(fish.calls) == 3
    ev2 = read_events(client.post("/api/tts/pack", json={"voiceId": vid, "phrases": phrases}, headers=h))
    assert [e["cached"] for e in ev2 if e["type"] == "item"] == [True, True, True] and len(fish.calls) == 3
    for e in items:
        assert client.get(f"/api/tts/audio/{e['hash']}", headers=h).status_code == 200


def test_pack_resumes_after_failure(env):
    _, client, h, fish, _ = env
    vid = add_voice(client, h).json()["id"]
    phrases = [{"key": "a", "text": "Первая."}, {"key": "b", "text": "Вторая."}]
    client.post("/api/tts/synthesize", json={"voiceId": vid, "text": "Первая."}, headers=h)
    fish.mode = "down"
    ev = read_events(client.post("/api/tts/pack", json={"voiceId": vid, "phrases": phrases}, headers=h))
    assert [e["type"] for e in ev] == ["start", "item", "error", "fatal"] and ev[1]["cached"] is True
    fish.mode = "ok"
    ev = read_events(client.post("/api/tts/pack", json={"voiceId": vid, "phrases": phrases}, headers=h))
    assert ev[-1] == {"type": "done", "ok": 2, "failed": 0}
    assert [e["cached"] for e in ev if e["type"] == "item"] == [True, False]


def test_pack_validation(env):
    _, client, h, _, _ = env
    vid = add_voice(client, h).json()["id"]
    dup = [{"key": "a", "text": "Раз."}, {"key": "a", "text": "Два."}]
    assert client.post("/api/tts/pack", json={"voiceId": vid, "phrases": dup}, headers=h).status_code == 422
    assert client.post("/api/tts/pack", json={"voiceId": vid, "phrases": []}, headers=h).status_code == 422
    many = [{"key": f"k{i}", "text": "Раз."} for i in range(tts.MAX_PACK + 1)]
    assert client.post("/api/tts/pack", json={"voiceId": vid, "phrases": many}, headers=h).status_code == 422
    assert client.post("/api/tts/pack", json={"voiceId": vid, "phrases": [{"key": "a b", "text": "Раз."}]}, headers=h).status_code == 422
    assert client.post("/api/tts/pack", json={"voiceId": "v" + "1" * 16, "phrases": [{"key": "a", "text": "Раз."}]}, headers=h).status_code == 404


def test_phrase_text_is_never_logged(env, caplog):
    _, client, h, fish, _ = env
    secret = "Совершенно секретная фраза про маршрут."
    vid = add_voice(client, h).json()["id"]
    with caplog.at_level(logging.DEBUG):
        client.post("/api/tts/synthesize", json={"voiceId": vid, "text": secret}, headers=h)
        fish.mode = "http500"
        client.post("/api/tts/synthesize", json={"voiceId": vid, "text": secret + " ещё"}, headers=h)
    assert secret not in caplog.text
