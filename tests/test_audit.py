"""Находки аудита безопасности: утечка ключей окружения, служебные адреса, отзыв устройства на открытом канале."""
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import live
from server.assistant import config as cfg
from server.main import make_app
from tests.test_server import ent, pair


@pytest.fixture()
def env(tmp_path: Path):
    app = make_app(tmp_path / "t.db")
    return TestClient(app, base_url="http://localhost"), app, app.state.conn


def ov(**sections):
    base = {"cloud": {}, "local": {}, "agent": {}}
    base.update(sections)
    return base


def test_env_cloud_key_is_not_sent_to_an_address_set_from_the_app(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-secret")
    assert cfg.cloud_backend(ov()).api_key == "sk-env-secret"
    evil = cfg.cloud_backend(ov(cloud={"base_url": "https://attacker.example"}))
    assert evil.base_url == "https://attacker.example" and evil.api_key == ""
    assert not evil.configured  # ключа нет: запрос на чужой адрес не уйдёт


def test_env_cloud_key_survives_when_the_app_repeats_the_same_address(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-secret")
    same = cfg.cloud_backend(ov(cloud={"base_url": "https://api.anthropic.com/"}))
    assert same.api_key == "sk-env-secret"


def test_key_typed_in_the_app_is_still_used_with_a_custom_address(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-secret")
    mine = cfg.cloud_backend(ov(cloud={"base_url": "https://proxy.example", "api_key": "sk-mine"}))
    assert mine.api_key == "sk-mine"


def test_env_openai_key_is_also_protected(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-env")
    assert cfg.cloud_backend(ov(cloud={"provider": "openai"})).api_key == "sk-openai-env"
    assert cfg.cloud_backend(ov(cloud={"provider": "openai", "base_url": "https://attacker.example/v1"})).api_key == ""


def test_env_agent_token_is_not_sent_to_a_new_address(monkeypatch):
    monkeypatch.setenv("ASSISTANT_AGENT_URL", "http://192.168.1.5:8080/v1")
    monkeypatch.setenv("ASSISTANT_AGENT_TOKEN", "agent-secret")
    assert cfg.agent_backend(ov()).api_key == "agent-secret"
    assert cfg.agent_backend(ov(agent={"url": "http://192.168.1.99:9000/v1"})).api_key == ""
    assert cfg.agent_backend(ov(agent={"url": "http://192.168.1.5:8080/v1/"})).api_key == "agent-secret"


def test_http_api_does_not_let_a_device_redirect_the_env_key(env, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-secret")
    client, app, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    r = client.put("/api/assistant/config", json={"cloud": {"baseUrl": "https://attacker.example"}}, headers=a)
    assert r.status_code == 200
    view = r.json()["cloud"]
    assert view["baseUrl"] == "https://attacker.example" and view["hasKey"] is False


@pytest.mark.parametrize("url", ["https://169.254.169.254/latest", "http://169.254.169.254", "https://0.0.0.0", "https://[fe80::1]/", "https://224.0.0.1"])
def test_cloud_address_cannot_point_at_metadata_or_special_ranges(url):
    assert cfg.validate_url("cloud", url) is not None


def test_cloud_still_accepts_normal_https_and_localhost():
    assert cfg.validate_url("cloud", "https://api.openai.com/v1") is None
    assert cfg.validate_url("cloud", "http://127.0.0.1:4000/v1") is None
    assert cfg.validate_url("cloud", "http://example.com/v1") is not None


@pytest.fixture()
def short_stream(monkeypatch):
    monkeypatch.setattr(live, "MAX_SEC", 4.0)
    monkeypatch.setattr(live, "HEARTBEAT_SEC", 0.2)


def test_revoked_device_loses_the_live_channel_quickly(env, short_stream):
    client, _, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    b = pair(client, conn, "dev-bbbbbbbb")
    t = threading.Timer(0.5, lambda: client.delete("/api/devices/dev-aaaaaaaa", headers=b))
    t.start()
    started = time.monotonic()
    with client.stream("GET", "/api/sync/events", headers=a) as r:
        text = "".join(r.iter_text())
    t.join()
    assert time.monotonic() - started < 2.5          # не дожидается конца срока в 4 секунды
    assert text.rstrip().endswith("event: bye\ndata: {}")


def test_event_stream_is_marked_as_not_compressible(env, short_stream, monkeypatch):
    client, _, conn = env
    monkeypatch.setattr(live, "MAX_SEC", 0.05)
    a = pair(client, conn, "dev-aaaaaaaa")
    with client.stream("GET", "/api/sync/events", headers=a) as r:
        assert r.headers["content-encoding"] == "identity"
        assert r.headers["x-accel-buffering"] == "no"
        "".join(r.iter_text())


def test_foreign_change_still_arrives_after_the_recheck(env, short_stream):
    client, _, conn = env
    a = pair(client, conn, "dev-aaaaaaaa")
    b = pair(client, conn, "dev-bbbbbbbb")
    t = threading.Timer(0.4, lambda: client.post("/api/sync", json={"since": 0, "protocol": 1, "entities": [ent("w1", 1000, "dev-bbbbbbbb")]}, headers=b))
    t.start()
    with client.stream("GET", "/api/sync/events", headers=a) as r:
        text = "".join(r.iter_text())
    t.join()
    assert "event: seq" in text
