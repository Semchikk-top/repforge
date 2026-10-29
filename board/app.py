"""HTTP-интерфейс мирового рейтинга.

Принцип: доступа по паролям и токенам нет. Участник доказывает личность подписью своего ключа (тем же, которым
подписываются итоги для друзей), а таблицу читать может любой. Сервис хранит агрегаты за период, ник и открытый ключ.
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import timedelta
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import VERSION
from .canon import key_is_valid, profile_id_for, verify_object
from .ratelimit import Limiter
from .rules import (KINDS, MAX_AGE_MS, MAX_FUTURE_MS, SEED, Reject, check_plausible, classify_period, clean_nick,
                    resolve_period, today_utc, validate_snapshot)
from .store import Store

MAX_BODY = 200 * 1024
STATUS = {"malformed": 400, "bad-period": 400, "bad-nick": 400, "bad-key": 400, "bad-signature": 400, "bad-time": 400,
          "implausible": 422, "inconsistent": 422, "period-not-current": 422, "bad-query": 400, "bad-reason": 400,
          "replay": 409, "stale": 409, "not-joined": 403, "banned": 403, "rate-limit": 429, "too-big": 413,
          "full": 503, "not-found": 404, "self": 400, "bad-type": 415}

# метрика -> (откуда, колонка значения, колонка для равенства)
METRICS = {
    "volume": ("s", "volume_kg", "work_sets"), "sets": ("s", "work_sets", "volume_kg"),
    "workouts": ("s", "workouts", "work_sets"), "cardio": ("s", "cardio_km", "cardio_sessions"),
    "e1rm": ("e", "e1rm", "sets"), "exvolume": ("e", "volume", "sets"), "exsets": ("e", "sets", "volume"),
}
REASONS = {"name", "cheat", "other"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def create_app(store: Store | None = None, clock=None, limiter: Limiter | None = None) -> FastAPI:
    app = FastAPI(title="Board", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    st = store or Store()
    now_ms = clock or (lambda: int(time.time() * 1000))
    lim = limiter or Limiter()
    trust_proxy = os.environ.get("BOARD_TRUST_PROXY") == "1"
    autohide = _env_int("BOARD_AUTOHIDE", 5)
    reporter_min_age_ms = _env_int("BOARD_REPORTER_MIN_AGE_H", 24) * 3_600_000
    max_profiles = _env_int("BOARD_MAX_PROFILES", 200_000)
    join_per_ip = _env_int("BOARD_JOIN_PER_IP_HOUR", 20)
    new_per_ip = _env_int("BOARD_NEW_PROFILES_PER_IP_DAY", 5)
    cache: dict[tuple, tuple[float, dict]] = {}
    app.state.store, app.state.cache_ttl = st, 15.0

    origins = [o.strip() for o in os.environ.get("BOARD_ORIGINS", "").split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware, allow_origins=origins,
        allow_origin_regex=None if os.environ.get("BOARD_ALLOW_LOCALHOST") == "0" else r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["GET", "POST"], allow_headers=["Content-Type"], max_age=600)

    @app.middleware("http")
    async def headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        if request.method != "GET":
            resp.headers["Cache-Control"] = "no-store"
        return resp

    def fail(code: str, **extra) -> JSONResponse:
        return JSONResponse({"error": code, **extra}, status_code=STATUS.get(code, 400))

    def ip_of(request: Request) -> str:
        if trust_proxy:
            h = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            if h:
                return h[:64]
        return request.client.host if request.client else "?"

    async def read_json(request: Request) -> Any:
        if not request.headers.get("content-type", "").lower().startswith("application/json"):
            raise Reject("bad-type")
        try:
            if int(request.headers.get("content-length", "0")) > MAX_BODY:
                raise Reject("too-big")
        except ValueError:
            raise Reject("malformed")
        buf = b""
        async for chunk in request.stream():
            buf += chunk
            if len(buf) > MAX_BODY:
                raise Reject("too-big")
        try:
            return json.loads(buf.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise Reject("malformed")

    def envelope(msg: Any, kind: str) -> dict:
        """Подписанное сообщение участника: форма, ключ, свежесть, подпись, защита от повтора."""
        if not isinstance(msg, dict) or msg.get("v") != 1 or msg.get("kind") != kind:
            raise Reject("malformed")
        pk, pid, gen, nonce = msg.get("publicKey"), msg.get("profileId"), msg.get("generatedAt"), msg.get("nonce")
        if not isinstance(pk, str) or not key_is_valid(pk) or pid != profile_id_for(pk):
            raise Reject("bad-key")
        if isinstance(gen, bool) or not isinstance(gen, (int, float)) or not isinstance(nonce, str) or not 8 <= len(nonce) <= 64:
            raise Reject("malformed")
        now = now_ms()
        if gen > now + MAX_FUTURE_MS or gen < now - MAX_AGE_MS:
            raise Reject("bad-time")
        if not verify_object(pk, msg):
            raise Reject("bad-signature")
        if not st.remember_nonce(f"{pid}|{nonce}", now):
            raise Reject("replay")
        return msg

    def member(pid: str):
        row = st.one("SELECT * FROM profiles WHERE profile_id=?", (pid,))
        if not row:
            raise Reject("not-joined")
        if row["status"] == "banned":
            raise Reject("banned")
        return row

    @app.get("/v1/health")
    def health():
        return {"ok": True, "version": VERSION}

    @app.post("/v1/join")
    async def join(request: Request):
        try:
            ip = ip_of(request)
            if not lim.allow("join-ip", ip, join_per_ip, 3600):
                raise Reject("rate-limit")
            msg = envelope(await read_json(request), "join")
            nick = clean_nick(msg.get("nick"))
            pid, now = msg["profileId"], now_ms()
            if not lim.allow("join-id", pid, 10, 3600):
                raise Reject("rate-limit")
            cur = st.one("SELECT * FROM profiles WHERE profile_id=?", (pid,))
            if cur and cur["status"] == "banned":
                raise Reject("banned")
            if cur:
                st.run("UPDATE profiles SET nick=?, updated_at=? WHERE profile_id=?", (nick, now, pid))
            else:
                if not lim.allow("newprofile-ip", ip, new_per_ip, 86400):
                    raise Reject("rate-limit")
                if st.one("SELECT COUNT(*) n FROM profiles")["n"] >= max_profiles:
                    raise Reject("full")
                st.run("INSERT INTO profiles (profile_id, public_key, nick, created_at, updated_at) VALUES (?,?,?,?,?)", (pid, msg["publicKey"], nick, now, now))
            return {"ok": True, "nick": nick, "tag": pid[2:6]}
        except Reject as e:
            return fail(e.code)

    @app.post("/v1/submit")
    async def submit(request: Request):
        try:
            if not lim.allow("submit-ip", ip_of(request), 60, 3600):
                raise Reject("rate-limit")
            body = await read_json(request)
            snaps = body.get("snapshots") if isinstance(body, dict) else None
            if not isinstance(snaps, list) or not 1 <= len(snaps) <= 3:
                raise Reject("malformed")
            results, accepted = [], 0
            for raw in snaps:
                try:
                    s = validate_snapshot(raw)
                    pid = s["profile_id"]
                    if s["public_key"] is None or pid != profile_id_for(s["public_key"]):
                        raise Reject("bad-key")
                    prof = member(pid)
                    if prof["public_key"] != s["public_key"]:
                        raise Reject("bad-key")
                    now = now_ms()
                    if s["generated_at"] > now + MAX_FUTURE_MS or s["generated_at"] < now - MAX_AGE_MS:
                        raise Reject("bad-time")
                    kind = classify_period(s["from"], s["to"], now)
                    check_plausible(s, kind)
                    if not verify_object(s["public_key"], raw):
                        raise Reject("bad-signature")
                    if not lim.allow("submit-id", pid, 60, 3600):
                        raise Reject("rate-limit")
                    if not st.remember_nonce(f"{pid}|{raw['nonce']}", now):
                        raise Reject("replay")
                    with st.tx():
                        old = st.one("SELECT generated_at FROM snapshots WHERE profile_id=? AND kind=? AND period_from=?", (pid, kind, s["from"]))
                        if old and old["generated_at"] >= s["generated_at"]:
                            raise Reject("stale")
                        st.db.execute("INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                      (pid, kind, s["from"], s["to"], s["generated_at"], s["workouts"], s["work_sets"], s["volume"], s["km"], s["sec"], s["sessions"]))
                        st.db.execute("DELETE FROM ex_stats WHERE profile_id=? AND kind=? AND period_from=?", (pid, kind, s["from"]))
                        st.db.executemany("INSERT INTO ex_stats VALUES (?,?,?,?,?,?,?)",
                                          [(pid, kind, s["from"], e["key"], e["e1rm"], e["volume"], int(e["sets"])) for e in s["exercises"]])
                        keep = {"week": 60, "month": 400}.get(kind)
                        if keep:  # старые периоды не копим: рейтинг про сейчас
                            cut = (today_utc(now) - timedelta(days=keep)).isoformat()
                            st.db.execute("DELETE FROM snapshots WHERE profile_id=? AND kind=? AND period_from<?", (pid, kind, cut))
                            st.db.execute("DELETE FROM ex_stats WHERE profile_id=? AND kind=? AND period_from<?", (pid, kind, cut))
                    accepted += 1
                    results.append({"kind": kind, "ok": True})
                except Reject as e:
                    if e.code in ("rate-limit", "banned", "not-joined"):
                        raise
                    results.append({"ok": False, "reason": e.code})
            return {"accepted": accepted, "results": results}
        except Reject as e:
            return fail(e.code)

    @app.post("/v1/leave")
    async def leave(request: Request):
        try:
            if not lim.allow("leave-ip", ip_of(request), 30, 3600):
                raise Reject("rate-limit")
            msg = envelope(await read_json(request), "leave")
            pid = msg["profileId"]
            cur = st.one("SELECT * FROM profiles WHERE profile_id=?", (pid,))
            if cur:
                st.delete_profile_data(pid)
                if cur["status"] != "banned":  # бан не снимается выходом: иначе его можно обойти
                    st.run("DELETE FROM profiles WHERE profile_id=?", (pid,))
            cache.clear()
            return {"ok": True}
        except Reject as e:
            return fail(e.code)

    @app.post("/v1/report")
    async def report(request: Request):
        try:
            if not lim.allow("report-ip", ip_of(request), 60, 86400):
                raise Reject("rate-limit")
            msg = envelope(await read_json(request), "report")
            me = member(msg["profileId"])
            target, reason = msg.get("target"), msg.get("reason")
            if reason not in REASONS:
                raise Reject("bad-reason")
            if not isinstance(target, str) or not re.fullmatch(r"p_[A-Za-z0-9_-]{22}", target):
                raise Reject("malformed")
            if target == me["profile_id"]:
                raise Reject("self")
            if not st.one("SELECT 1 FROM profiles WHERE profile_id=?", (target,)):
                raise Reject("not-found")
            if not lim.allow("report-id", me["profile_id"], 30, 86400):
                raise Reject("rate-limit")
            now = now_ms()
            st.run("INSERT OR IGNORE INTO reports VALUES (?,?,?,?)", (target, me["profile_id"], reason, now))
            # автоскрытие считает только жалобы давних участников: свежие аккаунты-одноразки не могут «заглушить» соперника
            n = st.one("SELECT COUNT(*) n FROM reports r JOIN profiles p ON p.profile_id=r.reporter_id WHERE r.target_id=? AND p.created_at<=?", (target, now - reporter_min_age_ms))["n"]
            if n >= autohide:
                st.run("UPDATE profiles SET status='hidden' WHERE profile_id=? AND status='ok'", (target,))
                cache.clear()
            return {"ok": True}
        except Reject as e:
            return fail(e.code)

    @app.get("/v1/board")
    def board(request: Request, kind: str = "week", metric: str = "volume", exercise: str = "", period_from: str = "",
              limit: int = 50, offset: int = 0, me: str = ""):
        try:
            if not lim.allow("read-ip", ip_of(request), 240, 60):
                raise Reject("rate-limit")
            if kind not in KINDS or metric not in METRICS or not 1 <= limit <= 100 or not 0 <= offset <= 100_000:
                raise Reject("bad-query")
            src, col, sec = METRICS[metric]
            if src == "e" and exercise not in SEED:
                raise Reject("bad-query")
            if me and not re.fullmatch(r"p_[A-Za-z0-9_-]{22}", me):
                raise Reject("bad-query")
            now = now_ms()
            frm, to = resolve_period(kind, period_from or None, now)
            if src == "s":
                base = (f"SELECT p.profile_id pid, p.nick nick, s.{col} value, s.{sec} sec, s.generated_at at FROM snapshots s "
                        f"JOIN profiles p ON p.profile_id=s.profile_id WHERE s.kind=? AND s.period_from=? AND p.status='ok' AND s.{col}>0")
                args: tuple = (kind, frm)
            else:
                base = (f"SELECT p.profile_id pid, p.nick nick, e.{col} value, e.{sec} sec, s.generated_at at FROM ex_stats e "
                        f"JOIN snapshots s ON s.profile_id=e.profile_id AND s.kind=e.kind AND s.period_from=e.period_from "
                        f"JOIN profiles p ON p.profile_id=e.profile_id WHERE e.kind=? AND e.period_from=? AND e.ex_key=? AND p.status='ok' AND e.{col}>0")
                args = (kind, frm, exercise)
            key = (kind, frm, metric, exercise, limit, offset)
            hit = cache.get(key)
            if hit and hit[0] > time.monotonic():
                page = hit[1]
            else:
                total = st.one(f"SELECT COUNT(*) n FROM ({base})", args)["n"]
                rows = st.q(f"SELECT *, RANK() OVER (ORDER BY value DESC) rnk FROM ({base}) ORDER BY value DESC, sec DESC, at ASC, pid ASC LIMIT ? OFFSET ?", args + (limit, offset))
                page = {"total": total, "entries": [{"rank": r["rnk"], "pid": r["pid"], "nick": r["nick"], "tag": r["pid"][2:6],
                                                      "value": r["value"], "sec": r["sec"], "at": r["at"]} for r in rows]}
                cache[key] = (time.monotonic() + app.state.cache_ttl, page)
                if len(cache) > 500:
                    cache.clear()
            mine = None
            if me:
                r = st.one(f"SELECT value, sec, at, (SELECT COUNT(*) FROM ({base}) b2 WHERE b2.value > b1.value) + 1 rnk FROM ({base}) b1 WHERE pid=?", args + args + (me,))
                if r:
                    mine = {"rank": r["rnk"], "pid": me, "value": r["value"], "sec": r["sec"], "at": r["at"]}
            return JSONResponse({"period": {"kind": kind, "from": frm, "to": to}, "metric": metric, "exercise": exercise or None,
                                 "total": page["total"], "entries": page["entries"], "me": mine, "now": now},
                                headers={"Cache-Control": "public, max-age=10"})
        except Reject as e:
            return fail(e.code)

    @app.get("/v1/profile/{pid}")
    def profile(pid: str):
        """Нужен клиенту, чтобы узнать, участвует ли он и не скрыт ли: только статус, без чужих данных."""
        if not re.fullmatch(r"p_[A-Za-z0-9_-]{22}", pid):
            return fail("bad-query")
        r = st.one("SELECT nick, status FROM profiles WHERE profile_id=?", (pid,))
        return {"joined": bool(r) and r["status"] != "banned", "nick": r["nick"] if r and r["status"] != "banned" else None,
                "visible": bool(r) and r["status"] == "ok", "tag": pid[2:6]}

    return app
