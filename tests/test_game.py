"""Игровой журнал (0.6) ездит синхронизацией как обычная таблица."""
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
    return client, {"Authorization": f"Bearer {token}"}


def row(id, data, t=1_700_000_000_000):
    return {"table": "game", "id": id, "updatedAt": t, "deviceId": "dev-aaaaaaaa", "deleted": False, "data": {"id": id, **data}}


def test_game_rows_sync_and_come_back(env):
    client, h = env
    rows = [row("wk:w1", {"kind": "workout", "workoutId": "w1", "xp": 120, "coins": 30}), row("state", {"kind": "state", "equipped": {"avatar": "av-plate"}})]
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": rows}).status_code == 200
    out = client.post("/api/sync", headers=h, json={"since": 0, "entities": []}).json()["entities"]
    assert {e["id"] for e in out if e["table"] == "game"} == {"wk:w1", "state"}


def test_newer_game_row_wins(env):
    client, h = env
    client.post("/api/sync", headers=h, json={"since": 0, "entities": [row("state", {"kind": "state", "equipped": {"avatar": "a"}}, 1_700_000_000_100)]})
    client.post("/api/sync", headers=h, json={"since": 0, "entities": [row("state", {"kind": "state", "equipped": {"avatar": "b"}}, 1_700_000_000_050)]})
    out = client.post("/api/sync", headers=h, json={"since": 0, "entities": []}).json()["entities"]
    assert next(e for e in out if e["id"] == "state")["data"]["equipped"]["avatar"] == "a"
