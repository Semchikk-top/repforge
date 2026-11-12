"""Озвучка через Fish Speech: настройки подключения, библиотека голосов, дисковый кеш и прокси.

Приложение разговаривает только с этим сервером. Адрес Fish и его ключ остаются на ПК и на телефон не попадают.
Fish слушает только 127.0.0.1 (см. VOICE.md). Референсные записи голосов лежат в data/tts-voices/<id>/
(каталог 0700, файлы 0600), не синхронизируются и никуда не отправляются, кроме самого Fish на этом же ПК.

Текст фраз в журнал не пишется. Секреты наружу не отдаются: клиент видит «ключ задан» и последние 4 символа.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import struct
import time
import wave
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import db as store
from .assistant import config as acfg

META_KEY = "tts_config"
DEFAULT_URL = "http://127.0.0.1:8080"
DEFAULT_PARAMS: dict[str, Any] = {"temperature": 0.7, "topP": 0.7, "repetitionPenalty": 1.2, "chunkLength": 200, "seed": None}

MAX_TEXT = 500                 # знаков в одной фразе
MAX_PACK = 200                 # фраз в одном паке
MAX_VOICES = 20
MAX_REF_BYTES = 8 * 1024 * 1024
MAX_VOICE_BODY_CHARS = 12 * 1024 * 1024   # base64 + служебное; сверяется с лимитом тела в security.py
MAX_FISH_AUDIO = 40 * 1024 * 1024
REF_MIN_SEC, REF_MAX_SEC = 3.0, 60.0      # жёсткие границы; рекомендовано 10–30 с (клиент предупреждает)
FISH_TIMEOUT = httpx.Timeout(120.0, connect=3.0)
FFMPEG_TIMEOUT = 30.0
VOICE_ID = r"^v[0-9a-f]{16}$"
HASH = r"^[0-9a-f]{64}$"
KEY_PATTERN = r"^[A-Za-z0-9_.:\-]+$"
MEDIA = {"mp3": "audio/mpeg", "wav": "audio/wav"}


class TtsError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message, self.status = message, status


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


# ---------- настройки ----------

def load_cfg(conn: sqlite3.Connection | None) -> dict[str, Any]:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (META_KEY,)).fetchone() if conn is not None else None
    try:
        data = json.loads(row["value"]) if row else {}
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


def save_cfg(conn: sqlite3.Connection, data: dict[str, Any]) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (META_KEY, json.dumps(data, ensure_ascii=False)))


def resolve(conn: sqlite3.Connection | None, ov: dict[str, Any] | None = None) -> dict[str, Any]:
    """Итоговые настройки: из приложения, иначе из окружения. Ключ из окружения не уходит на адрес, заданный из приложения.
    `ov` — ещё не сохранённые настройки (проверка перед записью); по умолчанию читаются из базы."""
    ov = load_cfg(conn) if ov is None else ov
    env_url = _env("FISH_SPEECH_URL", DEFAULT_URL)
    app_url = str(ov.get("url") or "").strip()
    env_key = _env("FISH_SPEECH_API_KEY")
    if app_url and not acfg._same_url(app_url, env_url):
        env_key = ""
    params = dict(DEFAULT_PARAMS)
    params.update({k: v for k, v in (ov.get("params") or {}).items() if k in DEFAULT_PARAMS})
    fmt = ov.get("format") if ov.get("format") in MEDIA else "mp3"
    return {"url": (app_url or env_url).rstrip("/"), "apiKey": str(ov.get("apiKey") or "") or env_key,
            "keySource": "app" if ov.get("apiKey") else ("env" if env_key else "none"), "format": fmt, "params": params}


def public_view(conn: sqlite3.Connection | None) -> dict[str, Any]:
    c = resolve(conn)
    return {"url": c["url"], "hasKey": bool(c["apiKey"]), "keyHint": acfg.mask_secret(c["apiKey"]), "keySource": c["keySource"],
            "format": c["format"], "params": c["params"], "ffmpeg": ffmpeg_path() is not None}


def canonical_params(cfg: dict[str, Any]) -> str:
    p = cfg["params"]
    eff = "mp3" if (cfg["format"] == "mp3" and ffmpeg_path()) else "wav"
    return json.dumps({"v": 1, "fmt": eff, "t": p["temperature"], "p": p["topP"], "r": p["repetitionPenalty"], "c": p["chunkLength"], "s": p["seed"]},
                      sort_keys=True, separators=(",", ":"))


def cache_key(voice_id: str, canon: str, text: str) -> str:
    return hashlib.sha256(f"{voice_id}\n{canon}\n{text}".encode()).hexdigest()


# ---------- минимальный msgpack ----------
# Fish принимает ссылки на голос (байты) только в msgpack. Пакуем сами: нужны лишь словари, строки, байты, числа, bool и None.

def mp_pack(o: Any) -> bytes:
    if o is None:
        return b"\xc0"
    if o is True:
        return b"\xc3"
    if o is False:
        return b"\xc2"
    if isinstance(o, int):
        if 0 <= o < 128:
            return bytes([o])
        if -32 <= o < 0:
            return struct.pack("b", o)
        return b"\xd3" + struct.pack(">q", o)
    if isinstance(o, float):
        return b"\xcb" + struct.pack(">d", o)
    if isinstance(o, str):
        b = o.encode()
        n = len(b)
        head = bytes([0xA0 | n]) if n < 32 else (b"\xd9" + bytes([n]) if n < 256 else (b"\xda" + struct.pack(">H", n) if n < 65536 else b"\xdb" + struct.pack(">I", n)))
        return head + b
    if isinstance(o, (bytes, bytearray)):
        n = len(o)
        head = b"\xc4" + bytes([n]) if n < 256 else (b"\xc5" + struct.pack(">H", n) if n < 65536 else b"\xc6" + struct.pack(">I", n))
        return head + bytes(o)
    if isinstance(o, (list, tuple)):
        n = len(o)
        head = bytes([0x90 | n]) if n < 16 else (b"\xdc" + struct.pack(">H", n) if n < 65536 else b"\xdd" + struct.pack(">I", n))
        return head + b"".join(mp_pack(x) for x in o)
    if isinstance(o, dict):
        n = len(o)
        head = bytes([0x80 | n]) if n < 16 else (b"\xde" + struct.pack(">H", n) if n < 65536 else b"\xdf" + struct.pack(">I", n))
        return head + b"".join(mp_pack(k) + mp_pack(v) for k, v in o.items())
    raise TypeError(f"msgpack: {type(o).__name__}")


# ---------- образцы голоса ----------

def sniff_audio(data: bytes) -> str | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[:3] == b"ID3" or (len(data) > 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "mp3"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"fLaC":
        return "flac"
    return None


def wav_duration(data: bytes) -> float | None:
    try:
        with wave.open(io.BytesIO(data)) as w:
            return w.getnframes() / float(w.getframerate())
    except (wave.Error, EOFError, ZeroDivisionError, struct.error):
        return None


class VoiceStore:
    """Голоса: audio + transcript + consent в data/tts-voices/<id>/."""

    def __init__(self, root: Path):
        self.root = root

    def _dir(self, voice_id: str) -> Path:
        if not re.match(VOICE_ID, voice_id):
            raise KeyError(voice_id)
        return self.root / voice_id

    def _mkdir(self, p: Path) -> None:
        p.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(p, 0o700)

    def list(self) -> list[dict[str, Any]]:
        out = []
        if self.root.exists():
            for d in sorted(self.root.iterdir()):
                m = self._meta(d)
                if m:
                    out.append(m)
        out.sort(key=lambda m: m["createdAt"])
        return out

    def _meta(self, d: Path) -> dict[str, Any] | None:
        try:
            m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            return {"id": m["id"], "name": m["name"], "createdAt": m["createdAt"], "bytes": m["bytes"], "durationSec": m.get("durationSec"), "ext": m["ext"]}
        except (OSError, ValueError, KeyError):
            return None

    def add(self, name: str, transcript: str, audio: bytes, ext: str, duration: float | None) -> dict[str, Any]:
        if len(self.list()) >= MAX_VOICES:
            raise TtsError(f"Достигнут предел голосов ({MAX_VOICES}): удали ненужные", 409)
        vid = "v" + secrets.token_hex(8)
        d = self._dir(vid)
        self._mkdir(self.root)
        self._mkdir(d)
        meta = {"id": vid, "name": name, "transcript": transcript, "consent": True, "consentAt": int(time.time() * 1000),
                "createdAt": int(time.time() * 1000), "bytes": len(audio), "durationSec": duration, "ext": ext}
        self._write(d / f"ref.{ext}", audio)
        self._write(d / "meta.json", json.dumps(meta, ensure_ascii=False).encode())
        return self._meta(d) or {}

    def _write(self, path: Path, data: bytes) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(path, 0o600)

    def load(self, voice_id: str) -> tuple[dict[str, Any], bytes]:
        try:
            d = self._dir(voice_id)
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
            return meta, (d / f"ref.{meta['ext']}").read_bytes()
        except (KeyError, OSError, ValueError):
            raise TtsError("Голос не найден", 404)

    def delete(self, voice_id: str) -> bool:
        try:
            d = self._dir(voice_id)
        except KeyError:
            return False
        if not d.exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True


# ---------- кеш готовых фраз ----------

class AudioCache:
    def __init__(self, root: Path, limit_bytes: int):
        self.root, self.limit = root, limit_bytes

    def find(self, h: str) -> Path | None:
        for ext in MEDIA:
            p = self.root / f"{h}.{ext}"
            if p.is_file():
                try:
                    os.utime(p)  # LRU: свежее использование откладывает вытеснение
                except OSError:
                    pass
                return p
        return None

    def put(self, h: str, data: bytes, ext: str) -> Path:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        p = self.root / f"{h}.{ext}"
        tmp = self.root / f".{h}.{secrets.token_hex(4)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
        os.chmod(p, 0o600)
        self.evict(keep=p)
        return p

    def files(self) -> list[Path]:
        return [p for p in self.root.glob("*") if p.is_file() and p.suffix[1:] in MEDIA] if self.root.exists() else []

    def usage(self) -> dict[str, int]:
        fs = self.files()
        return {"files": len(fs), "bytes": sum(p.stat().st_size for p in fs), "limitBytes": self.limit}

    def evict(self, keep: Path | None = None) -> None:
        fs = sorted(self.files(), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in fs)
        for p in fs:
            if total <= self.limit:
                break
            if p == keep:
                continue
            total -= p.stat().st_size
            p.unlink(missing_ok=True)

    def clear(self) -> int:
        n = 0
        for p in self.files():
            p.unlink(missing_ok=True)
            n += 1
        return n


# ---------- обращение к Fish ----------

def _headers(cfg: dict[str, Any], content_type: str | None = None) -> dict[str, str]:
    h = {"Content-Type": content_type} if content_type else {}
    if cfg["apiKey"]:
        h["Authorization"] = f"Bearer {cfg['apiKey']}"
    return h


async def fish_health(client: httpx.AsyncClient, cfg: dict[str, Any]) -> tuple[bool, int | None, str]:
    t0 = time.monotonic()
    try:
        r = await client.get(f"{cfg['url']}/v1/health", headers=_headers(cfg), timeout=2.5)
    except httpx.HTTPError as e:
        return False, None, f"Fish Speech не отвечает ({e.__class__.__name__})"
    ms = int((time.monotonic() - t0) * 1000)
    if r.status_code in (401, 403):
        return False, ms, "Fish Speech отклонил ключ"
    if r.status_code != 200:
        return False, ms, f"Fish Speech ответил {r.status_code}"
    return True, ms, ""


async def fish_tts(client: httpx.AsyncClient, cfg: dict[str, Any], text: str, ref: bytes, transcript: str) -> bytes:
    p = cfg["params"]
    body: dict[str, Any] = {
        "text": text, "chunk_length": int(p["chunkLength"]), "format": "wav", "streaming": False, "normalize": True,
        "references": [{"audio": ref, "text": transcript}], "use_memory_cache": "on",
        "temperature": float(p["temperature"]), "top_p": float(p["topP"]), "repetition_penalty": float(p["repetitionPenalty"]),
        "max_new_tokens": 1024, "seed": p["seed"],
    }
    try:
        async with client.stream("POST", f"{cfg['url']}/v1/tts", content=mp_pack(body), headers=_headers(cfg, "application/msgpack"), timeout=FISH_TIMEOUT) as r:
            if r.status_code in (401, 403):
                raise TtsError("Fish Speech отклонил ключ: проверь его в настройках сервера", 502)
            if r.status_code != 200:
                await r.aread()
                raise TtsError(f"Fish Speech ответил {r.status_code}", 502)
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > MAX_FISH_AUDIO:
                    raise TtsError("Fish Speech вернул слишком большой файл", 502)
    except httpx.TimeoutException:
        raise TtsError("Fish Speech не успел ответить: фраза слишком длинная или карта занята", 504)
    except httpx.HTTPError:
        raise TtsError("Fish Speech не отвечает: запусти его и проверь адрес в настройках сервера", 503)
    if sniff_audio(bytes(buf[:12])) != "wav":
        raise TtsError("Fish Speech вернул не аудио", 502)
    return bytes(buf)


async def wav_to_mp3(wav: bytes) -> bytes | None:
    exe = ffmpeg_path()
    if not exe:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(exe, "-v", "error", "-i", "pipe:0", "-codec:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "pipe:1",
                                                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(wav), FFMPEG_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return None
    return out if proc.returncode == 0 and sniff_audio(out[:4] + b"\0" * 8) == "mp3" else None


def clean_text(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    if not t or len(t) > MAX_TEXT or any(ord(c) < 32 for c in t):
        raise TtsError(f"Текст должен быть от 1 до {MAX_TEXT} знаков", 422)
    return t


class Engine:
    """Синтез с кешем: один запрос к Fish за раз (видеокарта одна), повторные фразы отдаются с диска."""

    def __init__(self, conn: sqlite3.Connection, voices: VoiceStore, cache: AudioCache, client_factory: Callable[[], httpx.AsyncClient] | None = None):
        self.conn, self.voices, self.cache = conn, voices, cache
        self.client_factory = client_factory
        self.gpu = asyncio.Semaphore(1)
        self.durations: dict[str, float | None] = {}

    def client(self) -> httpx.AsyncClient:
        return (self.client_factory or (lambda: httpx.AsyncClient(timeout=FISH_TIMEOUT)))()

    async def synthesize(self, voice_id: str, text: str, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
        text = clean_text(text)
        cfg = resolve(self.conn)
        meta, ref = self.voices.load(voice_id)
        h = cache_key(voice_id, canonical_params(cfg), text)
        hit = self.cache.find(h)
        if hit:
            return self._info(h, hit, True)
        own = client is None
        client = client or self.client()
        try:
            async with self.gpu:
                hit = self.cache.find(h)  # пока ждали очередь, ту же фразу мог собрать другой запрос
                if hit:
                    return self._info(h, hit, True)
                wav = await fish_tts(client, cfg, text, ref, meta["transcript"])
        finally:
            if own:
                await client.aclose()
        duration = wav_duration(wav)
        data, ext = wav, "wav"
        if cfg["format"] == "mp3":
            mp3 = await wav_to_mp3(wav)
            if mp3:
                data, ext = mp3, "mp3"
        self.durations[h] = duration
        return self._info(h, self.cache.put(h, data, ext), False)

    def _info(self, h: str, path: Path, cached: bool) -> dict[str, Any]:
        return {"hash": h, "ext": path.suffix[1:], "bytes": path.stat().st_size, "duration": self.durations.get(h), "cached": cached}


# ---------- модели запросов ----------

class ParamsIn(BaseModel):
    temperature: float | None = Field(default=None, ge=0.1, le=1.0)
    topP: float | None = Field(default=None, ge=0.1, le=1.0)
    repetitionPenalty: float | None = Field(default=None, ge=0.9, le=2.0)
    chunkLength: int | None = Field(default=None, ge=100, le=300)
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)


class CfgIn(BaseModel):
    url: str | None = Field(default=None, max_length=300)
    apiKey: str | None = Field(default=None, max_length=500)  # None — не менять, "" — удалить
    format: str | None = Field(default=None, pattern="^(mp3|wav)$")
    params: ParamsIn | None = None


class VoiceIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    transcript: str = Field(min_length=1, max_length=1000)
    consent: bool
    audio: str = Field(min_length=16, max_length=MAX_VOICE_BODY_CHARS)  # base64


class SynthIn(BaseModel):
    voiceId: str = Field(pattern=VOICE_ID)
    text: str = Field(min_length=1, max_length=MAX_TEXT * 2)


class PhraseIn(BaseModel):
    key: str = Field(min_length=1, max_length=80, pattern=KEY_PATTERN)
    text: str = Field(min_length=1, max_length=MAX_TEXT * 2)


class PackIn(BaseModel):
    voiceId: str = Field(pattern=VOICE_ID)
    phrases: list[PhraseIn] = Field(min_length=1, max_length=MAX_PACK)


def _sse(ev: dict[str, Any]) -> str:
    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"


# ---------- маршруты ----------

def register(app: FastAPI, conn: sqlite3.Connection, auth: Callable[..., sqlite3.Row], too_many: Callable[[str, int], bool],
             sse_headers: dict[str, str], data_dir: Path | None = None) -> Engine:
    data_dir = data_dir or store.DATA_DIR
    voices = VoiceStore(data_dir / "tts-voices")
    limit_mb = int(_env("WORKOUT_TTS_CACHE_MB", "500") or "500")
    cache = AudioCache(data_dir / "tts-cache", max(10, limit_mb) * 1024 * 1024)
    engine = Engine(conn, voices, cache)
    app.state.tts = engine
    pack_lock = asyncio.Lock()

    def fail(e: TtsError):
        raise HTTPException(e.status, e.message)

    @app.get("/api/tts/config")
    def tts_config(dev: sqlite3.Row = Depends(auth)):
        return public_view(conn)

    @app.put("/api/tts/config")
    def tts_config_save(body: CfgIn, dev: sqlite3.Row = Depends(auth)):
        if too_many("ttscfg:" + dev["id"], 20):
            raise HTTPException(429, "Слишком много изменений, подожди минуту")
        ov = load_cfg(conn)
        before = resolve(conn)["url"]
        if body.url is not None:
            ov["url"] = body.url.strip()
        if body.apiKey is not None:
            ov["apiKey"] = body.apiKey.strip()
        if body.format is not None:
            ov["format"] = body.format
        if body.params is not None:
            cur = dict(ov.get("params") or {})
            cur.update(body.params.model_dump(exclude_unset=True))
            ov["params"] = cur
        after = resolve(conn, ov)["url"]  # адрес уже из нового запроса, а не из сохранённого
        if not acfg._same_url(before, after) and body.apiKey is None:
            ov.pop("apiKey", None)  # сменился адрес, а нового ключа нет: старый на новый адрес не уходит
        if after and (err := acfg.validate_url("local", after)):
            raise HTTPException(422, err)
        with store.tx(conn):
            save_cfg(conn, ov)
        return public_view(conn)

    @app.get("/api/tts/status")
    async def tts_status(dev: sqlite3.Row = Depends(auth)):
        if too_many("ttsst:" + dev["id"], 60):
            raise HTTPException(429, "Слишком много проверок, подожди минуту")
        cfg = resolve(conn)
        async with engine.client() as client:
            ok, ms, msg = await fish_health(client, cfg)
        return {"reachable": ok, "latencyMs": ms, "message": msg, "voices": len(voices.list()), "cache": cache.usage(),
                "format": "mp3" if (cfg["format"] == "mp3" and ffmpeg_path()) else "wav", "ffmpeg": ffmpeg_path() is not None}

    @app.get("/api/tts/voices")
    def tts_voices(dev: sqlite3.Row = Depends(auth)):
        return {"voices": voices.list()}

    @app.post("/api/tts/voices", status_code=201)
    def tts_voice_add(body: VoiceIn, dev: sqlite3.Row = Depends(auth)):
        if too_many("ttsvoice:" + dev["id"], 10):
            raise HTTPException(429, "Слишком много загрузок, подожди минуту")
        if not body.consent:
            raise HTTPException(422, "Нужно подтвердить, что это твой голос или у тебя есть согласие его владельца")
        name = re.sub(r"\s+", " ", body.name).strip()
        transcript = re.sub(r"\s+", " ", body.transcript).strip()
        if not name or not transcript:
            raise HTTPException(422, "Укажи название и текст образца")
        try:
            raw = base64.b64decode(body.audio, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(422, "Файл не удалось прочитать")
        if len(raw) > MAX_REF_BYTES:
            raise HTTPException(413, "Образец больше 8 МБ: возьми запись покороче")
        ext = sniff_audio(raw)
        if ext is None:
            raise HTTPException(422, "Нужен звуковой файл: WAV, MP3, OGG или FLAC")
        duration = wav_duration(raw) if ext == "wav" else None
        if ext == "wav" and duration is None:
            raise HTTPException(422, "WAV-файл повреждён")
        if duration is not None and not (REF_MIN_SEC <= duration <= REF_MAX_SEC):
            raise HTTPException(422, f"Образец должен длиться от {REF_MIN_SEC:g} до {REF_MAX_SEC:g} секунд (лучше 10–30)")
        try:
            return voices.add(name, transcript, raw, ext, duration)
        except TtsError as e:
            fail(e)

    @app.delete("/api/tts/voices/{voice_id}")
    def tts_voice_delete(voice_id: str, dev: sqlite3.Row = Depends(auth)):
        if not voices.delete(voice_id):
            raise HTTPException(404, "Голос не найден")
        return {"ok": True}

    @app.post("/api/tts/synthesize")
    async def tts_synthesize(body: SynthIn, dev: sqlite3.Row = Depends(auth)):
        if too_many("ttssyn:" + dev["id"], 30):
            raise HTTPException(429, "Слишком много запросов, подожди минуту")
        try:
            return await engine.synthesize(body.voiceId, body.text)
        except TtsError as e:
            fail(e)

    @app.get("/api/tts/audio/{h}")
    def tts_audio(h: str, dev: sqlite3.Row = Depends(auth)):
        if not re.match(HASH, h):
            raise HTTPException(404, "Файл не найден")
        p = cache.find(h)
        if not p:
            raise HTTPException(404, "Файл не найден: он мог быть вытеснен из кеша, подготовь озвучку заново")
        return FileResponse(p, media_type=MEDIA[p.suffix[1:]], headers={"Cache-Control": "private, no-store"})

    @app.delete("/api/tts/cache")
    def tts_cache_clear(dev: sqlite3.Row = Depends(auth)):
        return {"removed": cache.clear()}

    @app.post("/api/tts/pack")
    async def tts_pack(body: PackIn, request: Request, dev: sqlite3.Row = Depends(auth)):
        """Сборка пака: поток событий. Прерванную сборку можно запустить снова, готовые фразы берутся из кеша."""
        if too_many("ttspack:" + dev["id"], 8):
            raise HTTPException(429, "Слишком много запусков, подожди минуту")
        try:
            voices.load(body.voiceId)
        except TtsError as e:
            fail(e)
        seen: set[str] = set()
        phrases = []
        for ph in body.phrases:
            if ph.key in seen:
                raise HTTPException(422, "Ключи фраз должны быть уникальны")
            seen.add(ph.key)
            try:
                phrases.append((ph.key, clean_text(ph.text)))
            except TtsError as e:
                fail(e)
        if pack_lock.locked():
            raise HTTPException(429, "Подготовка уже идёт: дождись её окончания")

        async def events():
            async with pack_lock:
                ok = bad = 0
                yield _sse({"type": "start", "total": len(phrases)})
                async with engine.client() as client:
                    for key, text in phrases:
                        if await request.is_disconnected():
                            return
                        try:
                            info = await engine.synthesize(body.voiceId, text, client)
                        except TtsError as e:
                            bad += 1
                            yield _sse({"type": "error", "key": key, "message": e.message})
                            if e.status in (503, 504) or "ключ" in e.message:  # Fish недоступен: остальные фразы тоже не выйдут
                                yield _sse({"type": "fatal", "message": e.message})
                                return
                            continue
                        ok += 1
                        yield _sse({"type": "item", "key": key, **info})
                yield _sse({"type": "done", "ok": ok, "failed": bad})

        return StreamingResponse(events(), media_type="text/event-stream", headers=sse_headers)

    return engine
