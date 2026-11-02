"""Версии сервера: сборки, протокола синхронизации и схемы базы.

Три числа отвечают на три разных вопроса:
- PROTOCOL_VERSION: на каком «языке» клиент и сервер обмениваются записями (поля запроса и ответа, набор таблиц).
  Растёт, когда старый клиент не сможет корректно работать с новым сервером или наоборот.
- MIN_CLIENT_PROTOCOL: самый старый клиент, которого сервер ещё готов обслуживать.
- SCHEMA_VERSION: формат файла базы на диске. Растёт вместе с миграцией в server/db.py (MIGRATIONS).
"""
from __future__ import annotations

import json
from pathlib import Path

PROTOCOL_VERSION = 1
MIN_CLIENT_PROTOCOL = 1
SCHEMA_VERSION = 1


def app_version() -> str:
    """Версия сборки из package.json рядом с сервером (при установке из архива файл лежит в корне)."""
    try:
        pkg = json.loads((Path(__file__).resolve().parent.parent / "package.json").read_text(encoding="utf-8"))
        return str(pkg.get("version", "unknown"))
    except (OSError, ValueError):
        return "unknown"
