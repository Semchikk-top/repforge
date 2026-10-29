"""Подставной «Anthropic» для проверки всей цепочки браузер → сервер → провайдер без настоящего ключа.
Запуск: uvicorn tests.ui.fake_provider:app --port 8790"""
import asyncio
import json
import re
from datetime import date, timedelta

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()


def block_text(i, chunks):
    ev = [{"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}]
    ev += [{"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": c}} for c in chunks]
    return ev + [{"type": "content_block_stop", "index": i}]


def block_tool(i, id, name, args):
    raw = json.dumps(args, ensure_ascii=False)
    h = len(raw) // 2
    return [
        {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}},
        {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": raw[:h]}},
        {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": raw[h:]}},
        {"type": "content_block_stop", "index": i},
    ]


def stream(events, delay=0.05):
    async def gen():
        for e in events:
            yield f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n"
            await asyncio.sleep(delay)
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/v1/messages")
async def messages(req: Request):
    body = await req.json()
    msgs = body["messages"]
    last = msgs[-1]
    today = date.fromisoformat(re.search(r"Сегодня (\d{4}-\d{2}-\d{2})", body["system"]).group(1))
    head = [{"type": "message_start", "message": {}}]
    tail = [{"type": "message_stop"}]

    if last["role"] == "user" and isinstance(last["content"], list):  # пришёл результат инструмента
        tool_name = msgs[-2]["content"][-1]["name"]
        result = last["content"][0]["content"]
        if tool_name == "get_recent_workouts":
            n = json.loads(result)["count"]
            # пауза, чтобы статус «Смотрю последние тренировки…» успел отобразиться
            return stream(head + block_text(0, ["За месяц у тебя ", f"**Тренировок: {n}**.", "\n\n- Объём растёт\n- ", "Держи ритм"]) + tail, delay=0.4)
        return stream(head + block_text(0, ["Готово, проверь карточку ниже."]) + tail)

    text = last["content"]
    if "завтра" in text:
        tomorrow = (today + timedelta(days=1)).isoformat()
        args = {"date": tomorrow, "title": "Грудь и трицепс", "exercises": [
            {"name": "Жим штанги лёжа", "sets": 4, "reps": 6, "weight_kg": 85},
            {"name": "Французский жим", "sets": 3, "reps": 10},
            {"name": "Отжимания с хлопком", "sets": 3, "reps": 8, "muscle": "chest"}]}
        return stream(head + block_text(0, ["Составлю, глянув историю. "]) + block_tool(1, "toolu_a", "propose_workout", args) + tail)
    if "месяц" in text:
        return stream(head + block_tool(0, "toolu_b", "get_recent_workouts", {"days": 30}) + tail)
    if "долго" in text:
        return stream(head + block_text(0, [f"слово{i} " for i in range(80)]) + tail, delay=0.25)
    return stream(head + block_text(0, ["Понял: ", text[:40]]) + tail)


@app.get("/v1/models")
async def models():
    """Для проверки подключения: понимают и Anthropic-клиент, и OpenAI-совместимый (агент)."""
    return {"data": [{"id": "fake-model-1"}, {"id": "fake-model-2"}]}
