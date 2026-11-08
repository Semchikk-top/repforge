import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from server import db as store
from server.assistant.tools import DataAccess, validate_proposal
from server.main import make_app

TODAY = "2026-10-23"
BENCH = "seed-001"


# ---------- инфраструктура ----------

@pytest.fixture()
def env(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("ASSISTANT_LOCAL_MODEL", "qwen-test")
    app = make_app(tmp_path / "t.db")
    client = TestClient(app, base_url="http://localhost")
    conn = app.state.conn
    code = store.create_pair_code(conn)
    token = client.post("/api/pair", json={"code": code, "deviceId": "dev-aaaaaaaa", "name": "T"}).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    seed_data(client, headers)
    return app, client, headers


def entity(table, id, data, updated=100):
    return {"table": table, "id": id, "updatedAt": updated, "deviceId": "dev-aaaaaaaa", "deleted": False, "data": {"id": id, **data}}


def workout(id, date, sets, status="done", title="Грудь"):
    return entity("workouts", id, {
        "date": date, "title": title, "status": status, "startedAt": 1_000_000, "finishedAt": 1_000_000 + 3_600_000,
        "exercises": [{"id": "we" + id, "exerciseId": BENCH, "sets": [{"id": f"s{i}", "weight": w, "reps": r, "done": d} for i, (w, r, d) in enumerate(sets)]}],
    })


def seed_data(client, headers):
    ents = [
        entity("exercises", BENCH, {"name": "Жим штанги лёжа", "muscle": "chest", "equipment": "Штанга"}),
        entity("exercises", "seed-002", {"name": "Подтягивания", "muscle": "back", "equipment": "Турник"}),
        workout("w1", "2026-10-13", [(80, 8, True), (80, 8, True), (80, 6, False)]),
        workout("w2", "2026-10-20", [(82.5, 8, True), (85, 5, True)]),
        workout("w3", "2026-10-25", [(0, 10, False)], status="planned", title="Спина"),
    ]
    r = client.post("/api/sync", json={"since": 0, "entities": ents}, headers=headers)
    assert r.status_code == 200


def sse(*events: dict, event_names=False) -> bytes:
    return "".join(f"data: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events).encode()


def a_text(*chunks):
    ev = [{"type": "message_start", "message": {}}, {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}]
    ev += [{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": c}} for c in chunks]
    ev += [{"type": "content_block_stop", "index": 0}, {"type": "message_stop"}]
    return sse(*ev)


def a_tool(id, name, args, lead=None):
    ev = [{"type": "message_start", "message": {}}]
    idx = 0
    if lead:
        ev += [{"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
               {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": lead}}, {"type": "content_block_stop", "index": 0}]
        idx = 1
    raw = json.dumps(args, ensure_ascii=False)
    half = len(raw) // 2
    ev += [{"type": "content_block_start", "index": idx, "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}},
           {"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": raw[:half]}},
           {"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": raw[half:]}},
           {"type": "content_block_stop", "index": idx}, {"type": "message_stop"}]
    return sse(*ev)


def o_text(*chunks):
    return sse(*[{"choices": [{"delta": {"content": c}}]} for c in chunks], ) + b"data: [DONE]\n\n"


def o_tool(id, name, args):
    raw = json.dumps(args, ensure_ascii=False)
    half = len(raw) // 2
    return sse(
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": id, "type": "function", "function": {"name": name, "arguments": raw[:half]}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": raw[half:]}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ) + b"data: [DONE]\n\n"


def nd(*events: dict) -> bytes:
    """Нативный поток Ollama: по одному JSON на строку."""
    return "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events).encode()


def n_text(*chunks, reason="stop", thinking=None):
    ev = []
    if thinking:
        ev += [{"message": {"role": "assistant", "content": "", "thinking": t}, "done": False} for t in thinking]
    ev += [{"message": {"role": "assistant", "content": c}, "done": False} for c in chunks]
    return nd(*ev, {"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": reason})


def n_tool(name, args, reason="stop"):
    return nd(
        {"message": {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": name, "arguments": args}}]}, "done": False},
        {"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": reason},
    )


def nok(content):
    return httpx.Response(200, headers={"content-type": "application/x-ndjson"}, content=content)


def install(app, handler):
    app.state.client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))


def ok(content):
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=content)


def chat(client, headers, backend="cloud", text="Привет"):
    events = []
    with client.stream("POST", "/api/assistant/chat", headers=headers,
                       json={"backend": backend, "today": TODAY, "messages": [{"role": "user", "content": text}]}) as r:
        assert r.status_code == 200, r.read()
        for line in r.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def text_of(events):
    return "".join(e["text"] for e in events if e["type"] == "delta")


# ---------- Anthropic ----------

def test_anthropic_plain_text_and_request_shape(env):
    app, client, h = env
    seen = {}

    def handler(req: httpx.Request):
        seen["url"], seen["headers"], seen["body"] = str(req.url), req.headers, json.loads(req.content)
        return ok(a_text("Привет", ", атлет!"))

    install(app, handler)
    ev = chat(client, h)
    assert text_of(ev) == "Привет, атлет!" and ev[-1]["type"] == "done"
    assert seen["url"] == "https://api.anthropic.com/v1/messages"
    assert seen["headers"]["x-api-key"] == "test-key" and seen["headers"]["anthropic-version"] == "2023-06-01"
    b = seen["body"]
    assert b["stream"] is True and b["model"] == "claude-sonnet-5-5"
    assert "2026-10-23" in b["system"] and "пятница" in b["system"]
    assert {t["name"] for t in b["tools"]} >= {"get_recent_workouts", "propose_workout"}
    assert b["messages"] == [{"role": "user", "content": "Привет"}]


def test_anthropic_tool_loop_returns_real_data(env):
    app, client, h = env
    calls = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        calls.append(body)
        if len(calls) == 1:
            return ok(a_tool("toolu_1", "get_recent_workouts", {"days": 30}, lead="Гляну историю. "))
        last = body["messages"][-1]
        assert last["role"] == "user" and last["content"][0]["type"] == "tool_result"
        assert last["content"][0]["tool_use_id"] == "toolu_1"
        payload = json.loads(last["content"][0]["content"])
        assert [w["date"] for w in payload["workouts"]] == ["2026-10-20", "2026-10-13"]  # планируемая w3 не попала
        assert payload["workouts"][0]["exercises"][0]["sets"] == ["82.5x8", "85x5"]
        # невыполненный подход (80x6, done=False) не учитывается
        assert payload["workouts"][1]["exercises"][0]["sets"] == ["80x8", "80x8"]
        assert body["messages"][-2]["content"][-1]["type"] == "tool_use"
        return ok(a_text("Две тренировки за месяц."))

    install(app, handler)
    ev = chat(client, h, text="Как я тренируюсь?")
    assert [e["type"] for e in ev if e["type"] in ("tool", "done")] == ["tool", "done"]
    assert text_of(ev) == "Гляну историю. \n\nДве тренировки за месяц."
    assert len(calls) == 2


def test_propose_workout_emits_card_and_validates(env):
    app, client, h = env
    n = {"i": 0}

    def handler(req: httpx.Request):
        n["i"] += 1
        body = json.loads(req.content)
        if n["i"] == 1:  # неверная дата — модель получает ошибку и исправляется
            return ok(a_tool("t1", "propose_workout", {"date": "завтра", "title": "Грудь", "exercises": [{"name": "Жим", "sets": 3, "reps": 8}]}))
        if n["i"] == 2:
            res = body["messages"][-1]["content"][0]["content"]
            assert "Некорректная дата" in res
            return ok(a_tool("t2", "propose_workout", {"date": "2026-10-24", "title": "Грудь", "exercises": [
                {"name": "Жим штанги лёжа", "sets": 4, "reps": 6, "weight_kg": 85}, {"name": "Отжимания", "sets": 3, "reps": 12, "muscle": "chest"}]}))
        assert "Предложение показано" in body["messages"][-1]["content"][0]["content"]
        return ok(a_text("Готово, проверь карточку."))

    install(app, handler)
    ev = chat(client, h, text="Составь тренировку на завтра")
    proposals = [e["proposal"] for e in ev if e["type"] == "proposal"]
    assert len(proposals) == 1
    p = proposals[0]
    assert p["date"] == "2026-10-24" and p["exercises"][0] == {"name": "Жим штанги лёжа", "sets": 4, "reps": 6, "weight": 85.0}
    assert p["exercises"][1]["muscle"] == "chest"
    assert ev[-1]["type"] == "done"


def test_provider_errors_are_reported(env):
    app, client, h = env
    install(app, lambda req: httpx.Response(401, json={"error": {"message": "invalid x-api-key"}}))
    ev = chat(client, h)
    assert ev[-1]["type"] == "error" and "ключ" in ev[-1]["message"]
    install(app, lambda req: httpx.Response(429, json={"error": {"message": "rate"}}))
    assert "подождать" in chat(client, h)[-1]["message"]

    def boom(req):
        raise httpx.ConnectError("nope")

    install(app, boom)
    assert "Нет связи" in chat(client, h)[-1]["message"]


# ---------- локальная модель (OpenAI-совместимый формат, как у Ollama) ----------

def test_local_native_tool_loop(env):
    app, client, h = env
    calls = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        calls.append((str(req.url), body))
        if len(calls) == 1:
            return nok(n_tool("get_exercise_history", {"exercise": "жим лежа"}))
        tool_msg = body["messages"][-1]
        assert tool_msg["role"] == "tool" and tool_msg["tool_name"] == "get_exercise_history"
        data = json.loads(tool_msg["content"])
        assert data["results"][0]["exercise"] == "Жим штанги лёжа"  # ё/е не мешает поиску
        assert data["results"][0]["sessions"][0]["best_e1rm"] == round(max(82.5 * (1 + 8 / 30), 85 * (1 + 5 / 30)), 1)
        asst = body["messages"][-2]
        assert asst["role"] == "assistant" and asst["tool_calls"][0]["function"] == {"name": "get_exercise_history", "arguments": {"exercise": "жим лежа"}}
        return nok(n_text("Прогресс ", "есть."))

    install(app, handler)
    ev = chat(client, h, backend="local", text="Как мой жим?")
    url, first = calls[0]
    assert url == "http://127.0.0.1:11434/api/chat"
    assert first["model"] == "qwen-test" and first["messages"][0]["role"] == "system" and first["stream"] is True
    assert first["think"] is False and first["options"] == {"num_ctx": 16384, "num_predict": 1500}
    assert first["tools"][0]["type"] == "function"
    assert text_of(ev) == "Прогресс есть." and ev[-1]["type"] == "done"
    assert not [e for e in ev if e["type"] == "notice"]


def test_local_ignores_thinking_and_empty_content_chunks(env):
    app, client, h = env
    install(app, lambda req: nok(n_text("Ответ ", "готов.", thinking=["Надо подумать… ", "Ещё думаю…"])))
    ev = chat(client, h, backend="local")
    assert text_of(ev) == "Ответ готов." and "думаю" not in text_of(ev)
    assert ev[-1]["type"] == "done" and not [e for e in ev if e["type"] == "notice"]


def test_local_length_truncation_shows_notice(env):
    app, client, h = env
    install(app, lambda req: nok(n_text("Неделя прошла ", "неплохо, но", reason="length")))
    ev = chat(client, h, backend="local", text="Проанализируй мою неделю")
    assert text_of(ev) == "Неделя прошла неплохо, но"
    notices = [e["text"] for e in ev if e["type"] == "notice"]
    assert len(notices) == 1 and "обрезан" in notices[0] and ev[-1]["type"] == "done"


def test_local_length_with_no_text_never_leaves_empty_bubble(env):
    app, client, h = env
    install(app, lambda req: nok(n_text(reason="length", thinking=["думаю " * 50])))
    ev = chat(client, h, backend="local")
    assert text_of(ev) == ""
    notices = [e["text"] for e in ev if e["type"] == "notice"]
    assert len(notices) == 1 and "лимит" in notices[0] and ev[-1]["type"] == "done"


def test_local_empty_reply_gets_explanation(env):
    app, client, h = env
    install(app, lambda req: nok(n_text()))
    ev = chat(client, h, backend="local")
    assert text_of(ev) == "" and any(e["type"] == "notice" and "пустой" in e["text"] for e in ev)


def test_local_strips_inline_think_tags_even_when_split(env):
    app, client, h = env
    install(app, lambda req: nok(n_text("<thi", "nk>секретные мысли</th", "ink>Готово", ": 3 тренировки.")))
    ev = chat(client, h, backend="local")
    assert text_of(ev) == "Готово: 3 тренировки."


def test_local_mid_stream_error_is_reported(env):
    app, client, h = env
    install(app, lambda req: nok(nd({"message": {"content": "Нач"}, "done": False}, {"error": "model runner has unexpectedly stopped"})))
    ev = chat(client, h, backend="local")
    assert ev[-1]["type"] == "error" and "unexpectedly" in ev[-1]["message"]


def test_local_retries_without_think_when_model_rejects_it(env):
    app, client, h = env
    seen = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append("think" in body)
        if "think" in body:
            return httpx.Response(400, json={"error": "\"qwen-test\" does not support think"})
        return nok(n_text("Ок."))

    install(app, handler)
    ev = chat(client, h, backend="local")
    assert seen == [True, False] and text_of(ev) == "Ок."


def test_local_custom_url_without_v1_suffix(env):
    app, client, h = env
    client.put("/api/assistant/config", headers=h, json={"local": {"url": "http://127.0.0.1:11500"}})
    urls = []

    def handler(req: httpx.Request):
        urls.append(str(req.url))
        return nok(n_text("Ок."))

    install(app, handler)
    chat(client, h, backend="local")
    assert urls == ["http://127.0.0.1:11500/api/chat"]


# ---------- агент (OpenAI-совместимый адаптер остаётся прежним) ----------

def test_agent_uses_openai_adapter_not_native_ollama(env):
    app, client, h = env
    client.put("/api/assistant/config", headers=h, json={"agent": {"url": "http://127.0.0.1:8080/v1", "model": "my-agent"}})
    calls = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        calls.append((str(req.url), body))
        if len(calls) == 1:
            return ok(o_tool("call_1", "get_personal_records", {}))
        assert body["messages"][-1]["role"] == "tool" and body["messages"][-1]["tool_call_id"] == "call_1"
        return ok(o_text("Рекорд ", "один."))

    install(app, handler)
    ev = chat(client, h, backend="agent", text="Мои рекорды?")
    assert calls[0][0] == "http://127.0.0.1:8080/v1/chat/completions"
    assert "think" not in calls[0][1] and "options" not in calls[0][1] and calls[0][1]["max_tokens"] == 1500
    assert text_of(ev) == "Рекорд один." and ev[-1]["type"] == "done"


def test_openai_length_finish_reports_truncation(env):
    app, client, h = env
    client.put("/api/assistant/config", headers=h, json={"agent": {"url": "http://127.0.0.1:8080/v1", "model": "my-agent"}})
    body = sse({"choices": [{"delta": {"content": "Обрыв"}}]}, {"choices": [{"delta": {}, "finish_reason": "length"}]}) + b"data: [DONE]\n\n"
    install(app, lambda req: ok(body))
    ev = chat(client, h, backend="agent")
    assert text_of(ev) == "Обрыв" and any(e["type"] == "notice" and "обрезан" in e["text"] for e in ev)


def test_model_without_tool_support_falls_back(env):
    app, client, h = env
    seen = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append("tools" in body)
        if "tools" in body:
            return httpx.Response(400, json={"error": {"message": "registry.ollama.ai/library/gemma does not support tools"}})
        return nok(n_text("Отвечаю без данных."))

    install(app, handler)
    ev = chat(client, h, backend="local")
    assert seen == [True, False]
    assert any(e["type"] == "notice" for e in ev) and text_of(ev) == "Отвечаю без данных."


def test_local_model_autodetect_and_unavailable(env, monkeypatch):
    app, client, h = env
    monkeypatch.delenv("ASSISTANT_LOCAL_MODEL")

    def handler(req: httpx.Request):
        if req.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "llama3.2:3b"}]})
        assert req.url.path == "/api/chat" and json.loads(req.content)["model"] == "llama3.2:3b"
        return nok(n_text("ок"))

    install(app, handler)
    assert text_of(chat(client, h, backend="local")) == "ок"
    install(app, lambda req: httpx.Response(200, json={"models": []}))
    assert "локальную модель" in chat(client, h, backend="local")[-1]["message"]


# ---------- эндпоинты ----------

def test_cloud_not_configured_and_auth(env, monkeypatch):
    app, client, h = env
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    r = client.post("/api/assistant/chat", headers=h, json={"backend": "cloud", "messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 503 and "API-ключ" in r.json()["detail"]
    assert client.post("/api/assistant/chat", json={"messages": [{"role": "user", "content": "x"}]}).status_code == 401
    assert client.post("/api/assistant/chat", headers=h, json={"backend": "evil", "messages": [{"role": "user", "content": "x"}]}).status_code == 422
    assert client.post("/api/assistant/chat", headers=h, json={"messages": [{"role": "system", "content": "x"}]}).status_code == 422


def test_status_endpoint(env):
    app, client, h = env
    r = client.get("/api/assistant/status", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["cloud"] == {"configured": True, "model": "claude-sonnet-5-5"}
    assert body["local"]["reachable"] is False and body["local"]["model"] == "qwen-test"
    assert client.get("/api/assistant/status").status_code == 401


# ---------- инструменты ----------

def test_data_tools(env):
    app, _, _ = env
    d = DataAccess(app.state.conn, TODAY)
    ws = d.get_weekly_summary(weeks=3)["weeks"]
    assert [w["week_start"] for w in ws] == ["2026-10-05", "2026-10-12", "2026-10-19"]
    assert [w["workouts"] for w in ws] == [0, 1, 1]
    assert ws[2]["volume_kg"] == round(82.5 * 8 + 85 * 5) and ws[2]["sets"] == 2
    pr = d.get_personal_records()["records"]
    assert len(pr) == 1 and pr[0]["exercise"] == "Жим штанги лёжа" and pr[0]["set"] == "82.5x8"
    assert d.get_planned_workouts()["planned"][0]["title"] == "Спина"
    assert d.list_exercises(query="подтяг")["total"] == 1
    assert "error" in json.loads(d.execute("get_exercise_history", {"exercise": "нет такого"}))
    assert "error" in json.loads(d.execute("rm_rf", {}))
    assert "error" in json.loads(d.execute("propose_workout", {}))  # запись через execute невозможна
    assert json.loads(d.execute("get_recent_workouts", {"days": "abc", "limit": 1, "self": 5}))["count"] == 1


def test_validate_proposal_limits():
    good, err = validate_proposal({"date": "2026-10-24", "title": " ", "exercises": [{"name": "Присед", "sets": 99, "reps": 0, "weight_kg": 9999}]}, TODAY)
    assert good and good["title"] == "Тренировка" and good["exercises"][0] == {"name": "Присед", "sets": 10, "reps": 1}
    assert validate_proposal({"date": "2099-01-01", "exercises": [{"name": "x"}]}, TODAY)[0] is None
    assert validate_proposal({"date": "2026-10-24", "exercises": []}, TODAY)[0] is None
    assert validate_proposal({"date": "2026-10-24", "exercises": [{"name": ""}]}, TODAY)[0] is None
