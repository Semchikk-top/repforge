"""Сервис мирового рейтинга: приём подписанных итогов, защита от накрутки, модерация, таблицы."""
import base64
import json
import os
import secrets
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives import hashes, serialization
from fastapi.testclient import TestClient

from board import admin, rules
from board.app import create_app
from board.canon import b64u_encode, canonical_json, profile_id_for
from board.ratelimit import Limiter
from board.store import Store

FIX = json.loads((Path(__file__).parent / "fixtures" / "board_fixture.json").read_text(encoding="utf-8"))
NOW = FIX["now"]  # 2026-10-27 12:00 UTC: вторник
H = {"Content-Type": "application/json"}


class Ident:
    """Участник, подписывающий так же, как клиент (src/social/world.ts)."""

    def __init__(self, alg="ed25519"):
        self.alg = alg
        if alg == "ed25519":
            self.key = Ed25519PrivateKey.generate()
            raw = self.key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        else:
            self.key = ec.generate_private_key(ec.SECP256R1())
            raw = self.key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        self.public_key = f"{alg}:{b64u_encode(raw)}"
        self.pid = profile_id_for(self.public_key)

    def sign(self, obj):
        data = canonical_json(obj).encode()
        if self.alg == "ed25519":
            sig = self.key.sign(data)
        else:
            r, s = decode_dss_signature(self.key.sign(data, ec.ECDSA(hashes.SHA256())))
            sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")  # как WebCrypto: r||s
        return b64u_encode(sig)

    def msg(self, kind, now, **fields):
        body = {"v": 1, "kind": kind, "profileId": self.pid, "publicKey": self.public_key, "generatedAt": now, "nonce": secrets.token_hex(8), **fields}
        return {**body, "sig": self.sign(body)}

    def snap(self, now, kind="week", **o):
        period = {"week": ("2026-10-26", "2026-11-01"), "month": ("2026-10-01", "2026-10-31"), "all": ("1970-01-01", "2026-10-27")}[kind]
        if "period" in o:
            period = o.pop("period")
        body = {
            "v": 1, "profileId": self.pid, "displayName": "x", "publicKey": self.public_key,
            "period": {"from": period[0], "to": period[1], "tz": "UTC"}, "generatedAt": now, "nonce": secrets.token_hex(8),
            "totals": {"workouts": 3, "workSets": 12, "volumeKg": 5000},
            "exercises": [{"key": "seed-001", "name": "чужое имя", "muscle": "chest", "e1rmKg": 120, "volumeKg": 2000, "workSets": 5}],
            "cardio": {"distanceKm": 0, "movingSec": 0, "sessions": 0},
        }
        body.update(o)
        return {**body, "sig": self.sign(body)}


class Env:
    def __init__(self, tmp_path):
        self.now = NOW
        self.store = Store(":memory:")
        self.app = create_app(self.store, clock=lambda: self.now, limiter=Limiter())
        self.app.state.cache_ttl = 0
        self.c = TestClient(self.app)

    def post(self, path, body):
        return self.c.post(path, content=json.dumps(body), headers=H)

    def join(self, who, nick="Атлет"):
        r = self.post("/v1/join", who.msg("join", self.now, nick=nick))
        assert r.status_code == 200, r.text
        return r

    def submit(self, *snaps):
        return self.post("/v1/submit", {"snapshots": list(snaps)})

    def board(self, **q):
        q = {"kind": "week", "metric": "volume", **q}
        return self.c.get("/v1/board", params=q)


@pytest.fixture
def env(tmp_path, monkeypatch):
    # тесты заводят много участников с одного «адреса»: лимиты на вступление здесь снимаем, их проверяет отдельный тест
    monkeypatch.setenv("BOARD_JOIN_PER_IP_HOUR", "10000")
    monkeypatch.setenv("BOARD_NEW_PROFILES_PER_IP_DAY", "10000")
    return Env(tmp_path)


# ---------- совместимость с настоящим клиентом ----------
@pytest.mark.parametrize("who", ["ed", "p256"])
def test_client_messages_are_accepted(env, who):
    f = FIX[who]
    r = env.post("/v1/join", f["join"])
    assert r.status_code == 200 and r.json()["nick"] == "Саша Иванов"
    res = env.submit(*f["snapshots"]).json()
    assert res["accepted"] == 3, res
    assert [x["kind"] for x in res["results"]] == ["week", "month", "all"]
    top = env.board().json()["entries"][0]
    assert top["pid"] == f["profileId"] and top["value"] == 3120 and top["rank"] == 1
    assert env.board(kind="month").json()["entries"][0]["value"] == 4400
    assert env.board(metric="cardio").json()["entries"][0]["value"] == 5


def test_client_leave_and_report_envelopes(env):
    env.post("/v1/join", FIX["ed"]["join"])
    env.post("/v1/join", FIX["p256"]["join"])
    assert env.post("/v1/report", FIX["report"]).status_code == 200
    assert env.post("/v1/leave", FIX["ed"]["leave"]).status_code == 200
    assert env.c.get(f"/v1/profile/{FIX['ed']['profileId']}").json()["joined"] is False


def test_seed_catalog_matches_client():
    seed = json.loads((Path(__file__).parent.parent / "board" / "seed_exercises.json").read_text(encoding="utf-8"))
    assert "seed-001" in seed and all(k.startswith("seed-") for k in seed)


def test_canonical_json_matches_js_rules():
    assert canonical_json({"b": 1.0, "a": [True, None, "ё\n\"x\""], "c": 0.5}) == '{"a":[true,null,"ё\\n\\"x\\""],"b":1,"c":0.5}'


# ---------- вступление и ники ----------
def test_join_requires_valid_signature_and_key(env):
    a = Ident()
    m = a.msg("join", env.now, nick="Тест")
    m["nick"] = "Подмена"
    assert env.post("/v1/join", m).json()["error"] == "bad-signature"
    other = Ident()
    m2 = a.msg("join", env.now, nick="Тест")
    m2["profileId"] = other.pid  # чужой profileId с моим ключом
    assert env.post("/v1/join", m2).json()["error"] == "bad-key"


def test_join_rejects_stale_and_replayed(env):
    a = Ident()
    assert env.post("/v1/join", a.msg("join", env.now - 11 * 60_000, nick="Тест")).json()["error"] == "bad-time"
    m = a.msg("join", env.now, nick="Тест")
    assert env.post("/v1/join", m).status_code == 200
    assert env.post("/v1/join", m).json()["error"] == "replay"


@pytest.mark.parametrize("nick", ["a", "x" * 25, "12345", "заходи на t.me/kanal", "http://x.ru", "Админ", "adm1n", "ник\u202eскрыт", "<b>z</b>", "a\x00b", ""])
def test_bad_nicks(env, nick):
    r = env.post("/v1/join", Ident().msg("join", env.now, nick=nick))
    assert r.status_code == 400 and r.json()["error"] == "bad-nick"


def test_blocklist_from_file(env, tmp_path, monkeypatch):
    f = tmp_path / "bl.txt"
    f.write_text("# комментарий\nплохоеслово\n", encoding="utf-8")
    monkeypatch.setenv("BOARD_BLOCKLIST", str(f))
    rules.reset_blocklist()
    try:
        assert env.post("/v1/join", Ident().msg("join", env.now, nick="ПлОхОе Слово")).json()["error"] == "bad-nick"
        assert env.post("/v1/join", Ident().msg("join", env.now, nick="Хорошее имя")).status_code == 200
    finally:
        rules.reset_blocklist()


def test_rename_keeps_identity(env):
    a = Ident()
    env.join(a, "Первый")
    env.join(a, "Второй")
    assert env.store.one("SELECT COUNT(*) n FROM profiles")["n"] == 1
    assert env.store.one("SELECT nick FROM profiles")["nick"] == "Второй"


# ---------- приём итогов ----------
def test_submit_needs_membership(env):
    a = Ident()
    assert env.submit(a.snap(env.now)).json()["error"] == "not-joined"


def test_tampered_snapshot_rejected(env):
    a = Ident(); env.join(a)
    s = a.snap(env.now)
    s["totals"]["volumeKg"] = 5500  # правдоподобная подмена: значит, остановить её должна подпись
    res = env.submit(s).json()
    assert res["accepted"] == 0 and res["results"][0]["reason"] == "bad-signature"


def test_snapshot_signed_by_other_key_rejected(env):
    a, b = Ident(), Ident()
    env.join(a)
    s = b.snap(env.now)
    s["profileId"], s["publicKey"] = a.pid, a.public_key  # выдаю чужие итоги за свои, подпись не моя
    assert env.submit(s).json()["results"][0]["reason"] == "bad-signature"


def test_replay_and_stale(env):
    a = Ident(); env.join(a)
    new = a.snap(env.now + 60_000)
    old = a.snap(env.now)
    assert env.submit(new).json()["accepted"] == 1
    assert env.submit(new).json()["results"][0]["reason"] == "replay"
    assert env.submit(old).json()["results"][0]["reason"] == "stale"
    assert env.board().json()["entries"][0]["value"] == 5000


def test_newer_snapshot_replaces(env):
    a = Ident(); env.join(a)
    env.submit(a.snap(env.now))
    env.submit(a.snap(env.now + 5000, totals={"workouts": 4, "workSets": 14, "volumeKg": 6500}))
    e = env.board().json()
    assert e["total"] == 1 and e["entries"][0]["value"] == 6500


def test_snapshot_must_be_fresh(env):
    a = Ident(); env.join(a)
    assert env.submit(a.snap(env.now - 11 * 60_000)).json()["results"][0]["reason"] == "bad-time"
    assert env.submit(a.snap(env.now + 11 * 60_000)).json()["results"][0]["reason"] == "bad-time"


@pytest.mark.parametrize("period", [("2026-10-27", "2026-11-02"), ("2026-10-26", "2026-11-02"), ("2026-10-01", "2026-10-30"), ("2026-09-28", "2026-10-25"),
                                    ("2026-10-26", "2026-10-25"), ("nope", "nope")])
def test_bad_periods(env, period):
    a = Ident(); env.join(a)
    assert env.submit(a.snap(env.now, period=period)).json()["results"][0]["reason"] in ("bad-period", "malformed")


def test_old_period_not_current(env):
    a = Ident(); env.join(a)
    r = env.submit(a.snap(env.now, period=("2026-08-03", "2026-08-09"))).json()
    assert r["results"][0]["reason"] == "period-not-current"


@pytest.mark.parametrize("over", [
    {"totals": {"workouts": 3, "workSets": 12, "volumeKg": 9_000_000}},               # тоннаж вне разумного
    {"totals": {"workouts": 3, "workSets": 5000, "volumeKg": 1000}},                 # подходов больше, чем часов
    {"totals": {"workouts": 40, "workSets": 12, "volumeKg": 1000}},                  # тренировок больше 4 в день
    {"totals": {"workouts": 1, "workSets": 2, "volumeKg": 100_000}},                 # 50 тонн на подход
    {"cardio": {"distanceKm": 100, "movingSec": 3600, "sessions": 1}},               # 100 км/ч
    {"cardio": {"distanceKm": 50, "movingSec": 0, "sessions": 1}},                   # километры без времени
    {"cardio": {"distanceKm": 10, "movingSec": 3600, "sessions": 0}},                # километры без занятий
    {"exercises": [{"key": "seed-001", "name": "x", "muscle": "chest", "e1rmKg": 2000, "volumeKg": 100, "workSets": 2}]},  # 1ПМ 2 тонны
    {"exercises": [{"key": "seed-001", "name": "x", "muscle": "chest", "e1rmKg": 100, "volumeKg": 9999, "workSets": 5}]},  # объём упражнения больше общего
    {"exercises": [{"key": "seed-001", "name": "x", "muscle": "chest", "e1rmKg": 100, "volumeKg": 100, "workSets": 40}]},   # подходов в упражнении больше общего
    {"exercises": [{"key": "seed-001", "name": "x", "muscle": "chest", "e1rmKg": 100, "volumeKg": 100, "workSets": 1}] * 2},  # дубли
])
def test_impossible_numbers_rejected(env, over):
    a = Ident(); env.join(a)
    res = env.submit(a.snap(env.now, **over)).json()
    assert res["accepted"] == 0 and res["results"][0]["reason"] in ("implausible", "inconsistent"), res


def test_world_ignores_custom_exercises_and_uses_catalog_names(env):
    a = Ident(); env.join(a)
    ex = [{"key": "seed-001", "name": "ПОДДЕЛКА", "muscle": "chest", "e1rmKg": 100, "volumeKg": 500, "workSets": 3},
          {"key": "c:моё упражнение|chest|", "name": "Моё", "muscle": "chest", "e1rmKg": 100, "volumeKg": 500, "workSets": 3}]
    assert env.submit(a.snap(env.now, exercises=ex)).json()["accepted"] == 1
    assert env.store.one("SELECT COUNT(*) n FROM ex_stats")["n"] == 1
    assert env.board(metric="e1rm", exercise="seed-001").json()["entries"][0]["value"] == 100
    assert env.board(metric="e1rm", exercise="c:моё упражнение|chest|").status_code == 400


def test_snapshot_display_name_is_never_shown(env):
    a = Ident(); env.join(a, "Публичный ник")
    env.submit(a.snap(env.now, displayName="Настоящее Имя Фамилия"))
    assert env.board().json()["entries"][0]["nick"] == "Публичный ник"
    assert "Настоящее" not in json.dumps(env.board().json(), ensure_ascii=False)


# ---------- таблицы ----------
def fill(env, values):
    ids = []
    for i, v in enumerate(values):
        a = Ident(); env.join(a, f"Игрок {i + 1}")
        sets = max(1, int(v // 400)) if v else 1
        env.submit(a.snap(env.now, totals={"workouts": 2, "workSets": sets, "volumeKg": v}, exercises=[]))
        ids.append(a)
    return ids


def test_ranking_ties_and_order(env):
    fill(env, [3000, 5000, 5000, 1000, 4000])
    es = env.board().json()["entries"]
    assert [e["value"] for e in es] == [5000, 5000, 4000, 3000, 1000]
    assert [e["rank"] for e in es] == [1, 1, 3, 4, 5]  # равные результаты делят место


def test_pagination_total_and_me(env):
    people = fill(env, [100 * (i + 1) for i in range(12)])
    r = env.board(limit=5, offset=0, me=people[0].pid).json()
    assert r["total"] == 12 and len(r["entries"]) == 5 and r["entries"][0]["value"] == 1200
    assert r["me"]["rank"] == 12 and r["me"]["value"] == 100
    r2 = env.board(limit=5, offset=10).json()
    assert [e["rank"] for e in r2["entries"]] == [11, 12]
    assert env.board(me="p_" + "A" * 22).json()["me"] is None


def test_metrics_and_exercise_boards(env):
    a, b = Ident(), Ident()
    env.join(a, "Первый"); env.join(b, "Второй")
    env.submit(a.snap(env.now, exercises=[{"key": "seed-001", "name": "x", "muscle": "chest", "e1rmKg": 140, "volumeKg": 1000, "workSets": 4}],
                      cardio={"distanceKm": 12, "movingSec": 4000, "sessions": 2}))
    env.submit(b.snap(env.now, totals={"workouts": 5, "workSets": 30, "volumeKg": 3000},
                      exercises=[{"key": "seed-001", "name": "x", "muscle": "chest", "e1rmKg": 100, "volumeKg": 1500, "workSets": 6}]))
    top = lambda **q: env.board(**q).json()["entries"][0]["nick"]
    assert top(metric="volume") == "Первый" and top(metric="sets") == "Второй" and top(metric="workouts") == "Второй"
    assert top(metric="cardio") == "Первый" and env.board(metric="cardio").json()["total"] == 1
    assert top(metric="e1rm", exercise="seed-001") == "Первый"
    assert top(metric="exvolume", exercise="seed-001") == "Второй"
    assert top(metric="exsets", exercise="seed-001") == "Второй"


def test_bad_queries(env):
    assert env.board(kind="year").status_code == 400
    assert env.board(metric="drop table").status_code == 400
    assert env.board(metric="e1rm").status_code == 400            # без упражнения
    assert env.board(limit=500).status_code == 400
    assert env.board(period_from="2026-10-27").status_code == 400  # не понедельник
    assert env.board(kind="month", period_from="2026-10-02").status_code == 400
    assert env.board(kind="week", period_from="2026-10-19").status_code == 200


def test_other_weeks_are_separate(env):
    a = Ident(); env.join(a)
    env.submit(a.snap(env.now))
    assert env.board().json()["total"] == 1
    assert env.board(period_from="2026-10-19").json()["total"] == 0


def test_all_time_board(env):
    a = Ident(); env.join(a)
    env.submit(a.snap(env.now, kind="all", totals={"workouts": 400, "workSets": 8000, "volumeKg": 3_000_000}))
    assert env.board(kind="all").json()["entries"][0]["value"] == 3_000_000


# ---------- выход, жалобы, модерация ----------
def test_leave_erases_everything_and_cannot_be_replayed(env):
    a = Ident(); env.join(a)
    env.submit(a.snap(env.now), a.snap(env.now, kind="month"))
    m = a.msg("leave", env.now)
    assert env.post("/v1/leave", m).json() == {"ok": True}
    assert env.post("/v1/leave", m).json()["error"] == "replay"
    assert env.store.one("SELECT COUNT(*) n FROM snapshots")["n"] == 0 and env.store.one("SELECT COUNT(*) n FROM ex_stats")["n"] == 0
    assert env.store.one("SELECT COUNT(*) n FROM profiles")["n"] == 0
    assert env.board().json()["total"] == 0


def test_cannot_leave_for_someone_else(env):
    a, b = Ident(), Ident()
    env.join(a)
    forged = b.msg("leave", env.now)
    forged["profileId"], forged["publicKey"] = a.pid, a.public_key
    assert env.post("/v1/leave", forged).json()["error"] == "bad-signature"
    assert env.store.one("SELECT COUNT(*) n FROM profiles")["n"] == 1


def test_reports_from_new_accounts_do_not_hide(env):
    target = Ident(); env.join(target, "Нарушитель")
    env.submit(target.snap(env.now))
    for i in range(6):  # свежие аккаунты-одноразки: жалобы записываются для модератора, но таблицу не меняют
        r = Ident(); env.join(r, f"Новичок {i}")
        assert env.post("/v1/report", r.msg("report", env.now, target=target.pid, reason="cheat")).status_code == 200
    assert env.store.one("SELECT COUNT(*) n FROM reports")["n"] == 6
    assert env.store.one("SELECT status FROM profiles WHERE profile_id=?", (target.pid,))["status"] == "ok"
    assert env.board().json()["total"] == 1
    assert admin.reports(env.store)[0]["n"] == 6


def test_same_reporter_counts_once(env):
    target = Ident(); env.join(target, "Нарушитель")
    r = Ident(); env.join(r, "Давний")
    env.now += 2 * 86_400_000
    for _ in range(4):
        assert env.post("/v1/report", r.msg("report", env.now, target=target.pid, reason="cheat")).status_code == 200
    assert env.store.one("SELECT COUNT(*) n FROM reports")["n"] == 1


def test_autohide_threshold(env):
    target = Ident(); env.join(target, "Нарушитель")
    env.submit(target.snap(env.now))
    crowd = []
    for i in range(5):
        r = Ident(); env.join(r, f"Давний {i}"); crowd.append(r)
    env.now += 2 * 86_400_000
    for r in crowd[:4]:
        env.post("/v1/report", r.msg("report", env.now, target=target.pid, reason="cheat"))
    env.submit(target.snap(env.now))
    assert env.board().json()["total"] == 1
    env.post("/v1/report", crowd[4].msg("report", env.now, target=target.pid, reason="cheat"))
    assert env.store.one("SELECT status FROM profiles WHERE profile_id=?", (target.pid,))["status"] == "hidden"
    assert env.board().json()["total"] == 0
    assert env.c.get(f"/v1/profile/{target.pid}").json()["visible"] is False
    admin.set_status(env.store, target.pid, "ok")
    env.submit(target.snap(env.now + 1000))
    assert env.board().json()["total"] == 1


def test_report_validation(env):
    a, b = Ident(), Ident()
    env.join(a); env.join(b)
    assert env.post("/v1/report", a.msg("report", env.now, target=a.pid, reason="cheat")).json()["error"] == "self"
    assert env.post("/v1/report", a.msg("report", env.now, target=b.pid, reason="придумал")).json()["error"] == "bad-reason"
    assert env.post("/v1/report", a.msg("report", env.now, target="p_" + "Z" * 22, reason="cheat")).json()["error"] == "not-found"
    assert env.post("/v1/report", Ident().msg("report", env.now, target=b.pid, reason="cheat")).json()["error"] == "not-joined"


def test_ban_removes_data_and_blocks_return(env):
    a = Ident(); env.join(a, "Бан")
    env.submit(a.snap(env.now))
    admin.set_status(env.store, "#" + a.pid[2:8], "banned")
    assert env.board().json()["total"] == 0
    assert env.submit(a.snap(env.now + 1000)).status_code == 403
    assert env.post("/v1/join", a.msg("join", env.now, nick="Снова")).json()["error"] == "banned"
    env.post("/v1/leave", a.msg("leave", env.now))
    assert env.store.one("SELECT status FROM profiles WHERE profile_id=?", (a.pid,))["status"] == "banned"  # выходом бан не обойти


def test_admin_ambiguous_tag(env):
    a = Ident(); env.join(a)
    with pytest.raises(SystemExit):
        admin.set_status(env.store, "#zzzz", "hidden")
    assert admin.find(env.store, "Атлет")[0]["profile_id"] == a.pid


# ---------- защита сервиса ----------
def test_body_limits_and_content_type(env):
    assert env.c.post("/v1/submit", content="x" * 300_000, headers=H).status_code == 413
    assert env.c.post("/v1/submit", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
    assert env.c.post("/v1/submit", content="не json", headers=H).status_code == 400
    assert env.post("/v1/submit", {"snapshots": []}).status_code == 400
    assert env.post("/v1/submit", {"snapshots": [{}] * 4}).status_code == 400


def test_join_rate_limit_per_ip(tmp_path, monkeypatch):
    monkeypatch.delenv("BOARD_JOIN_PER_IP_HOUR", raising=False)
    monkeypatch.delenv("BOARD_NEW_PROFILES_PER_IP_DAY", raising=False)
    env = Env(tmp_path)
    codes = [env.post("/v1/join", Ident().msg("join", env.now, nick="Тест")).status_code for _ in range(22)]
    assert codes[:5] == [200] * 5 and 429 in codes
    assert env.store.one("SELECT COUNT(*) n FROM profiles")["n"] == 5  # не больше 5 новых участников в сутки с одного адреса


def test_cors(env):
    ok = env.c.options("/v1/board", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = env.c.options("/v1/board", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers
    r = env.c.get("/v1/health")
    assert r.json()["ok"] and r.headers["x-content-type-options"] == "nosniff"


def test_docs_are_disabled(env):
    assert env.c.get("/docs").status_code == 404 and env.c.get("/openapi.json").status_code == 404
