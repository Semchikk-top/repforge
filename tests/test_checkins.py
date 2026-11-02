"""Чек-ины самочувствия (0.8) ездят синхронизацией как обычная таблица и не доступны ассистенту."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.main import make_app

T = 1_700_000_000_000


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    code = store.create_pair_code(app.state.conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    return client, {"Authorization": f"Bearer {token}"}, app


def row(date, slot, energy, t=T):
    id = f"ci:{date}:{slot}"
    return {"table": "checkins", "id": id, "updatedAt": t, "deviceId": "dev-aaaaaaaa", "deleted": False,
            "data": {"id": id, "date": date, "slot": slot, "energy": energy, "mood": 3, "soreness": 3, "stress": 3}}


def pull(client, h):
    return client.post("/api/sync", headers=h, json={"since": 0, "entities": []}).json()["entities"]


def test_table_is_allowed():
    assert "checkins" in store.ALLOWED_TABLES


def test_checkins_sync_and_come_back(env):
    client, h, _ = env
    rows = [row("2026-10-31", "morning", 4), row("2026-10-31", "evening", 2)]
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": rows}).status_code == 200
    out = [e for e in pull(client, h) if e["table"] == "checkins"]
    assert {e["id"] for e in out} == {"ci:2026-10-31:morning", "ci:2026-10-31:evening"}


def test_newer_checkin_wins_and_older_is_ignored(env):
    client, h, _ = env
    client.post("/api/sync", headers=h, json={"since": 0, "entities": [row("2026-10-31", "morning", 5, T + 100)]})
    client.post("/api/sync", headers=h, json={"since": 0, "entities": [row("2026-10-31", "morning", 1, T + 50)]})
    got = next(e for e in pull(client, h) if e["id"] == "ci:2026-10-31:morning")
    assert got["data"]["energy"] == 5


def test_unknown_table_is_still_rejected(env):
    client, h, _ = env
    bad = {**row("2026-10-31", "morning", 3), "table": "checkin"}
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [bad]}).status_code >= 400


def test_assistant_context_reads_only_exercises_and_workouts(env):
    # ассистенту чек-ины по умолчанию не передаются: контекст строится из таблиц exercises и workouts
    _, _, _ = env
    src = (Path(__file__).resolve().parent.parent / "server" / "assistant" / "tools.py").read_text(encoding="utf-8")
    assert "table_name IN ('exercises','workouts')" in src
    assert "checkins" not in src
