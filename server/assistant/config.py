"""Настройки провайдеров ассистента.

Три способа подключения:
  cloud — облачный провайдер (Anthropic или любой OpenAI-совместимый) по API-ключу;
  local — Ollama на этом ПК;
  agent — локальный агент (любой сервис с OpenAI-совместимым API: llama.cpp, LM Studio, vLLM, свой агент).

Значения берутся из настроек, сохранённых через приложение (таблица meta), а если их нет — из переменных окружения.
Секреты (ключ, токен) наружу не отдаются: клиент видит только «задан / не задан» и последние 4 символа."""
from __future__ import annotations

import ipaddress
import json
import os
import sqlite3
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

META_KEY = "assistant_config"
NAMES = ("cloud", "local", "agent")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass
class Backend:
    name: str  # 'cloud' | 'local' | 'agent'
    kind: str  # 'anthropic' | 'openai'  (openai = любой OpenAI-совместимый, в том числе Ollama)
    base_url: str
    api_key: str
    model: str

    @property
    def insecure(self) -> bool:
        """Облачный ключ нельзя отправлять по HTTP (кроме своего компьютера)."""
        u = urlsplit(self.base_url)
        return self.name == "cloud" and u.scheme != "https" and (u.hostname or "") not in ("127.0.0.1", "localhost", "::1")

    @property
    def configured(self) -> bool:
        if self.name == "cloud":
            return bool(self.api_key and self.model) and not self.insecure
        return bool(self.base_url)  # для локальных ключ не нужен, модель можно определить автоматически

    @property
    def hint(self) -> str:
        if self.insecure:
            return "Адрес облачного провайдера должен начинаться с https://: иначе ключ уйдёт открытым текстом."
        if self.name == "cloud":
            return "Облако не настроено: открой Настройки → Ассистент → «Настроить подключение» и введи API-ключ."
        if self.name == "agent":
            return "Локальный агент не подключён: укажи его адрес в Настройки → Ассистент → «Настроить подключение»."
        return "Ollama не настроена или недоступна: запусти её и проверь подключение в Настройки → Ассистент."


# ---------- хранение настроек из приложения ----------

def load_overrides(conn: sqlite3.Connection | None) -> dict[str, dict[str, str]]:
    if conn is None:
        return {}
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (META_KEY,)).fetchone()
    try:
        data = json.loads(row["value"]) if row else {}
    except ValueError:
        data = {}
    return {n: {k: str(v) for k, v in (data.get(n) or {}).items() if isinstance(v, str)} for n in NAMES}


def save_overrides(conn: sqlite3.Connection, ov: dict[str, dict[str, str]]) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (META_KEY, json.dumps(ov, ensure_ascii=False)))


def _pick(ov: dict[str, dict[str, str]] | None, section: str, key: str, env_value: str) -> str:
    v = ((ov or {}).get(section) or {}).get(key, "").strip()
    return v or env_value


def cloud_backend(ov: dict[str, dict[str, str]] | None = None) -> Backend:
    kind = (_pick(ov, "cloud", "provider", _env("ASSISTANT_CLOUD_PROVIDER", "anthropic"))).lower()
    if kind == "anthropic":
        return Backend(
            "cloud", "anthropic",
            _pick(ov, "cloud", "base_url", _env("ASSISTANT_CLOUD_BASE_URL", "https://api.anthropic.com")),
            _pick(ov, "cloud", "api_key", _env("ANTHROPIC_API_KEY") or _env("ASSISTANT_CLOUD_API_KEY")),
            _pick(ov, "cloud", "model", _env("ASSISTANT_CLOUD_MODEL", "claude-sonnet-5-5")),
        )
    return Backend(
        "cloud", "openai",
        _pick(ov, "cloud", "base_url", _env("ASSISTANT_CLOUD_BASE_URL", "https://api.openai.com/v1")),
        _pick(ov, "cloud", "api_key", _env("ASSISTANT_CLOUD_API_KEY") or _env("OPENAI_API_KEY")),
        _pick(ov, "cloud", "model", _env("ASSISTANT_CLOUD_MODEL")),
    )


def local_backend(ov: dict[str, dict[str, str]] | None = None) -> Backend:
    return Backend(
        "local", "openai",
        _pick(ov, "local", "url", _env("ASSISTANT_LOCAL_URL", "http://127.0.0.1:11434/v1")).rstrip("/"),
        "",
        _pick(ov, "local", "model", _env("ASSISTANT_LOCAL_MODEL")),
    )


def agent_backend(ov: dict[str, dict[str, str]] | None = None) -> Backend:
    return Backend(
        "agent", "openai",
        _pick(ov, "agent", "url", _env("ASSISTANT_AGENT_URL")).rstrip("/"),
        _pick(ov, "agent", "token", _env("ASSISTANT_AGENT_TOKEN")),
        _pick(ov, "agent", "model", _env("ASSISTANT_AGENT_MODEL")),
    )


def get_backend(name: str, ov: dict[str, dict[str, str]] | None = None) -> Backend:
    return {"cloud": cloud_backend, "agent": agent_backend}.get(name, local_backend)(ov)


# ---------- проверка адресов ----------

def validate_url(section: str, url: str) -> str | None:
    """Возвращает текст ошибки или None. Сервер сам ходит по этим адресам, поэтому они ограничены:
    облако — только HTTPS (или свой компьютер), локальные — только свой компьютер и частные сети."""
    from .. import security  # поздний импорт: избегаем циклов

    try:
        u = urlsplit(url)
        host = u.hostname or ""
        u.port  # noqa: B018  (проверка корректности порта)
    except ValueError:
        return "Некорректный адрес"
    if u.scheme not in ("http", "https") or not host or u.username or u.password:
        return "Нужен адрес вида http://127.0.0.1:11434/v1 (без логина и пароля)"
    if section == "cloud":
        if u.scheme != "https" and host not in ("127.0.0.1", "localhost", "::1"):
            return "Облачный провайдер должен быть доступен по https://"
        return None
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_link_local or ip.is_multicast or ip.is_unspecified:  # в том числе 169.254.169.254 (метаданные облачных VM)
            return "Этот адрес не подходит"
    except ValueError:
        pass
    if not security.host_allowed(host):
        return "Локальный адрес должен вести на этот ПК или в частную сеть (localhost, 192.168.x.x, *.local, *.ts.net)"
    return None


def mask_secret(value: str) -> str:
    return ("••••" + value[-4:]) if len(value) >= 8 else ("••••" if value else "")


def public_view(conn: sqlite3.Connection | None) -> dict[str, Any]:
    """Настройки для экрана подключения: без секретов."""
    ov = load_overrides(conn)
    c, l, a = cloud_backend(ov), local_backend(ov), agent_backend(ov)
    return {
        "cloud": {
            "provider": c.kind, "baseUrl": c.base_url, "model": c.model, "hasKey": bool(c.api_key), "keyHint": mask_secret(c.api_key),
            "keySource": "app" if (ov["cloud"].get("api_key")) else ("env" if c.api_key else "none"),
        },
        "local": {"url": l.base_url, "model": l.model},
        "agent": {"url": a.base_url, "model": a.model, "hasToken": bool(a.api_key), "tokenHint": mask_secret(a.api_key)},
    }
