"""Ассистент видит суперсеты и типы подходов; кривые данные его не роняют."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.assistant.tools import DataAccess
from server.main import make_app


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    code = store.create_pair_code(app.state.conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    return app, client, {"Authorization": f"Bearer {token}"}


def ent(table, id, data):
    return {"table": table, "id": id, "updatedAt": 1_800_000_000_000, "deviceId": "dev-aaaaaaaa", "deleted": False, "data": {"id": id, **data}}


def s(id, w, r, kind=None, note=None):
    d = {"id": id, "weight": w, "reps": r, "done": True}
    if kind:
        d["kind"] = kind
    if note:
        d["note"] = note
    return d


def test_assistant_sees_supersets_and_set_kinds(env):
    app, client, h = env
    exs = [ent("exercises", f"e{i}", {"name": n, "muscle": "chest", "equipment": "x"}) for i, n in enumerate(["Жим", "Тяга", "Присед"])]
    w = ent("workouts", "w1", {"date": "2026-10-20", "title": "Силовая", "status": "done", "exercises": [
        {"id": "a", "exerciseId": "e0", "group": "g", "sets": [s("1", 80, 8), s("2", 60, 12, "drop", "тяжело, спина")]},
        {"id": "b", "exerciseId": "e1", "group": "g", "sets": [s("3", 50, 10)]},
        {"id": "c", "exerciseId": "e2", "sets": [s("4", 100, 5, "restpause")]},
    ]})
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [*exs, w]}).status_code == 200
    out = json.loads(DataAccess(app.state.conn, "2026-10-24").execute("get_recent_workouts", {"days": 30}))
    items = out["workouts"][0]["exercises"]
    assert items[0]["superset"] == "A1" and items[1]["superset"] == "A2" and "superset" not in items[2]
    assert items[0]["sets"] == ["80x8", "60x12 (дроп-сет)"]
    assert items[2]["sets"] == ["100x5 (rest-pause)"]
    assert "спина" not in json.dumps(out, ensure_ascii=False)  # заметки к подходам ассистенту не передаются


def test_malformed_groups_do_not_break_tools(env):
    app, client, h = env
    w = ent("workouts", "w2", {"date": "2026-10-21", "title": "?", "status": "done", "exercises": [
        {"id": "a", "exerciseId": "e0", "group": 5, "sets": [s("1", 80, 8, "странный")]},
        {"id": "b", "exerciseId": "e0", "group": {"x": 1}, "sets": [s("2", 80, 8)]},
    ]})
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [ent("exercises", "e0", {"name": "Жим", "muscle": "chest"}), w]}).status_code == 200
    out = json.loads(DataAccess(app.state.conn, "2026-10-24").execute("get_recent_workouts", {"days": 30}))
    assert out["workouts"][0]["exercises"][0]["sets"] == ["80x8"]
