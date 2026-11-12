"""Таблица `learning` (1.5.0): протокол 2, схема 2; клиенты протокола 1 продолжают работать, но попыток не получают."""
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server import version
from server.main import make_app

T = 1_790_000_000_000


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    code = store.create_pair_code(app.state.conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    return client, {"Authorization": f"Bearer {token}"}, app


def attempt(i, passed=True, t=T):
    id = f"at-{i}"
    return {"table": "learning", "id": id, "updatedAt": t, "deviceId": "dev-aaaaaaaa", "deleted": False,
            "data": {"id": id, "courseId": "muscle-growth", "courseVersion": 1, "correct": 9 if passed else 5, "total": 10,
                     "threshold": 80, "passed": passed, "date": "2026-11-11", "createdAt": t, "updatedAt": t, "deviceId": "dev-aaaaaaaa"}}


def sync(client, h, entities=(), since=0, protocol=None):
    body = {"since": since, "entities": list(entities)}
    if protocol is not None:
        body["protocol"] = protocol
    return client.post("/api/sync", headers=h, json=body)


def test_versions_and_table():
    assert version.PROTOCOL_VERSION == 2 and version.SCHEMA_VERSION == 2
    assert version.MIN_CLIENT_PROTOCOL == 1  # решение: старые клиенты работают
    assert "learning" in store.ALLOWED_TABLES


def test_protocol_2_client_pushes_and_gets_attempts_back(env):
    client, h, _ = env
    assert sync(client, h, [attempt(1), attempt(2, passed=False)], protocol=2).status_code == 200
    out = [e for e in sync(client, h, protocol=2).json()["entities"] if e["table"] == "learning"]
    assert {e["id"] for e in out} == {"at-1", "at-2"}


def test_protocol_1_client_still_works_but_does_not_receive_attempts(env):
    client, h, _ = env
    sync(client, h, [attempt(1)], protocol=2)
    r = sync(client, h, protocol=1)
    assert r.status_code == 200
    assert not [e for e in r.json()["entities"] if e["table"] == "learning"]
    assert r.json()["protocol"] == 2 and r.json()["minClientProtocol"] == 1
    # без поля protocol клиент считается самым старым
    assert not [e for e in sync(client, h).json()["entities"] if e["table"] == "learning"]


def test_old_client_does_not_lose_its_place_in_the_stream(env):
    """Попытки, пропущенные для старого клиента, не должны останавливать выдачу остальных записей."""
    client, h, _ = env
    sync(client, h, [attempt(1)], protocol=2)
    sync(client, h, [{"table": "checkins", "id": "ci:1", "updatedAt": T, "deviceId": "dev-aaaaaaaa", "deleted": False, "data": {"id": "ci:1"}}], protocol=2)
    r = sync(client, h, protocol=1).json()
    assert [e["table"] for e in r["entities"]] == ["checkins"]
    assert r["seq"] >= 2


def test_client_newer_than_server_is_still_refused(env):
    client, h, _ = env
    assert sync(client, h, protocol=3).status_code == 426


def test_attempts_are_append_only_union(env):
    """Два устройства добавляют попытки независимо: на сервере оказываются обе, ничего не перезаписывается."""
    client, h, _ = env
    sync(client, h, [attempt(1)], protocol=2)
    other = attempt(2)
    other["deviceId"] = other["data"]["deviceId"] = "dev-bbbbbbbb"
    sync(client, h, [other], protocol=2)
    ids = {e["id"] for e in sync(client, h, protocol=2).json()["entities"] if e["table"] == "learning"}
    assert ids == {"at-1", "at-2"}


def test_migration_to_schema_2_and_refusal_to_open_with_older_code(tmp_path):
    # база 1.4.x: схема 1, в ней обычные записи
    path = tmp_path / "old.db"
    conn = store.connect(path)
    conn.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
    conn.commit()
    conn.close()
    conn = store.connect(path)  # открывается новым кодом и поднимается до схемы 2
    assert store.schema_version(conn) == 2
    conn.close()
    # код со схемой 1 такую базу не откроет
    with pytest.raises(store.SchemaTooNew):
        c = sqlite3.connect(path)
        c.row_factory = sqlite3.Row
        store._migrate(c, target=1)
