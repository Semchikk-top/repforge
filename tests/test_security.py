"""Проверки защитного слоя: Host, CSRF, размеры, заголовки, лимиты, подделка полей."""
import json
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store, netinfo, security
from server.main import make_app


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    return app, client, app.state.conn


def pair(client, conn, device_id="dev-aaaaaaaa", name="Телефон"):
    code = store.create_pair_code(conn)
    r = client.post("/api/pair", json={"code": code, "deviceId": device_id, "name": name})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def ent(id, updated, **kw):
    return {"table": "workouts", "id": id, "updatedAt": updated, "deviceId": "dev-aaaaaaaa", "deleted": False, "data": {"id": id, **kw}}


@pytest.mark.parametrize("host,ok", [
    ("localhost:8000", True), ("127.0.0.1", True), ("[::1]:8000", True), ("192.168.1.20:8000", True),
    ("100.101.102.103", True), ("pc.tail1234.ts.net", True), ("omarchy.local", True),
    ("evil.example.com", False), ("8.8.8.8", False), ("", False), ("localhost.evil.com", False),
])
def test_host_allowlist(host, ok):
    assert security.host_allowed(host) is ok


def test_rebinding_host_rejected(env):
    _, client, _ = env
    assert client.get("/api/health", headers={"Host": "evil.example.com"}).status_code == 421
    assert client.get("/api/health").status_code == 200


def test_extra_hosts_from_env(env, monkeypatch):
    _, client, _ = env
    monkeypatch.setenv("WORKOUT_ALLOWED_HOSTS", "pc.lan")
    assert client.get("/api/health", headers={"Host": "pc.lan:8000"}).status_code == 200


def test_cross_origin_post_rejected(env):
    _, client, _ = env
    body = {"deviceId": "dev-aaaaaaaa"}
    assert client.post("/api/pairing/request", json=body, headers={"Origin": "https://evil.example.com"}).status_code == 403
    assert client.post("/api/pairing/request", json=body, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/api/pairing/request", json=body, headers={"Origin": "http://localhost"}).status_code == 200


def test_non_json_post_rejected(env):
    _, client, _ = env
    r = client.post("/api/pairing/request", content='{"deviceId":"dev-aaaaaaaa"}', headers={"Content-Type": "text/plain"})
    assert r.status_code == 415


def test_body_size_limits(env):
    _, client, conn = env
    h = pair(client, conn)
    big = json.dumps({"since": 0, "entities": [], "pad": "x" * (security.MAX_BODY_SMALL + 10)})
    assert client.post("/api/pairing/request", content=big, headers={"Content-Type": "application/json"}).status_code == 413
    assert client.post("/api/sync", content=big, headers={**h, "Content-Type": "application/json"}).status_code == 200  # /api/sync имеет свой, больший лимит


def test_security_headers(env):
    _, client, _ = env
    r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["cache-control"] == "no-store"
    assert "server" not in {k.lower() for k in r.headers} or "uvicorn" not in r.headers.get("server", "")


def test_static_assets_are_gzipped(env, tmp_path, monkeypatch):
    _, client, _ = env
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<html>ok</html>")
    body = "const answer = 42;\n" * 400  # заметно больше порога 1 КБ
    (assets / "app.js").write_text(body)
    monkeypatch.setattr("server.main.DIST_DIR", dist)

    r = client.get("/assets/app.js", headers={"Accept-Encoding": "gzip"})

    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in r.headers["vary"].lower()
    assert r.text == body  # TestClient распаковывает, содержимое не испорчено


def test_spa_survives_null_byte_and_traversal(env, tmp_path, monkeypatch):
    app, client, _ = env
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>ok</html>")
    (tmp_path / "secret.txt").write_text("secret")
    monkeypatch.setattr("server.main.DIST_DIR", dist)
    assert client.get("/%00").status_code == 200
    assert "secret" not in client.get("/..%2fsecret.txt").text
    assert "secret" not in client.get("/%2e%2e/secret.txt").text


def test_invite_ignores_foreign_forwarded_host(env, monkeypatch):
    app, client, conn = env
    calls = []

    async def check(url):
        calls.append(url)
        return False

    app.state.check = check
    monkeypatch.setattr(netinfo, "lan_ips", lambda: [])
    monkeypatch.setattr(netinfo, "run_cmd", lambda args: "")
    h = pair(client, conn)
    r = client.post("/api/pairing/invite", headers={**h, "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https"})
    assert r.status_code == 200
    assert not any("evil.example.com" in u for u in calls)  # сервер не ходит по чужим адресам


def test_device_name_is_sanitized(env):
    _, client, conn = env
    pair(client, conn, name="\x1b[2JПлохо\u202egnp.exe<b>")
    name = conn.execute("SELECT name FROM devices").fetchone()["name"]
    assert "\x1b" not in name and "\u202e" not in name and "<" not in name and "Плохо" in name


def test_future_timestamp_is_clamped(env):
    _, client, conn = env
    h = pair(client, conn)
    far = int(time.time() * 1000) + 5 * 365 * 24 * 3600 * 1000
    client.post("/api/sync", headers=h, json={"since": 0, "entities": [ent("w1", far, title="x")]})
    stored = conn.execute("SELECT updated_at FROM entities WHERE id='w1'").fetchone()["updated_at"]
    assert stored < far
    # и другое устройство всё ещё может её переписать позже
    later = stored + 1000
    r = client.post("/api/sync", headers=h, json={"since": 0, "entities": [ent("w1", later, title="y")]})
    assert r.json()["accepted"] == 1


def test_bad_ids_and_oversized_entity_rejected(env):
    _, client, conn = env
    h = pair(client, conn)
    bad = ent("w1", 1)
    bad["id"] = "../../etc"
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [bad]}).status_code == 422
    huge = ent("w2", 1, blob="x" * (security_limit := 300_000))
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [huge]}).status_code == 413


def test_chat_limits(env, monkeypatch):
    _, client, conn = env
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    h = pair(client, conn)
    long_msgs = [{"role": "user", "content": "я" * 8000}] * 6
    assert client.post("/api/assistant/chat", headers=h, json={"messages": long_msgs}).status_code == 413
    codes = [client.post("/api/assistant/chat", headers=h, json={"messages": [{"role": "user", "content": "привет" * 9000}]}).status_code for _ in range(1)]
    assert codes == [422]  # одно сообщение длиннее 8000 символов


def test_chat_rate_limit_per_device(env, monkeypatch):
    _, client, conn = env
    h = pair(client, conn)
    msg = {"messages": [{"role": "user", "content": "hi"}]}
    statuses = [client.post("/api/assistant/chat", headers=h, json=msg).status_code for _ in range(22)]
    assert statuses.count(429) >= 2


def test_pending_shows_requester_ip(env):
    _, client, conn = env
    h = pair(client, conn)
    client.post("/api/pairing/request", json={"deviceId": "phone-12345678", "name": "Телефон"})
    pending = client.get("/api/pairing/pending", headers=h).json()
    assert pending and "ip" in pending[0]


def test_concurrent_requests_do_not_corrupt_transactions(env):
    """Раньше BEGIN/COMMIT из разных потоков перемешивались на одном соединении."""
    _, client, conn = env
    h = pair(client, conn)
    errors = []

    def worker(n):
        try:
            for i in range(15):
                r = client.post("/api/sync", headers=h, json={"since": 0, "entities": [ent(f"w{n}-{i}", 1000 + i)]})
                if r.status_code != 200:
                    errors.append(r.text)
                client.get("/api/devices", headers=h)
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors, errors[:3]
    assert conn.execute("SELECT COUNT(*) c FROM entities").fetchone()["c"] == 90


def test_data_dir_permissions(tmp_path):
    store.connect(tmp_path / "data" / "x.db")
    assert (tmp_path / "data").stat().st_mode & 0o777 == 0o700
    assert (tmp_path / "data" / "x.db").stat().st_mode & 0o777 == 0o600


def test_proxy_that_rewrites_host_still_works(env):
    """Tailscale Serve и подобные прокси: Host переписан, Origin публичный. Так работают синхронизация и сохранение настроек."""
    _, client, conn = env
    h = pair(client, conn)
    proxied = {**h, "Host": "127.0.0.1:8000", "Origin": "https://pc.tail1234.ts.net", "X-Forwarded-Host": "pc.tail1234.ts.net", "X-Forwarded-Proto": "https"}
    assert client.post("/api/sync", headers=proxied, json={"since": 0, "entities": []}).status_code == 200
    assert client.put("/api/assistant/config", headers=proxied, json={"agent": {"url": "http://127.0.0.1:8080/v1"}}).status_code == 200
    # браузерная метка same-origin тоже достаточна (если прокси не передал X-Forwarded-Host)
    only_site = {**h, "Host": "127.0.0.1:8000", "Origin": "https://pc.tail1234.ts.net", "Sec-Fetch-Site": "same-origin"}
    assert client.post("/api/sync", headers=only_site, json={"since": 0, "entities": []}).status_code == 200


def test_cross_site_still_blocked_behind_proxy(env):
    _, client, conn = env
    h = pair(client, conn)
    evil = {**h, "Host": "127.0.0.1:8000", "Origin": "https://evil.example.com", "X-Forwarded-Host": "pc.tail1234.ts.net"}
    assert client.post("/api/sync", headers=evil, json={"since": 0, "entities": []}).status_code == 403
    assert client.post("/api/sync", headers={**evil, "Sec-Fetch-Site": "cross-site"}, json={"since": 0, "entities": []}).status_code == 403
    assert client.post("/api/sync", headers={**h, "Origin": "null"}, json={"since": 0, "entities": []}).status_code == 403


# ---------- комната «Рядом»: адрес релея в CSP ----------
@pytest.mark.parametrize("url,expected", [
    ("wss://relay.example", "wss://relay.example"),
    ("wss://relay.example:8443/путь?x=1", "wss://relay.example:8443"),
    ("ws://127.0.0.1:8787", "ws://127.0.0.1:8787"),
    ("wss://[::1]:9", "wss://[::1]:9"),
    ("https://relay.example", ""),          # только WebSocket
    ("wss://user:pass@relay.example", ""),  # без логина в адресе
    ("wss://relay example", ""),
    ("wss://x;script-src *", ""),           # нельзя дописать свои директивы
    ("", ""), (None, ""),
])
def test_relay_source(url, expected):
    assert security.relay_source(url) == expected


def test_csp_default_has_no_external_connections():
    csp = security.build_csp(None)
    assert "connect-src 'self';" in csp
    assert "wss:" not in csp and "ws:" not in csp


def test_csp_allows_only_the_configured_relay():
    csp = security.build_csp("wss://relay.example")
    assert "connect-src 'self' wss://relay.example;" in csp
    assert "script-src 'self';" in csp  # остальное не ослаблено
    assert "*" not in csp


def test_csp_ignores_a_bad_relay_url():
    assert security.build_csp("javascript:alert(1)") == security.build_csp(None)


def test_camera_stays_off_for_room_by_code(env):
    _, client, _ = env
    r = client.get("/api/health") if client.get("/api/health").status_code != 404 else client.get("/")
    assert "camera=()" in r.headers["permissions-policy"]


# ---------- сервис мирового рейтинга: адрес в CSP ----------
@pytest.mark.parametrize("url,expected", [
    ("https://board.example", "https://board.example"),
    ("https://board.example/", "https://board.example"),
    ("http://127.0.0.1:8800", "http://127.0.0.1:8800"),
    ("https://board.example/v1", ""),
    ("https://user:pw@board.example", ""),
    ("wss://board.example", ""),
    ("javascript:alert(1)", ""),
    ("https://a.example;script-src *", ""),
    ("", ""),
    (None, ""),
])
def test_board_source(url, expected):
    assert security.board_source(url) == expected


def test_csp_with_board():
    csp = security.build_csp("wss://relay.example", "https://board.example")
    assert "connect-src 'self' wss://relay.example https://board.example;" in csp
    assert security.build_csp(None, "https://board.example/x") == security.build_csp(None)


# ---------- нативная оболочка (Capacitor): origin https://localhost и capacitor://localhost ----------
# Host — адрес сервера в сети (не localhost): иначе Origin https://localhost совпал бы с ним как «свой» и проверка ничего бы не доказывала.
NATIVE = "https://localhost"
LAN = {"Host": "192.168.1.20:8000"}


def test_native_preflight_is_answered_with_cors_headers(env):
    _, client, _ = env
    r = client.options("/api/sync", headers={**LAN, "Origin": NATIVE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == NATIVE
    assert "authorization" in r.headers["access-control-allow-headers"]
    assert "access-control-allow-credentials" not in r.headers


def test_foreign_preflight_gets_no_cors_headers(env):
    _, client, _ = env
    r = client.options("/api/sync", headers={**LAN, "Origin": "https://evil.example.com", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers


@pytest.mark.parametrize("origin", ["https://localhost", "capacitor://localhost"])
def test_native_origin_can_pair_and_sync_even_when_cross_site(env, origin):
    """Android WebView шлёт Sec-Fetch-Site: cross-site, но Origin у него настоящий и подделать его странице нельзя."""
    _, client, conn = env
    code = store.create_pair_code(conn)
    hdr = {**LAN, "Origin": origin, "Sec-Fetch-Site": "cross-site"}
    r = client.post("/api/pair", headers=hdr, json={"code": code, "deviceId": "dev-native01", "name": "Телефон (Android)"})
    assert r.status_code == 200, r.text
    assert r.headers["access-control-allow-origin"] == origin
    auth = {**hdr, "Authorization": "Bearer " + r.json()["token"]}
    s = client.post("/api/sync", headers=auth, json={"since": 0, "entities": []})
    assert s.status_code == 200 and s.headers["access-control-allow-origin"] == origin
    assert client.get("/api/devices", headers=auth).headers["access-control-allow-origin"] == origin


def test_native_origin_does_not_open_other_origins(env):
    _, client, conn = env
    h = pair(client, conn)
    for origin in ["https://localhost.evil.com", "https://evil.example.com", "null"]:
        r = client.post("/api/sync", headers={**h, **LAN, "Origin": origin, "Sec-Fetch-Site": "cross-site"}, json={"since": 0, "entities": []})
        assert r.status_code == 403, origin
        assert "access-control-allow-origin" not in r.headers


def test_native_origin_still_needs_a_token(env):
    _, client, _ = env
    r = client.post("/api/sync", headers={**LAN, "Origin": NATIVE}, json={"since": 0, "entities": []})
    assert r.status_code == 401
    assert r.headers["access-control-allow-origin"] == NATIVE


def test_native_origin_keeps_body_limits_and_content_type(env):
    _, client, conn = env
    h = {**pair(client, conn), **LAN, "Origin": NATIVE}
    big = client.post("/api/sync", headers={**h, "Content-Length": str(64 * 1024 * 1024), "Content-Type": "application/json"}, content=b"{}")
    assert big.status_code == 413 and big.headers["access-control-allow-origin"] == NATIVE
    plain = client.post("/api/sync", headers={**h, "Content-Type": "text/plain"}, content=b"{}")
    assert plain.status_code == 415


def test_native_origins_can_be_disabled_or_replaced(env, monkeypatch):
    _, client, _ = env
    body = {"deviceId": "dev-aaaaaaaa"}
    monkeypatch.setenv("WORKOUT_NATIVE_ORIGINS", "")
    assert client.post("/api/pairing/request", json=body, headers={**LAN, "Origin": NATIVE}).status_code == 403
    monkeypatch.setenv("WORKOUT_NATIVE_ORIGINS", "https://app.example.org")
    assert client.post("/api/pairing/request", json=body, headers={**LAN, "Origin": "https://app.example.org"}).status_code == 200
    assert client.post("/api/pairing/request", json=body, headers={**LAN, "Origin": NATIVE}).status_code == 403
