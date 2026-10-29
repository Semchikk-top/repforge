"""Экран подключения ассистента: облако (ключ), Ollama, локальный агент."""
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.assistant import config as acfg
from server.main import make_app


@pytest.fixture()
def env(tmp_path: Path, monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "ASSISTANT_CLOUD_API_KEY", "OPENAI_API_KEY", "ASSISTANT_AGENT_URL", "ASSISTANT_LOCAL_MODEL"):
        monkeypatch.delenv(k, raising=False)
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    code = store.create_pair_code(app.state.conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    return app, client, {"Authorization": f"Bearer {token}"}


def mock(app, handler):
    app.state.client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_requires_auth(env):
    _, client, _ = env
    assert client.get("/api/assistant/config").status_code == 401
    assert client.put("/api/assistant/config", json={}).status_code == 401
    assert client.post("/api/assistant/test", json={"backend": "cloud"}).status_code == 401


def test_cloud_key_saved_and_never_returned(env):
    app, client, h = env
    r = client.put("/api/assistant/config", headers=h, json={"cloud": {"provider": "anthropic", "apiKey": "sk-ant-secret-1234", "model": "claude-x"}})
    assert r.status_code == 200
    body = r.json()["cloud"]
    assert body["hasKey"] and body["keyHint"] == "••••1234" and body["model"] == "claude-x"
    assert "secret" not in r.text and "secret" not in client.get("/api/assistant/config", headers=h).text
    # сервер действительно использует сохранённый ключ
    assert acfg.cloud_backend(acfg.load_overrides(app.state.conn)).api_key == "sk-ant-secret-1234"
    st = client.get("/api/assistant/status", headers=h).json()
    assert st["cloud"]["configured"] is True


def test_key_delete_and_unchanged(env):
    app, client, h = env
    client.put("/api/assistant/config", headers=h, json={"cloud": {"apiKey": "sk-ant-secret-1234"}})
    client.put("/api/assistant/config", headers=h, json={"cloud": {"model": "other"}})  # ключ не трогаем
    assert client.get("/api/assistant/config", headers=h).json()["cloud"]["hasKey"] is True
    client.put("/api/assistant/config", headers=h, json={"cloud": {"apiKey": ""}})
    assert client.get("/api/assistant/config", headers=h).json()["cloud"]["hasKey"] is False


def test_key_dropped_when_cloud_address_changes(env):
    """Иначе подключённое устройство могло бы отправить сохранённый ключ на свой сервер."""
    _, client, h = env
    client.put("/api/assistant/config", headers=h, json={"cloud": {"provider": "openai", "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-real-key-9999", "model": "m"}})
    r = client.put("/api/assistant/config", headers=h, json={"cloud": {"baseUrl": "https://evil.example.com/v1"}})
    assert r.status_code == 200 and r.json()["cloud"]["hasKey"] is False


def test_url_validation(env):
    _, client, h = env
    put = lambda body: client.put("/api/assistant/config", headers=h, json=body).status_code  # noqa: E731
    assert put({"cloud": {"provider": "openai", "baseUrl": "http://api.example.com/v1"}}) == 422      # облако только по https
    assert put({"cloud": {"provider": "openai", "baseUrl": "https://u:p@api.example.com/v1"}}) == 422
    assert put({"cloud": {"provider": "openai", "baseUrl": "file:///etc/passwd"}}) == 422
    assert put({"agent": {"url": "http://169.254.169.254/latest"}}) == 422                              # метаданные облачных VM
    assert put({"agent": {"url": "http://evil.example.com:8000/v1"}}) == 422                           # публичные адреса для локальных нельзя
    assert put({"local": {"url": "http://8.8.8.8:11434/v1"}}) == 422
    assert put({"local": {"url": "http://127.0.0.1:11434/v1"}}) == 200
    assert put({"agent": {"url": "http://192.168.1.50:8080/v1"}}) == 200
    assert put({"agent": {"url": "http://omarchy.local:8080/v1"}}) == 200


def test_agent_token_dropped_when_url_changes(env):
    _, client, h = env
    client.put("/api/assistant/config", headers=h, json={"agent": {"url": "http://127.0.0.1:8080/v1", "token": "agent-token-5555"}})
    assert client.get("/api/assistant/config", headers=h).json()["agent"]["hasToken"] is True
    r = client.put("/api/assistant/config", headers=h, json={"agent": {"url": "http://127.0.0.1:9090/v1"}})
    assert r.json()["agent"]["hasToken"] is False


def test_test_endpoint_agent_lists_models(env):
    app, client, h = env
    client.put("/api/assistant/config", headers=h, json={"agent": {"url": "http://127.0.0.1:8080/v1", "token": "tok-123456"}})
    seen = {}

    def handler(req: httpx.Request):
        seen["url"], seen["auth"] = str(req.url), req.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"id": "my-agent"}, {"id": "other"}]})

    mock(app, handler)
    r = client.post("/api/assistant/test", headers=h, json={"backend": "agent"}).json()
    assert r == {"ok": True, "models": ["my-agent", "other"], "message": ""}
    assert seen["url"] == "http://127.0.0.1:8080/v1/models" and seen["auth"] == "Bearer tok-123456"


def test_test_endpoint_reports_problems(env):
    app, client, h = env
    client.put("/api/assistant/config", headers=h, json={"cloud": {"provider": "anthropic", "apiKey": "sk-ant-bad-0000"}})
    mock(app, lambda req: httpx.Response(401, json={"error": {"message": "invalid x-api-key"}}))
    r = client.post("/api/assistant/test", headers=h, json={"backend": "cloud"}).json()
    assert r["ok"] is False and "Ключ" in r["message"] and "sk-ant" not in json.dumps(r)

    def boom(req):
        raise httpx.ConnectError("refused")

    mock(app, boom)
    client.put("/api/assistant/config", headers=h, json={"local": {"url": "http://127.0.0.1:11434/v1"}})
    r = client.post("/api/assistant/test", headers=h, json={"backend": "local"}).json()
    assert r["ok"] is False and r["message"]


def test_test_endpoint_without_key_or_url(env):
    _, client, h = env
    assert client.post("/api/assistant/test", headers=h, json={"backend": "cloud"}).json()["ok"] is False
    r = client.post("/api/assistant/test", headers=h, json={"backend": "agent"}).json()
    assert r["ok"] is False and "агент" in r["message"].lower()


def test_ollama_models_listed(env):
    app, client, h = env
    mock(app, lambda req: httpx.Response(200, json={"models": [{"name": "qwen2.5:7b"}, {"name": "llama3.1:8b"}]}))
    r = client.post("/api/assistant/test", headers=h, json={"backend": "local"}).json()
    assert r["ok"] and r["models"] == ["qwen2.5:7b", "llama3.1:8b"]


def test_chat_through_agent_backend(env):
    app, client, h = env
    client.put("/api/assistant/config", headers=h, json={"agent": {"url": "http://127.0.0.1:8080/v1", "model": "my-agent", "token": "tok-123456"}})
    calls = []

    def handler(req: httpx.Request):
        calls.append((str(req.url), req.headers.get("authorization"), json.loads(req.content)["model"]))
        sse = 'data: {"choices":[{"delta":{"content":"Привет"}}]}\n\ndata: [DONE]\n\n'
        return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})

    mock(app, handler)
    r = client.post("/api/assistant/chat", headers=h, json={"backend": "agent", "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200 and "Привет" in r.text
    assert calls == [("http://127.0.0.1:8080/v1/chat/completions", "Bearer tok-123456", "my-agent")]


def test_chat_agent_not_configured(env):
    _, client, h = env
    r = client.post("/api/assistant/chat", headers=h, json={"backend": "agent", "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 503 and "агент" in r.json()["detail"].lower()


def test_env_still_works_as_fallback(env, monkeypatch):
    app, client, h = env
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-key-abcdef")
    cfg = client.get("/api/assistant/config", headers=h).json()["cloud"]
    assert cfg["hasKey"] and cfg["keySource"] == "env"
