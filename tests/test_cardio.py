"""Кардио на сервере: синхронизация маршрутов, инструмент ассистента, приватность координат."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.assistant.tools import DataAccess
from server.main import make_app

NOW = 1_800_000_000_000


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    code = store.create_pair_code(app.state.conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    return app, client, {"Authorization": f"Bearer {token}"}


def ent(table, id, data, updated=NOW):
    return {"table": table, "id": id, "updatedAt": updated, "deviceId": "dev-aaaaaaaa", "deleted": False, "data": {"id": id, **data}}


def seed(client, h, extra=()):
    ents = [
        ent("exercises", "seed-030", {"name": "Бег", "muscle": "cardio", "equipment": "Улица"}),
        ent("exercises", "seed-032", {"name": "Велосипед", "muscle": "cardio", "equipment": "Улица"}),
        ent("workouts", "w1", {"date": "2026-10-20", "title": "Утро", "status": "done", "exercises": [
            {"id": "a", "exerciseId": "seed-030", "sets": [], "cardio": {"source": "gps", "distanceM": 5200, "durationSec": 1560, "elevGainM": 42, "trackId": "t1"}}]}),
        ent("workouts", "w2", {"date": "2026-10-22", "title": "Вело", "status": "done", "exercises": [
            {"id": "b", "exerciseId": "seed-032", "sets": [], "cardio": {"source": "manual", "distanceM": 20000, "durationSec": 3600}}]}),
        ent("tracks", "t1", {"workoutId": "w1", "points": [[0, 5575000, 3760000, 1000], [30, 5575100, 3760050, 1002]]}),
        *extra,
    ]
    r = client.post("/api/sync", headers=h, json={"since": 0, "entities": ents})
    assert r.status_code == 200, r.text
    return r


def test_tracks_sync_between_devices(env):
    app, client, h = env
    seed(client, h)
    r = client.post("/api/sync", headers=h, json={"since": 0, "entities": []}).json()
    tracks = [e for e in r["entities"] if e["table"] == "tracks"]
    assert len(tracks) == 1 and tracks[0]["data"]["points"][0][1] == 5575000


def test_geolocation_allowed_for_own_site(env):
    _, client, _ = env
    assert "geolocation=(self)" in client.get("/api/health").headers["permissions-policy"]


def test_assistant_sees_cardio_totals_but_never_coordinates(env):
    app, client, h = env
    seed(client, h)
    da = DataAccess(app.state.conn, "2026-10-24")
    assert "tracks" not in {r["table_name"] for r in app.state.conn.execute("SELECT table_name FROM entities WHERE table_name IN ('exercises','workouts')")}
    out = json.loads(da.execute("get_cardio_history", {"days": 30}))
    assert out["total_distance_km"] == 25.2
    run = next(s for s in out["sessions"] if s["name"] == "Бег")
    assert run["distance_km"] == 5.2 and run["avg_pace_min_per_km"] == "5:00" and run["elevation_gain_m"] == 42
    bike = next(s for s in out["sessions"] if s["name"] == "Велосипед")
    assert bike["avg_speed_kmh"] == 20.0 and "avg_pace_min_per_km" not in bike
    assert out["avg_pace_run_walk_min_per_km"] == "5:00"      # велосипед в темп бега не входит
    text = da.execute("get_cardio_history", {}) + da.execute("get_recent_workouts", {})
    assert "5575000" not in text and "points" not in text and "t1" not in text
    recent = json.loads(da.execute("get_recent_workouts", {"days": 30}))
    assert any(e.get("distance_km") == 5.2 for w in recent["workouts"] for e in w["exercises"])


def test_cardio_tool_ignores_malformed_data(env):
    app, client, h = env
    bad = [
        ent("workouts", "w3", {"date": "2026-10-23", "title": "?", "status": "done", "exercises": [
            {"id": "c", "exerciseId": "seed-030", "sets": [], "cardio": {"distanceM": "много", "durationSec": None}},
            {"id": "d", "exerciseId": "seed-030", "sets": [], "cardio": {"distanceM": -5, "durationSec": 10}},
            {"id": "e", "exerciseId": "seed-030", "sets": [], "cardio": "строка"},
            {"id": "f", "exerciseId": "seed-030", "sets": [], "cardio": {"distanceM": True, "durationSec": 10}}]}),
    ]
    seed(client, h, bad)
    da = DataAccess(app.state.conn, "2026-10-24")
    out = json.loads(da.execute("get_cardio_history", {}))
    assert out["total_distance_km"] == 25.2
    planned = json.loads(DataAccess(app.state.conn, "2026-10-01").execute("get_planned_workouts", {}))
    assert planned["planned"] == []


def test_oversized_track_rejected(env):
    _, client, h = env
    big = ent("tracks", "t9", {"workoutId": "w1", "points": [[i, 5575000 + i, 3760000, None] for i in range(20000)]})
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [big]}).status_code == 413
    ok = ent("tracks", "t8", {"workoutId": "w1", "points": [[i, 5575000 + i, 3760000, 1000] for i in range(4000)]})
    assert client.post("/api/sync", headers=h, json={"since": 0, "entities": [ok]}).status_code == 200


def test_body_measurements_sync_and_stay_away_from_assistant(env):
    app, client, h = env
    seed(client, h, [ent("body", "b1", {"date": "2026-10-20", "weightKg": 78.4, "waistCm": 84})])
    r = client.post("/api/sync", headers=h, json={"since": 0, "entities": []}).json()
    assert any(e["table"] == "body" and e["data"]["weightKg"] == 78.4 for e in r["entities"])
    da = DataAccess(app.state.conn, "2026-10-24")
    text = "".join(da.execute(t, {}) for t in ("get_recent_workouts", "get_cardio_history", "get_planned_workouts", "get_weekly_summary"))
    assert "78.4" not in text and "waist" not in text.lower()
