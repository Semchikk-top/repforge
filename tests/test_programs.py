"""Программы синхронизируются как обычные записи; ассистент их не читает, а приватные данные не утекают."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.main import make_app


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    code = store.create_pair_code(app.state.conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    return app, client, {"Authorization": f"Bearer {token}"}


def ent(table, id, data, t=1_800_000_000_000):
    return {"table": table, "id": id, "updatedAt": t, "deviceId": "dev-aaaaaaaa", "deleted": False, "data": {"id": id, **data}}


def test_program_syncs_and_workouts_keep_program_links(env):
    app, client, h = env
    prog = ent("programs", "p1", {"title": "Сила", "startDate": "2026-11-02", "weeks": 4, "days": [{"weekday": 1, "templateId": "t1"}]})
    w = ent("workouts", "w1", {"date": "2026-11-02", "title": "Грудь", "status": "planned", "programId": "p1", "programSlot": "p1:0:1", "exercises": []})
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [prog, w]}).status_code == 200
    out = client.post("/api/sync", headers=h, json={"since": 0, "entities": []}).json()["entities"]
    assert {e["table"] for e in out} == {"programs", "workouts"}
    assert next(e for e in out if e["table"] == "workouts")["data"]["programSlot"] == "p1:0:1"


def test_unknown_tables_still_rejected(env):
    _, client, h = env
    for table in ("photos", "conflicts", "users"):
        r = client.post("/api/sync", headers=h, json={"since": 0, "entities": [ent(table, "x1", {})]})
        assert r.status_code in (400, 422), (table, r.status_code)
