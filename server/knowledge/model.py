"""Вызов модели для конвейера. По умолчанию только локальная: данные не выходят за пределы компьютера."""
from __future__ import annotations

import dataclasses
from typing import Any

from ..assistant import config as acfg
from ..assistant import providers
from .draft import Ask
from .sources import KnowledgeError

NUM_PREDICT = 4000  # JSON карточки с цитатами длиннее обычного ответа ассистента


def pick_backend(name: str, *, allow_cloud: bool, overrides: dict | None = None) -> acfg.Backend:
    if name == "cloud" and not allow_cloud:
        raise KnowledgeError("Облачная модель не включена: текст источника ушёл бы наружу. Если это нужно, добавь --allow-cloud.")
    be = acfg.get_backend(name, overrides)
    if not be.configured:
        raise KnowledgeError(be.hint or f"Модель «{name}» не настроена.")
    return be


def make_ask(be: acfg.Backend, client_factory: Any = None) -> tuple[Ask, dict[str, str]]:
    """Возвращает функцию запроса и словарь, куда после первого вызова попадёт имя найденной модели."""
    info = {"model": be.model}

    async def ask(system: str, user: str) -> str:
        nonlocal be
        providers.OLLAMA_NUM_PREDICT = max(providers.OLLAMA_NUM_PREDICT, NUM_PREDICT)
        parts: list[str] = []
        finish = ""
        try:
            async with (client_factory or providers.make_client)() as client:
                if not be.model:
                    found = await (providers.detect_openai_model(client, be) if be.name == "agent" else providers.detect_local_model(client, be))
                    if not found:
                        raise KnowledgeError("Модель не найдена: задай ASSISTANT_LOCAL_MODEL или установи модель в Ollama.")
                    be = dataclasses.replace(be, model=found)
                    info["model"] = found
                async for kind, val in providers.stream_for(be)(client, be, system, [{"role": "user", "content": user}], None):
                    if kind == "text":
                        parts.append(val)
                    elif kind == "finish":
                        finish = str(val)
        except providers.ProviderError as e:
            raise KnowledgeError(f"Модель недоступна: {e}") from e
        if finish == "length":
            raise KnowledgeError("Ответ модели оборван по длине. Возьми фрагмент короче (--start/--end) или увеличь ASSISTANT_LOCAL_NUM_CTX.")
        return "".join(parts)

    return ask, info
