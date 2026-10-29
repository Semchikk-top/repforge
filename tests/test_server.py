import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.main import backup_once, make_app


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    return TestClient(app, base_url="http://localhost"), app.state.conn, tmp_path


def pair(client, conn, device_id="dev-aaaaaaaa", name="Телефон"):
    code = store.create_pair_code(conn)
    r = client.post("/api/pair", json={"code": code, "deviceId": device_id, "name": name})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def ent(id, updated, device="dev-aaaaaaaa", table="workouts", deleted=False, title="Т"):
    return {"table": table, "id": id, "updatedAt": updated, "deviceId": device, "deleted": deleted, "data": {"id": id, "title": title}}


def test_pair_code_is_single_use(env):
    client, conn, _ = env
    code = store.create_pair_code(conn)
    ok = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa"})
    again = client.post("/api/pair", json={"code": code, "deviceId": "dev-bbbbbbbb"})
    assert ok.status_code == 200 and again.status_code == 403


def test_wrong_code_and_rate_limit(env):
    client, _, _ = env
    for _ in range(10):
        assert client.post("/api/pair", json={"code": "WRONGCODE", "deviceId": "dev-aaaaaaaa"}).status_code == 403
    assert client.post("/api/pair", json={"code": "WRONGCODE", "deviceId": "dev-aaaaaaaa"}).status_code == 429


def test_sync_requires_auth(env):
    client, _, _ = env
    assert client.post("/api/sync", json={"since": 0, "entities": []}).status_code == 401
    assert client.post("/api/sync", json={"since": 0, "entities": []}, headers={"Authorization": "Bearer x"}).status_code == 401


def test_push_pull_between_devices(env):
    client, conn, _ = env
    a = pair(client, conn, "dev-aaaaaaaa")
    b = pair(client, conn, "dev-bbbbbbbb", "ПК")
    r = client.post("/api/sync", json={"since": 0, "entities": [ent("w1", 100), ent("e1", 100, table="exercises")]}, headers=a).json()
    assert r["accepted"] == 2 and r["entities"] == []  # эхо не возвращается
    r = client.post("/api/sync", json={"since": 0, "entities": []}, headers=b).json()
    assert {e["id"] for e in r["entities"]} == {"w1", "e1"}
    seq = r["seq"]
    # повторный запрос с новым seq ничего не отдаёт
    assert client.post("/api/sync", json={"since": seq, "entities": []}, headers=b).json()["entities"] == []


def test_last_write_wins_and_tiebreak(env):
    client, conn, _ = env
    a = pair(client, conn, "dev-aaaaaaaa")
    client.post("/api/sync", json={"since": 0, "entities": [ent("w1", 200, title="новая")]}, headers=a)
    r = client.post("/api/sync", json={"since": 0, "entities": [ent("w1", 100, device="dev-bbbbbbbb", title="старая")]}, headers=a).json()
    assert r["accepted"] == 0
    assert r["entities"][0]["data"]["title"] == "новая"
    # равное время: побеждает больший deviceId, независимо от порядка
    client.post("/api/sync", json={"since": 0, "entities": [ent("w2", 300, device="dev-aaaaaaaa", title="A")]}, headers=a)
    client.post("/api/sync", json={"since": 0, "entities": [ent("w2", 300, device="dev-bbbbbbbb", title="B")]}, headers=a)
    r = client.post("/api/sync", json={"since": 0, "entities": []}, headers=a).json()
    assert [e["data"]["title"] for e in r["entities"] if e["id"] == "w2"] == ["B"]


def test_delete_propagates(env):
    client, conn, _ = env
    a, b = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    client.post("/api/sync", json={"since": 0, "entities": [ent("w1", 100)]}, headers=a)
    seq = client.post("/api/sync", json={"since": 0, "entities": []}, headers=b).json()["seq"]
    client.post("/api/sync", json={"since": 0, "entities": [ent("w1", 200, deleted=True)]}, headers=a)
    r = client.post("/api/sync", json={"since": seq, "entities": []}, headers=b).json()
    assert len(r["entities"]) == 1 and r["entities"][0]["deleted"] is True


def test_pagination(env, monkeypatch):
    client, conn, _ = env
    a = pair(client, conn)
    client.post("/api/sync", json={"since": 0, "entities": [ent(f"w{i}", 100 + i) for i in range(5)]}, headers=a)
    orig = store.entities_since
    monkeypatch.setattr("server.main.store.entities_since", lambda c, s, x, limit=2000: orig(c, s, x, limit=2))
    b = pair(client, conn, "dev-bbbbbbbb")
    got, since = [], 0
    for _ in range(10):
        r = client.post("/api/sync", json={"since": since, "entities": []}, headers=b).json()
        got += [e["id"] for e in r["entities"]]
        since = r["seq"]
        if not r["more"]:
            break
    assert sorted(got) == [f"w{i}" for i in range(5)]


def test_revoke(env):
    client, conn, _ = env
    a, b = pair(client, conn, "dev-aaaaaaaa"), pair(client, conn, "dev-bbbbbbbb")
    assert client.delete("/api/devices/dev-bbbbbbbb", headers=a).status_code == 200
    assert client.post("/api/sync", json={"since": 0, "entities": []}, headers=b).status_code == 401
    assert client.post("/api/sync", json={"since": 0, "entities": []}, headers=a).status_code == 200


def test_validation_and_backup(env):
    client, conn, tmp = env
    a = pair(client, conn)
    bad = ent("x", 1, table="secrets")
    assert client.post("/api/sync", json={"since": 0, "entities": [bad]}, headers=a).status_code == 422
    client.post("/api/sync", json={"since": 0, "entities": [ent("w1", 1)]}, headers=a)
    dest = backup_once(conn, tmp)
    assert sqlite3.connect(dest).execute("SELECT COUNT(*) FROM entities").fetchone()[0] == 1
