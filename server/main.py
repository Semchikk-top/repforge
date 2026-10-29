"""Сервер синхронизации и раздачи PWA."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sqlite3
import sys
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import db as store
from . import mdns, netinfo, pairing, qr, security
from .assistant import agent, config as acfg, providers

DIST_DIR = Path(os.environ.get("WORKOUT_DIST_DIR", Path(__file__).resolve().parent.parent / "dist"))
BACKUP_KEEP = 14
MAX_BATCH = 2000
MAX_ENTITY_BYTES = 256_000
MAX_CHAT_CHARS = 40_000
CLOCK_SKEW_MS = 30 * 24 * 3600 * 1000  # метка времени дальше этого срока вперёд считается подделкой
ID_PATTERN = r"^[A-Za-z0-9_.:\-]+$"


# ---------- модели запросов ----------

class PairIn(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    deviceId: str = Field(min_length=8, max_length=64, pattern=ID_PATTERN)
    name: str = Field(default="Устройство", max_length=60)


class EntityIn(BaseModel):
    table: str
    id: str = Field(min_length=1, max_length=64, pattern=ID_PATTERN)
    updatedAt: int = Field(ge=0, le=10**14)
    deviceId: str = Field(min_length=1, max_length=64, pattern=ID_PATTERN)
    deleted: bool = False
    data: dict[str, Any]


class PairRequestIn(BaseModel):
    deviceId: str = Field(min_length=8, max_length=64, pattern=ID_PATTERN)
    name: str = Field(default="Устройство", max_length=60)


class DecisionIn(BaseModel):
    approve: bool


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=8000)


class ChatIn(BaseModel):
    backend: str = Field(default="cloud", pattern="^(cloud|local|agent)$")
    messages: list[ChatMessage] = Field(min_length=1, max_length=60)
    today: str = Field(default="", max_length=10)


class CloudCfgIn(BaseModel):
    provider: str | None = Field(default=None, pattern="^(anthropic|openai)$")
    baseUrl: str | None = Field(default=None, max_length=300)
    apiKey: str | None = Field(default=None, max_length=500)  # None — не менять, "" — удалить
    model: str | None = Field(default=None, max_length=100)


class LocalCfgIn(BaseModel):
    url: str | None = Field(default=None, max_length=300)
    model: str | None = Field(default=None, max_length=100)


class AgentCfgIn(BaseModel):
    url: str | None = Field(default=None, max_length=300)
    token: str | None = Field(default=None, max_length=500)
    model: str | None = Field(default=None, max_length=100)


class AssistantCfgIn(BaseModel):
    cloud: CloudCfgIn | None = None
    local: LocalCfgIn | None = None
    agent: AgentCfgIn | None = None


class TestIn(BaseModel):
    backend: str = Field(pattern="^(cloud|local|agent)$")


class SyncIn(BaseModel):
    since: int = Field(default=0, ge=0)
    entities: list[EntityIn] = Field(default_factory=list, max_length=MAX_BATCH)


# ---------- приложение ----------

def make_app(db_path: Path | None = None) -> FastAPI:
    conn = store.connect(db_path)
    attempts: dict[str, deque[float]] = defaultdict(deque)
    chat_slots = asyncio.Semaphore(3)  # одновременных потоков ассистента (защита ключа облака от перерасхода)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        task = asyncio.create_task(_backup_loop(conn))
        handle = None
        if os.environ.get("WORKOUT_MDNS", "").lower() in ("1", "true", "yes"):
            if os.environ.get("WORKOUT_HOST", "127.0.0.1") in netinfo.LOOPBACK:
                print("mDNS: сервер слушает только 127.0.0.1, публикация бессмысленна (запусти с --host 0.0.0.0)")
            else:
                try:
                    handle = await mdns.start(int(os.environ.get("WORKOUT_PORT", "8000")), store.instance_id(conn))
                except Exception as e:  # публикация необязательна и не должна мешать запуску
                    print("mDNS: не удалось опубликовать сервис:", e)
        yield
        task.cancel()
        await mdns.stop(handle)

    app = FastAPI(title="Workout sync", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    # Сжатие нужно ради первого запуска PWA: единственный JS-чанк весит ~550 КБ и на мобильной сети
    # напрямую влияет на LCP. Starlette не трогает SSE (text/event-stream), шрифты и изображения —
    # они либо уже сжаты, либо потоковые, поэтому ассистент и картинки остаются как были.
    # 1 КБ отсекает мелкие ответы, где gzip только добавляет заголовки.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(security.SecurityMiddleware)
    app.state.conn = conn
    app.state.requests = pairing.Requests()
    app.state.check = None  # в тестах подменяется
    app.state.client_factory = None  # в тестах подменяется на клиент с MockTransport

    def auth(authorization: str | None = Header(default=None)) -> sqlite3.Row:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Нужна авторизация")
        dev = store.device_by_token(conn, authorization[7:])
        if not dev:
            raise HTTPException(401, "Устройство не подключено или отозвано")
        return dev

    def too_many(key: str, limit: int) -> bool:
        now = time.time()
        if len(attempts) > 1000:  # не копим ключи бесконечно (например, при переборе адресов IPv6)
            for k in [k for k, v in attempts.items() if not v or now - v[-1] > 60]:
                del attempts[k]
        q = attempts[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return True
        q.append(now)
        return False

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "?"

    @app.get("/api/health")
    def health():
        return {"ok": True, "seq": store.current_seq(conn), "instance": store.instance_id(conn)}

    @app.post("/api/pair")
    def pair(body: PairIn, request: Request):
        if too_many("pair:" + client_ip(request), 10) or too_many("pair:all", 40):
            raise HTTPException(429, "Слишком много попыток, подожди минуту")
        token = store.redeem_pair_code(conn, body.code, body.deviceId, body.name)
        if not token:
            # В журнале полезно отличать «код из другой БД» от «уже использован» и «истёк».
            print(f"pair: отказ ({store.pair_code_state(conn, body.code)})", file=sys.stderr, flush=True)
            raise HTTPException(403, "Код неверный или устарел")
        return {"token": token}

    @app.post("/api/sync")
    def sync(body: SyncIn, dev: sqlite3.Row = Depends(auth)):
        for e in body.entities:
            if e.table not in store.ALLOWED_TABLES:
                raise HTTPException(422, f"Неизвестная таблица: {e.table}")
            if len(json.dumps(e.data, ensure_ascii=False)) > MAX_ENTITY_BYTES:
                raise HTTPException(413, "Запись слишком большая")
        # метка времени из далёкого будущего сделала бы запись «неперезаписываемой» для остальных устройств
        horizon = int(time.time() * 1000) + CLOCK_SKEW_MS
        items = [{**e.model_dump(), "updatedAt": min(e.updatedAt, horizon)} for e in body.entities]
        with store.tx(conn):
            accepted = store.apply_entities(conn, items)
            changes, more, last_seq = store.entities_since(conn, body.since, accepted)
        return {
            "seq": last_seq if more else max(last_seq, store.current_seq(conn)),
            "more": more,
            "accepted": len(accepted),
            "entities": changes,
        }

    @app.get("/api/devices")
    def devices(dev: sqlite3.Row = Depends(auth)):
        rows = conn.execute("SELECT id, name, created_at, last_seen, revoked FROM devices ORDER BY created_at").fetchall()
        return [{**dict(r), "current": r["id"] == dev["id"]} for r in rows]

    @app.delete("/api/devices/{device_id}")
    def revoke(device_id: str, dev: sqlite3.Row = Depends(auth)):
        cur = conn.execute("UPDATE devices SET revoked = 1 WHERE id = ?", (device_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Нет такого устройства")
        return {"ok": True}

    # ---------- удобное сопряжение ----------
    def request_origin(request: Request) -> str | None:
        """Адрес, с которого пришёл запрос. Он попадает в ссылку с кодом и проверяется запросом с сервера,
        поэтому берём только заведомо «свои» адреса (см. security.host_allowed): иначе подставной Host
        превратил бы сервер в сканер чужих адресов, а ссылку с кодом увёл бы на чужой сайт."""
        host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
        if not host or not security.host_allowed(host):
            return None
        proto = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
        if proto not in ("http", "https") or security.split_host(host).endswith(".ts.net"):
            proto = "https" if security.split_host(host).endswith(".ts.net") else request.url.scheme
        return f"{proto}://{host}"

    @app.post("/api/pairing/invite")
    async def pairing_invite(request: Request, dev: sqlite3.Row = Depends(auth)):
        """Одноразовый код и лучшие адреса для подключения телефона рядом (с готовыми ссылками и QR)."""
        code = store.create_pair_code(conn)
        cands = await netinfo.detect(
            store.instance_id(conn),
            int(os.environ.get("WORKOUT_PORT", "8000")),
            current_origin=request_origin(request),
            public_url=os.environ.get("PUBLIC_URL"),
            check=app.state.check,
        )
        best = netinfo.pick_best(cands)
        out = []
        for c in cands:
            link = f"{c.url}/#/pair/{code}"
            out.append({**c.to_dict(), "link": link, "qr": qr.svg(link) if c.reachable else None})
        return {"code": code, "expiresAt": int(time.time()) + store.CODE_TTL_SEC, "candidates": out, "best": best}

    @app.post("/api/pairing/request")
    def pairing_request(body: PairRequestIn, request: Request):
        """Телефон просит подключиться. Код он получит только после подтверждения на уже подключённом устройстве."""
        if too_many("preq:" + client_ip(request), 6):
            raise HTTPException(429, "Слишком много запросов, подожди минуту")
        r = app.state.requests.create(body.deviceId, body.name, client_ip(request))
        if not r:
            raise HTTPException(429, "Уже есть ожидающие запросы. Подтверди или отклони их на ПК.")
        return {"requestId": r.id, "pin": r.pin, "expiresIn": pairing.REQUEST_TTL}

    @app.get("/api/pairing/request/{rid}")
    def pairing_poll(rid: str):
        return app.state.requests.poll(rid)

    @app.delete("/api/pairing/request/{rid}")
    def pairing_cancel(rid: str):
        app.state.requests.cancel(rid)
        return {"ok": True}

    @app.get("/api/pairing/pending")
    def pairing_pending(dev: sqlite3.Row = Depends(auth)):
        return [{"id": r.id, "name": r.name, "pin": r.pin, "ip": r.ip, "age": int(pairing.now() - r.created)} for r in app.state.requests.pending()]

    @app.post("/api/pairing/pending/{rid}")
    def pairing_decide(rid: str, body: DecisionIn, dev: sqlite3.Row = Depends(auth)):
        if not app.state.requests.decide(rid, body.approve, lambda: store.create_pair_code(conn)):
            raise HTTPException(404, "Запрос уже обработан или устарел")
        return {"ok": True}

    # ---------- ассистент ----------
    def overrides() -> dict[str, dict[str, str]]:
        return acfg.load_overrides(conn)

    async def probe(be) -> tuple[bool, list[str], str]:
        """Достучаться до провайдера и получить список моделей. (ок, модели, сообщение)"""
        if be.name == "cloud" and be.insecure:
            return False, [], be.hint
        if be.name == "cloud" and not be.api_key:
            return False, [], "Введи API-ключ"
        factory = app.state.client_factory or providers.make_client
        async with factory() as client:
            try:
                if be.name == "local":  # у Ollama свой, более надёжный метод
                    root = be.base_url[:-3] if be.base_url.endswith("/v1") else be.base_url
                    r = await client.get(f"{root}/api/tags", timeout=3.0)
                    if r.status_code != 200:
                        return False, [], f"Ollama ответила {r.status_code}"
                    return True, [m["name"] for m in r.json().get("models", [])][:100], ""
                return True, await providers.list_models(client, be), ""
            except providers.ProviderError as e:
                return False, [], str(e)
            except Exception as e:  # noqa: BLE001
                return False, [], f"Нет связи: {e.__class__.__name__}"

    @app.get("/api/assistant/config")
    def assistant_config(dev: sqlite3.Row = Depends(auth)):
        return acfg.public_view(conn)

    @app.put("/api/assistant/config")
    def assistant_config_save(body: AssistantCfgIn, dev: sqlite3.Row = Depends(auth)):
        if too_many("cfg:" + dev["id"], 20):
            raise HTTPException(429, "Слишком много изменений, подожди минуту")
        ov = overrides()

        def put(section: str, key: str, value: str | None) -> None:
            if value is not None:
                ov[section][key] = value.strip()

        if body.cloud:
            c, old = body.cloud, ov["cloud"]
            before = (acfg.cloud_backend(ov).kind, acfg.cloud_backend(ov).base_url)
            put("cloud", "provider", c.provider)
            put("cloud", "base_url", c.baseUrl)
            put("cloud", "model", c.model)
            put("cloud", "api_key", c.apiKey)
            after = acfg.cloud_backend(ov)
            if (after.kind, after.base_url) != before and c.apiKey is None:
                # сменился адрес или провайдер, а новый ключ не введён: старый ключ не должен уйти на новый адрес
                old.pop("api_key", None)
            if after.base_url and (err := acfg.validate_url("cloud", after.base_url)):
                raise HTTPException(422, err)
        if body.local:
            put("local", "url", body.local.url)
            put("local", "model", body.local.model)
            if ov["local"].get("url") and (err := acfg.validate_url("local", ov["local"]["url"])):
                raise HTTPException(422, err)
        if body.agent:
            a = body.agent
            before_url = acfg.agent_backend(ov).base_url
            put("agent", "url", a.url)
            put("agent", "token", a.token)
            put("agent", "model", a.model)
            if acfg.agent_backend(ov).base_url != before_url and a.token is None:
                ov["agent"].pop("token", None)
            if ov["agent"].get("url") and (err := acfg.validate_url("agent", ov["agent"]["url"])):
                raise HTTPException(422, err)
        with store.tx(conn):
            acfg.save_overrides(conn, ov)
        return acfg.public_view(conn)

    @app.post("/api/assistant/test")
    async def assistant_test(body: TestIn, dev: sqlite3.Row = Depends(auth)):
        """Проверка подключения: достучаться до провайдера и получить список моделей (токены не тратятся)."""
        if too_many("test:" + dev["id"], 15):
            raise HTTPException(429, "Слишком много проверок, подожди минуту")
        be = acfg.get_backend(body.backend, overrides())
        if not be.base_url:
            return {"ok": False, "models": [], "message": be.hint}
        ok, models, message = await probe(be)
        return {"ok": ok, "models": models, "message": message}

    @app.get("/api/assistant/status")
    async def assistant_status(dev: sqlite3.Row = Depends(auth)):
        ov = overrides()
        cloud, local, agent = acfg.cloud_backend(ov), acfg.local_backend(ov), acfg.agent_backend(ov)
        local_ok, local_model = False, local.model
        agent_ok = False
        factory = app.state.client_factory or providers.make_client
        async with factory() as client:
            try:
                root = local.base_url[:-3] if local.base_url.endswith("/v1") else local.base_url
                r = await client.get(f"{root}/api/tags", timeout=1.5)
                local_ok = r.status_code == 200
                if local_ok and not local_model:
                    models = r.json().get("models", [])
                    local_model = models[0]["name"] if models else ""
            except Exception:
                local_ok = False
            if agent.base_url:
                try:
                    await providers.list_models(client, agent, 1.5)
                    agent_ok = True
                except Exception:
                    agent_ok = False
        return {
            "cloud": {"configured": cloud.configured, "model": cloud.model if cloud.configured else ""},
            "local": {"reachable": local_ok, "model": local_model},
            "agent": {"configured": bool(agent.base_url), "reachable": agent_ok, "model": agent.model},
        }

    @app.post("/api/assistant/chat")
    async def assistant_chat(body: ChatIn, dev: sqlite3.Row = Depends(auth)):
        if too_many("chat:" + dev["id"], 20):
            raise HTTPException(429, "Слишком много вопросов подряд, подожди минуту")
        if sum(len(m.content) for m in body.messages) > MAX_CHAT_CHARS:
            raise HTTPException(413, "Слишком длинная переписка: начни новый диалог")
        be = acfg.get_backend(body.backend, overrides())
        if not be.configured:
            raise HTTPException(503, be.hint)
        try:
            today = datetime.strptime(body.today, "%Y-%m-%d").strftime("%Y-%m-%d")
        except ValueError:
            today = datetime.now().strftime("%Y-%m-%d")

        async def events():
            if chat_slots.locked():
                yield f"data: {json.dumps({'type': 'error', 'message': 'Ассистент занят другими запросами, попробуй через минуту'}, ensure_ascii=False)}\n\n"
                return
            try:
                async with chat_slots:
                    async for ev in agent.run_chat(conn, be, [m.model_dump() for m in body.messages], today, app.state.client_factory):
                        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            except Exception as e:  # поток уже начался: ошибку отдаём событием
                yield f"data: {json.dumps({'type': 'error', 'message': f'Внутренняя ошибка: {e.__class__.__name__}'}, ensure_ascii=False)}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ---------- раздача клиента ----------
    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404)
        if not DIST_DIR.exists():
            return JSONResponse({"error": "Клиент не собран: выполни npm run build"}, status_code=503)
        try:
            target = (DIST_DIR / path).resolve()
            ok = bool(path) and target.is_file() and DIST_DIR.resolve() in target.parents
        except (ValueError, OSError):  # нулевой байт, слишком длинное имя и т.п.
            ok = False
        f = target if ok else DIST_DIR / "index.html"
        headers = {}
        # Service Worker и точка входа не должны залипать в кэше
        if f.name in {"sw.js", "index.html", "manifest.webmanifest"} or f.name.startswith("workbox-"):
            headers["Cache-Control"] = "no-cache"
        elif "assets" in f.parts:
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return FileResponse(f, headers=headers)

    return app


# ---------- резервные копии ----------

def backup_once(conn: sqlite3.Connection, data_dir: Path) -> Path:
    bdir = data_dir / "backups"
    bdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    dest = bdir / f"workout-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    out = sqlite3.connect(dest)
    try:
        conn.backup(out)
    finally:
        out.close()
    os.chmod(dest, 0o600)
    files = sorted(bdir.glob("workout-*.db"))
    for old in files[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)
    return dest


async def _backup_loop(conn: sqlite3.Connection):
    while True:
        try:
            await asyncio.to_thread(backup_once, conn, store.DATA_DIR)  # не блокируем цикл событий
        except Exception as e:  # резервная копия не должна ронять сервер
            print("backup failed:", e)
        await asyncio.sleep(24 * 3600)


app = make_app()
