"""Отзыв и восстановление устройств: карточка живёт сутки, прежний токен после восстановления снова работает."""
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.main import make_app
from tests.test_server import pair

DAY = store.REVOKED_VISIBLE_SEC


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    return TestClient(app, base_url="http://localhost"), app.state.conn


def listing(client, headers):
    r = client.get("/api/devices", headers=headers)
    assert r.status_code == 200
    return {d["id"]: d for d in r.json()}


def sync_status(client, headers):
    return client.post("/api/sync", json={"since": 0, "protocol": 1, "entities": []}, headers=headers).status_code


def set_revoked(conn, device_id, value):
    conn.execute("UPDATE devices SET revoked = ? WHERE id = ?", (value, device_id))


def test_revoke_records_time_and_restore_brings_the_old_token_back(env):
    client, conn = env
    a, b = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    before = int(time.time())
    assert client.delete("/api/devices/dev-bbbbbbbb", headers=a).status_code == 200
    d = listing(client, a)["dev-bbbbbbbb"]
    assert d["revoked"] == 1 and before <= d["revokedAt"] <= int(time.time()) + 1
    assert d["restorableUntil"] == d["revokedAt"] + DAY
    assert sync_status(client, b) == 401

    assert client.post("/api/devices/dev-bbbbbbbb/restore", headers=a).status_code == 200
    d = listing(client, a)["dev-bbbbbbbb"]
    assert d["revoked"] == 0 and d["revokedAt"] is None and d["restorableUntil"] is None
    assert sync_status(client, b) == 200           # тот же токен, заново подключать не нужно


def test_second_revoke_does_not_extend_the_window(env):
    client, conn = env
    a, _ = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    long_ago = int(time.time()) - 5000
    set_revoked(conn, "dev-bbbbbbbb", long_ago)
    assert client.delete("/api/devices/dev-bbbbbbbb", headers=a).status_code == 200
    assert listing(client, a)["dev-bbbbbbbb"]["revokedAt"] == long_ago


def test_unknown_device_gives_404_for_both_actions(env):
    client, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    assert client.delete("/api/devices/dev-nope", headers=a).status_code == 404
    assert client.post("/api/devices/dev-nope/restore", headers=a).status_code == 404


def test_restoring_an_active_device_is_a_conflict(env):
    client, conn = env
    a, _ = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    assert client.post("/api/devices/dev-bbbbbbbb/restore", headers=a).status_code == 409


def test_a_revoked_device_cannot_restore_itself(env):
    client, conn = env
    a, b = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    client.delete("/api/devices/dev-bbbbbbbb", headers=a)
    assert client.post("/api/devices/dev-bbbbbbbb/restore", headers=b).status_code == 401


def test_restore_window_boundary_is_exactly_one_day(tmp_path: Path):
    conn = store.connect(tmp_path / "b.db")
    now = 2_000_000_000
    for dev, age, expected in (("d1", DAY - 1, "ok"), ("d2", DAY, "ok"), ("d3", DAY + 1, "expired")):
        conn.execute("INSERT INTO devices (id, name, token_hash, created_at, last_seen, revoked) VALUES (?, 'x', ?, 1, 1, ?)", (dev, dev, now - age))
        assert store.restore_device(conn, dev, now) == expected


def test_card_disappears_a_day_after_revoke_and_cannot_be_restored(env):
    client, conn = env
    a, _ = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    set_revoked(conn, "dev-bbbbbbbb", int(time.time()) - DAY + 600)    # отозвано почти сутки назад
    assert "dev-bbbbbbbb" in listing(client, a)
    set_revoked(conn, "dev-bbbbbbbb", int(time.time()) - DAY - 5)      # прошли сутки
    assert client.post("/api/devices/dev-bbbbbbbb/restore", headers=a).status_code == 410
    assert "dev-bbbbbbbb" not in listing(client, a)                    # список убрал карточку и удалил запись
    assert client.post("/api/devices/dev-bbbbbbbb/restore", headers=a).status_code == 404
    assert conn.execute("SELECT COUNT(*) FROM devices WHERE id = 'dev-bbbbbbbb'").fetchone()[0] == 0


def test_legacy_revoke_flag_uses_last_visit_as_the_revoke_time(env):
    client, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    pair(client, conn, "dev-bbbbbbbb"); pair(client, conn, "dev-cccccccc")
    now = int(time.time())
    conn.execute("UPDATE devices SET revoked = 1, last_seen = ? WHERE id = 'dev-bbbbbbbb'", (now - 3600,))     # отозван давно, но недавно был
    conn.execute("UPDATE devices SET revoked = 1, last_seen = ? WHERE id = 'dev-cccccccc'", (now - 3 * DAY,))   # отозван давно
    got = listing(client, a)
    assert got["dev-bbbbbbbb"]["revoked"] == 1 and got["dev-bbbbbbbb"]["revokedAt"] == now - 3600
    assert "dev-cccccccc" not in got
    assert client.post("/api/devices/dev-bbbbbbbb/restore", headers=a).status_code == 200


def test_active_devices_are_never_purged(env):
    client, conn = env
    a, _ = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    conn.execute("UPDATE devices SET last_seen = 1 WHERE id = 'dev-bbbbbbbb'")   # давно не заходило, но не отозвано
    assert set(listing(client, a)) == {"dev-aaaaaaaa", "dev-bbbbbbbb"}


def test_re_pairing_a_revoked_device_clears_the_revoke(env):
    client, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    b = pair(client, conn, "dev-bbbbbbbb")
    client.delete("/api/devices/dev-bbbbbbbb", headers=a)
    b2 = pair(client, conn, "dev-bbbbbbbb")
    assert listing(client, a)["dev-bbbbbbbb"]["revoked"] == 0
    assert sync_status(client, b2) == 200 and sync_status(client, b) == 401
