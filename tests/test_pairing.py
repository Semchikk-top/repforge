import asyncio
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server import netinfo, pairing
from server.main import make_app


# ---------- определение адреса ----------

SERVE = json.dumps({"TCP": {"443": {"HTTPS": True}}, "Web": {"pc.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8000"}}}}})
STATUS = json.dumps({"BackendState": "Running", "Self": {"DNSName": "pc.tail1234.ts.net."}})


def fake_run(serve="", status=""):
    return lambda args: serve if "serve" in args else status


def test_tailscale_urls_parsing():
    assert netinfo.tailscale_urls(fake_run(serve=SERVE)) == ["https://pc.tail1234.ts.net"]
    odd = json.dumps({"Web": {"pc.tail1234.ts.net:8443": {}}})
    assert netinfo.tailscale_urls(fake_run(serve=odd)) == ["https://pc.tail1234.ts.net:8443"]
    assert netinfo.tailscale_urls(fake_run(status=STATUS)) == ["https://pc.tail1234.ts.net"]  # запасной путь
    assert netinfo.tailscale_urls(fake_run(status=json.dumps({"BackendState": "Stopped", "Self": {"DNSName": "x."}}))) == []
    assert netinfo.tailscale_urls(fake_run(serve="не json", status="")) == []


def run_detect(**kw):
    ok = kw.pop("ok", set())
    asked = []

    async def check(url):
        asked.append(url)
        return url in ok

    out = asyncio.run(netinfo.detect("inst", 8000, check=check, **kw))
    return out, asked


def test_detect_orders_dedupes_and_checks():
    cands, asked = run_detect(
        current_origin="https://pc.tail1234.ts.net", public_url="http://192.168.1.20:8000/",
        run=fake_run(serve=SERVE), lan=lambda: ["192.168.1.20"], ok={"http://192.168.1.20:8000", "https://pc.tail1234.ts.net"},
    )
    assert [(c.url, c.kind) for c in cands] == [
        ("http://192.168.1.20:8000", "configured"),  # дубль LAN-адреса убран, остался первый
        ("https://pc.tail1234.ts.net", "current"),
    ]
    assert sorted(asked) == ["http://192.168.1.20:8000", "https://pc.tail1234.ts.net"]  # каждый адрес проверен один раз
    assert [c.reachable for c in cands] == [True, True]
    assert netinfo.pick_best(cands) == 1  # HTTPS важнее


def test_loopback_origin_ignored_and_unreachable_flagged():
    cands, _ = run_detect(current_origin="http://127.0.0.1:8000", run=fake_run(), lan=lambda: ["10.0.0.5"])
    assert [(c.kind, c.reachable) for c in cands] == [("lan", False)]
    assert netinfo.pick_best(cands) is None


def test_pick_best_fallback_to_insecure():
    cands, _ = run_detect(run=fake_run(serve=SERVE), lan=lambda: ["10.0.0.5"], ok={"http://10.0.0.5:8000"})
    assert [c.reachable for c in cands] == [False, True]
    assert cands[netinfo.pick_best(cands)].secure is False


# ---------- запросы и подтверждение ----------

@pytest.fixture()
def env(tmp_path: Path, monkeypatch):
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    conn = app.state.conn

    def pair(device="dev-aaaaaaaa"):
        code = store.create_pair_code(conn)
        return {"Authorization": "Bearer " + client.post("/api/pair", json={"code": code, "deviceId": device, "name": "ПК"}).json()["token"]}

    return app, client, conn, pair


def test_invite_requires_auth_and_returns_working_code(env, monkeypatch):
    app, client, conn, pair = env
    monkeypatch.setattr(netinfo, "lan_ips", lambda: ["192.168.1.20"])
    monkeypatch.setattr(netinfo, "run_cmd", lambda args: SERVE if "serve" in args else "")

    async def check(url):
        return url == "https://pc.tail1234.ts.net"

    app.state.check = check
    assert client.post("/api/pairing/invite").status_code == 401
    h = pair()
    r = client.post("/api/pairing/invite", headers=h)
    assert r.status_code == 200
    body = r.json()
    # TestClient ходит на «http://localhost»: адрес loopback телефону не нужен, его в списке нет
    assert [(c["kind"], c["reachable"]) for c in body["candidates"]] == [("tailscale", True), ("lan", False)]
    best = body["candidates"][body["best"]]
    assert best["url"] == "https://pc.tail1234.ts.net" and best["secure"] is True
    assert best["link"] == f"https://pc.tail1234.ts.net/#/pair/{body['code']}"
    assert best["qr"].startswith("<?xml") and "<svg" in best["qr"]
    assert body["candidates"][1]["qr"] is None  # у недостижимого адреса QR не рисуем
    # код из приглашения действительно подключает устройство, и только один раз
    ok = client.post("/api/pair", json={"code": body["code"], "deviceId": "phone-12345678", "name": "Телефон"})
    assert ok.status_code == 200
    assert client.post("/api/pair", json={"code": body["code"], "deviceId": "phone-87654321"}).status_code == 403


def test_invite_uses_forwarded_origin(env, monkeypatch):
    app, client, conn, pair = env
    monkeypatch.setattr(netinfo, "lan_ips", lambda: [])
    monkeypatch.setattr(netinfo, "run_cmd", lambda args: "")

    async def check(url):
        return url == "https://my.host.ts.net"

    app.state.check = check
    h = pair()
    r = client.post("/api/pairing/invite", headers={**h, "X-Forwarded-Proto": "https", "X-Forwarded-Host": "my.host.ts.net"}).json()
    assert r["candidates"][r["best"]]["url"] == "https://my.host.ts.net"
    assert r["candidates"][r["best"]]["kind"] == "current"


def request_pairing(client, device="phone-12345678", name="Телефон (Android)"):
    r = client.post("/api/pairing/request", json={"deviceId": device, "name": name})
    assert r.status_code == 200, r.text
    return r.json()


def test_request_approve_flow(env):
    _, client, _, pair = env
    h = pair()
    req = request_pairing(client)
    assert re.fullmatch(r"\d{4}", req["pin"])
    assert client.get(f"/api/pairing/request/{req['requestId']}").json() == {"status": "pending"}
    # список ожидающих виден только подключённым устройствам и содержит PIN для сверки
    assert client.get("/api/pairing/pending").status_code == 401
    pend = client.get("/api/pairing/pending", headers=h).json()
    assert pend[0]["name"] == "Телефон (Android)" and pend[0]["pin"] == req["pin"]
    assert client.post(f"/api/pairing/pending/{pend[0]['id']}", json={"approve": True}).status_code == 401
    assert client.post(f"/api/pairing/pending/{pend[0]['id']}", json={"approve": True}, headers=h).status_code == 200
    got = client.get(f"/api/pairing/request/{req['requestId']}").json()
    assert got["status"] == "approved" and len(got["code"]) == 8
    # код отдаётся один раз
    assert client.get(f"/api/pairing/request/{req['requestId']}").json() == {"status": "done"}
    assert client.post("/api/pair", json={"code": got["code"], "deviceId": "phone-12345678", "name": "Телефон"}).status_code == 200
    assert client.get("/api/pairing/pending", headers=h).json() == []
    # повторное решение по обработанному запросу
    assert client.post(f"/api/pairing/pending/{pend[0]['id']}", json={"approve": True}, headers=h).status_code == 404


def test_deny_cancel_and_no_code_leak(env):
    _, client, _, pair = env
    h = pair()
    req = request_pairing(client)
    rid = client.get("/api/pairing/pending", headers=h).json()[0]["id"]
    assert client.post(f"/api/pairing/pending/{rid}", json={"approve": False}, headers=h).status_code == 200
    assert client.get(f"/api/pairing/request/{req['requestId']}").json() == {"status": "denied"}
    # отмена убирает запрос из очереди
    req2 = request_pairing(client, "phone-22222222")
    client.delete(f"/api/pairing/request/{req2['requestId']}")
    assert client.get("/api/pairing/pending", headers=h).json() == []
    assert client.get("/api/pairing/request/unknown").json() == {"status": "expired"}


def test_request_expiry(env, monkeypatch):
    _, client, _, pair = env
    h = pair()
    t = {"now": 1_000_000.0}
    monkeypatch.setattr(pairing, "now", lambda: t["now"])
    req = request_pairing(client)
    t["now"] += pairing.REQUEST_TTL + 1
    assert client.get(f"/api/pairing/request/{req['requestId']}").json() == {"status": "expired"}
    assert client.get("/api/pairing/pending", headers=h).json() == []


def test_limits_and_name_sanitizing(env):
    _, client, _, pair = env
    pair()
    for i in range(pairing.MAX_PENDING):
        request_pairing(client, f"phone-{i:08d}")
    assert client.post("/api/pairing/request", json={"deviceId": "phone-99999999", "name": "x"}).status_code == 429
    assert client.post("/api/pairing/request", json={"deviceId": "short", "name": "x"}).status_code == 422
    assert pairing.clean_name("<b>Ванин\x00 телефон</b>") == "bВанин телефон/b"
    assert pairing.clean_name("") == "Устройство"


def test_same_phone_replaces_its_pending_request(env):
    _, client, _, pair = env
    h = pair()
    request_pairing(client, "phone-12345678", "Старый")
    request_pairing(client, "phone-12345678", "Новый")
    pend = client.get("/api/pairing/pending", headers=h).json()
    assert [p["name"] for p in pend] == ["Новый"]


def test_invite_codes_are_capped(env):
    _, client, conn, pair = env
    for _ in range(30):
        store.create_pair_code(conn)
    assert conn.execute("SELECT COUNT(*) FROM pair_codes").fetchone()[0] <= 20


def test_health_reports_stable_instance(env):
    _, client, conn, _ = env
    a = client.get("/api/health").json()["instance"]
    assert a == client.get("/api/health").json()["instance"] == store.instance_id(conn) and len(a) == 16
