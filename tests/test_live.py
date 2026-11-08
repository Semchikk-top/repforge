"""Живая синхронизация (SSE): сигнал о новой ревизии, свои правки не возвращаются, обрывы и лимиты."""
import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db as store
from server import live
from server.main import make_app
from tests.test_server import ent, pair


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    return TestClient(app, base_url="http://localhost"), app, app.state.conn


def push(client, headers, *entities):
    r = client.post("/api/sync", json={"since": 0, "protocol": 1, "entities": list(entities)}, headers=headers)
    assert r.status_code == 200, r.text


def events(text: str):
    """Разбор потока: список (event, data) и количество пингов."""
    out, pings = [], 0
    for block in text.split("\n\n"):
        name, data = None, None
        for line in block.split("\n"):
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data = json.loads(line[5:])
            elif line.startswith(": ping"):
                pings += 1
        if name:
            out.append((name, data))
    return out, pings


def run_stream(client, headers, *, after=()):
    """Открывает канал на короткое время; в это время по расписанию выполняются действия after=[(секунды, функция)]."""
    timers = [threading.Timer(t, fn) for t, fn in after]
    [t.start() for t in timers]
    try:
        with client.stream("GET", "/api/sync/events", headers=headers) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            return "".join(r.iter_text())
    finally:
        [t.join() for t in timers]


@pytest.fixture(autouse=True)
def short_stream(monkeypatch):
    monkeypatch.setattr(live, "MAX_SEC", 1.0)
    monkeypatch.setattr(live, "HEARTBEAT_SEC", 0.2)


def test_events_require_auth(env):
    client, _, _ = env
    assert client.get("/api/sync/events").status_code == 401
    assert client.get("/api/sync/events", headers={"Authorization": "Bearer x"}).status_code == 401


def test_hello_then_foreign_change_then_bye(env):
    client, app, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    b = pair(client, conn, "dev-bbbbbbbb")
    text = run_stream(client, a, after=[(0.4, lambda: push(client, b, ent("w1", 1000, "dev-bbbbbbbb")))])
    evs, pings = events(text)
    names = [n for n, _ in evs]
    assert names[0] == "hello" and names[-1] == "bye"
    assert names.count("seq") == 1
    seq_ev = dict(evs)["seq"]
    assert seq_ev["by"] == "dev-bbbbbbbb" and seq_ev["seq"] == store.current_seq(conn) and seq_ev["seq"] >= 1
    assert pings >= 1  # канал в тишине подаёт признаки жизни
    assert app.state.bus.count() == 0  # после закрытия подписчик снят


def test_own_changes_are_not_echoed(env):
    client, _, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    text = run_stream(client, a, after=[(0.3, lambda: push(client, a, ent("w1", 1000)))])
    assert "event: seq" not in text


def test_foreign_change_is_not_lost_when_own_comes_right_after(env):
    client, app, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    b = pair(client, conn, "dev-bbbbbbbb")

    def both():
        push(client, b, ent("w1", 1000, "dev-bbbbbbbb"))
        push(client, a, ent("w2", 1001))

    evs, _ = events(run_stream(client, a, after=[(0.3, both)]))
    assert [n for n, _ in evs].count("seq") >= 1  # чужая правка дошла, даже если за ней сразу пришла своя


def test_no_event_when_nothing_was_accepted(env):
    client, _, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    b = pair(client, conn, "dev-bbbbbbbb")
    text = run_stream(client, a, after=[(0.3, lambda: push(client, b))])  # пустой обмен: ревизия не менялась
    assert "event: seq" not in text


def test_subscriber_cap(env, monkeypatch):
    client, _, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    monkeypatch.setattr(live, "MAX_SUBSCRIBERS", 0)
    assert client.get("/api/sync/events", headers=a).status_code == 503


def test_reconnect_storm_is_rate_limited(env, monkeypatch):
    client, _, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    monkeypatch.setattr(live, "MAX_SEC", 0.01)
    codes = [client.get("/api/sync/events", headers=a).status_code for _ in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429


def test_bus_is_thread_safe_and_keeps_only_latest():
    async def scenario():
        bus = live.SyncBus()
        q: asyncio.Queue = asyncio.Queue(maxsize=3)
        loop = asyncio.get_running_loop()
        bus.subscribe(loop, q)
        t = threading.Thread(target=lambda: [bus.publish(i, "x") for i in range(1, 11)])
        t.start(); t.join()
        await asyncio.sleep(0.05)
        got = []
        while not q.empty():
            got.append(q.get_nowait()["seq"])
        assert got == [8, 9, 10]  # переполнение вытесняет самые старые
        bus.unsubscribe(loop, q)
        assert bus.count() == 0
    asyncio.run(scenario())


def test_publish_to_closed_loop_drops_subscriber():
    bus = live.SyncBus()
    loop = asyncio.new_event_loop()
    bus.subscribe(loop, asyncio.Queue())
    loop.close()
    bus.publish(1, "x")
    assert bus.count() == 0
