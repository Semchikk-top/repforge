"""Адаптеры провайдеров: Anthropic Messages API и любой OpenAI-совместимый (Ollama, OpenAI, OpenRouter…).

Внутреннее («нейтральное») представление сообщений:
  {"role": "user", "content": str}
  {"role": "assistant", "content": str, "calls": [{"id", "name", "args"}]}
  {"role": "tool", "id": str, "name": str, "content": str}
Каждый адаптер переводит его в формат провайдера и отдаёт поток событий:
  ("text", str) — кусок ответа, ("calls", [ {id,name,args} ]) — запросы инструментов (в самом конце).
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator

import httpx

from .config import Backend

Msg = dict[str, Any]
Event = tuple[str, Any]


class ProviderError(Exception):
    def __init__(self, message: str, status: int | None = None, tools_unsupported: bool = False):
        super().__init__(message)
        self.status = status
        self.tools_unsupported = tools_unsupported


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0))


async def _error_from(resp: httpx.Response) -> ProviderError:
    raw = (await resp.aread()).decode("utf-8", "replace")
    msg = raw[:300]
    try:
        data = json.loads(raw)
        err = data.get("error", data)
        msg = err.get("message", msg) if isinstance(err, dict) else str(err)
    except Exception:
        pass
    low = msg.lower()
    unsupported = resp.status_code == 400 and "tool" in low and ("support" in low or "not" in low)
    if resp.status_code in (401, 403):
        msg = "Провайдер отклонил ключ доступа. Проверь ключ в настройках сервера."
    elif resp.status_code == 404 and "model" in low:
        msg = f"Модель не найдена: {msg}"
    elif resp.status_code == 429:
        msg = "Провайдер просит подождать (лимит запросов). Попробуй чуть позже."
    return ProviderError(msg or f"Ошибка провайдера ({resp.status_code})", resp.status_code, unsupported)


async def _sse_data(resp: httpx.Response) -> AsyncIterator[str]:
    async for line in resp.aiter_lines():
        if line.startswith("data:"):
            data = line[5:].strip()
            if data:
                yield data


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        val = json.loads(raw) if raw else {}
        return val if isinstance(val, dict) else {}
    except (TypeError, ValueError):
        return {}


# ---------------------------------------------------------------- Anthropic

def to_anthropic(msgs: list[Msg]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in msgs:
        if m["role"] == "user":
            out.append({"role": "user", "content": m["content"]})
        elif m["role"] == "assistant":
            blocks: list[dict[str, Any]] = []
            if m.get("content"):
                blocks.append({"type": "text", "text": m["content"]})
            for c in m.get("calls", []):
                blocks.append({"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["args"]})
            out.append({"role": "assistant", "content": blocks})
        elif m["role"] == "tool":
            block = {"type": "tool_result", "tool_use_id": m["id"], "content": m["content"]}
            prev = out[-1] if out else None
            if prev and prev["role"] == "user" and isinstance(prev["content"], list) and all(b.get("type") == "tool_result" for b in prev["content"]):
                prev["content"].append(block)  # результаты нескольких инструментов идут одним сообщением
            else:
                out.append({"role": "user", "content": [block]})
    return out


async def stream_anthropic(client: httpx.AsyncClient, be: Backend, system: str, msgs: list[Msg], tools: list[dict[str, Any]] | None) -> AsyncIterator[Event]:
    body: dict[str, Any] = {"model": be.model, "max_tokens": 1500, "system": system, "messages": to_anthropic(msgs), "stream": True}
    if tools:
        body["tools"] = tools
    headers = {"x-api-key": be.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    bufs: dict[int, dict[str, Any]] = {}
    calls: list[dict[str, Any]] = []
    try:
        async with client.stream("POST", f"{be.base_url.rstrip('/')}/v1/messages", headers=headers, json=body) as resp:
            if resp.status_code != 200:
                raise await _error_from(resp)
            async for data in _sse_data(resp):
                try:
                    ev = json.loads(data)
                except ValueError:
                    continue
                t = ev.get("type")
                if t == "content_block_start" and ev.get("content_block", {}).get("type") == "tool_use":
                    blk = ev["content_block"]
                    bufs[ev["index"]] = {"id": blk["id"], "name": blk["name"], "json": ""}
                elif t == "content_block_delta":
                    d = ev.get("delta", {})
                    if d.get("type") == "text_delta" and d.get("text"):
                        yield "text", d["text"]
                    elif d.get("type") == "input_json_delta" and ev.get("index") in bufs:
                        bufs[ev["index"]]["json"] += d.get("partial_json", "")
                elif t == "content_block_stop" and ev.get("index") in bufs:
                    b = bufs.pop(ev["index"])
                    calls.append({"id": b["id"], "name": b["name"], "args": _parse_args(b["json"])})
                elif t == "error":
                    raise ProviderError(ev.get("error", {}).get("message", "Ошибка провайдера"))
    except httpx.HTTPError as e:
        raise ProviderError(f"Нет связи с провайдером: {e.__class__.__name__}") from e
    yield "calls", calls


# ---------------------------------------------------------------- OpenAI-совместимые

def to_openai(system: str, msgs: list[Msg]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for m in msgs:
        if m["role"] == "user":
            out.append({"role": "user", "content": m["content"]})
        elif m["role"] == "assistant":
            item: dict[str, Any] = {"role": "assistant", "content": m.get("content") or ""}
            if m.get("calls"):
                item["tool_calls"] = [
                    {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"], ensure_ascii=False)}}
                    for c in m["calls"]
                ]
            out.append(item)
        elif m["role"] == "tool":
            out.append({"role": "tool", "tool_call_id": m["id"], "content": m["content"]})
    return out


async def stream_openai(client: httpx.AsyncClient, be: Backend, system: str, msgs: list[Msg], tools: list[dict[str, Any]] | None) -> AsyncIterator[Event]:
    body: dict[str, Any] = {"model": be.model, "messages": to_openai(system, msgs), "stream": True, "max_tokens": 1500}
    if tools:
        body["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in tools]
    headers = {"content-type": "application/json"}
    if be.api_key:
        headers["authorization"] = f"Bearer {be.api_key}"
    acc: dict[Any, dict[str, Any]] = {}
    order: list[Any] = []
    try:
        async with client.stream("POST", f"{be.base_url.rstrip('/')}/chat/completions", headers=headers, json=body) as resp:
            if resp.status_code != 200:
                raise await _error_from(resp)
            async for data in _sse_data(resp):
                if data == "[DONE]":
                    break
                try:
                    ev = json.loads(data)
                except ValueError:
                    continue
                if ev.get("error"):
                    err = ev["error"]
                    raise ProviderError(err.get("message", "Ошибка провайдера") if isinstance(err, dict) else str(err))
                choices = ev.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                if delta.get("content"):
                    yield "text", delta["content"]
                for tc in delta.get("tool_calls") or []:
                    key = tc.get("index")
                    if key is None:
                        key = tc.get("id") or (order[-1] if order else 0)
                    if key not in acc:
                        acc[key] = {"id": "", "name": "", "args": ""}
                        order.append(key)
                    fn = tc.get("function") or {}
                    if tc.get("id"):
                        acc[key]["id"] = tc["id"]
                    if fn.get("name"):
                        acc[key]["name"] = fn["name"]
                    a = fn.get("arguments")
                    if isinstance(a, dict):
                        acc[key]["args"] = a
                    elif a:
                        acc[key]["args"] = (acc[key]["args"] if isinstance(acc[key]["args"], str) else "") + a
    except httpx.HTTPError as e:
        raise ProviderError(f"Нет связи с провайдером: {e.__class__.__name__}") from e
    calls = [
        {"id": acc[k]["id"] or f"call_{i}", "name": acc[k]["name"], "args": _parse_args(acc[k]["args"])}
        for i, k in enumerate(order)
        if acc[k]["name"]
    ]
    yield "calls", calls


def stream_for(be: Backend):
    return stream_anthropic if be.kind == "anthropic" else stream_openai


async def detect_local_model(client: httpx.AsyncClient, be: Backend) -> str:
    """Если модель не задана, берём первую из установленных в Ollama."""
    root = be.base_url[:-3] if be.base_url.endswith("/v1") else be.base_url
    try:
        r = await client.get(f"{root}/api/tags", timeout=3.0)
        models = r.json().get("models", [])
        return models[0]["name"] if models else ""
    except Exception:
        return ""


async def list_models(client: httpx.AsyncClient, be: Backend, timeout: float = 4.0) -> list[str]:
    """Список моделей по стандартным методам провайдеров. Бросает ProviderError с понятным текстом."""
    base = be.base_url.rstrip("/")
    if be.kind == "anthropic":
        url, headers = f"{base}/v1/models", {"x-api-key": be.api_key, "anthropic-version": "2023-06-01"}
    else:
        url, headers = f"{base}/models", ({"authorization": f"Bearer {be.api_key}"} if be.api_key else {})
    try:
        r = await client.get(url, headers=headers, timeout=timeout)
    except httpx.HTTPError as e:
        raise ProviderError(f"Нет связи: {e.__class__.__name__}") from e
    if r.status_code in (401, 403):
        raise ProviderError("Ключ или токен не подошёл", r.status_code)
    if r.status_code != 200:
        raise ProviderError(f"Сервер ответил {r.status_code}", r.status_code)
    try:
        items = r.json().get("data") or r.json().get("models") or []
        names = [str(m.get("id") or m.get("name")) for m in items if isinstance(m, dict) and (m.get("id") or m.get("name"))]
    except (ValueError, AttributeError):
        raise ProviderError("Сервер ответил не в том формате (нужен OpenAI-совместимый API)")
    return names[:100]


async def detect_openai_model(client: httpx.AsyncClient, be: Backend) -> str:
    try:
        names = await list_models(client, be, 3.0)
        return names[0] if names else ""
    except ProviderError:
        return ""
