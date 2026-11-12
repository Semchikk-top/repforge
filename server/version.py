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

# 2 (1.5.0): новая таблица `learning` (отметки о прохождении курсов). Клиенты протокола 1 остаются совместимыми:
# MIN_CLIENT_PROTOCOL = 1, а эту таблицу им просто не отдают (см. tables_for_protocol).
PROTOCOL_VERSION = 2
MIN_CLIENT_PROTOCOL = 1
# 2 (1.5.0): в базе появилась таблица `learning`. DDL не менялся (сущности лежат в общей таблице entities), но номер растёт,
# чтобы прежний сервер не открыл базу, в которой уже есть записи, которых он не поймёт (SchemaTooNew).
SCHEMA_VERSION = 2

# С какого протокола клиент понимает таблицу.
TABLE_SINCE_PROTOCOL = {"learning": 2}


def tables_for_protocol(protocol: int, all_tables: set[str]) -> set[str]:
    return {t for t in all_tables if TABLE_SINCE_PROTOCOL.get(t, 1) <= protocol}


def app_version() -> str:
    """Версия сборки из package.json рядом с сервером (при установке из архива файл лежит в корне)."""
    try:
        pkg = json.loads((Path(__file__).resolve().parent.parent / "package.json").read_text(encoding="utf-8"))
        return str(pkg.get("version", "unknown"))
    except (OSError, ValueError):
        return "unknown"
