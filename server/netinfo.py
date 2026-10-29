"""Определение адресов, по которым телефон может достучаться до этого сервера.

Каждый кандидат проверяется запросом /api/health: ответ должен содержать идентификатор именно этого сервера.
Так мы не предложим адрес, который ведёт «в никуда» или к чужому сервису."""
from __future__ import annotations

import asyncio
import json
import socket
import subprocess
from dataclasses import asdict, dataclass
from typing import Awaitable, Callable
from urllib.parse import urlsplit

import httpx

LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}


@dataclass
class Candidate:
    url: str
    kind: str  # configured | current | tailscale | lan
    secure: bool  # HTTPS: только по нему телефон сможет установить PWA
    reachable: bool

    def to_dict(self) -> dict:
        return asdict(self)


def _norm(url: str) -> str:
    return url.strip().rstrip("/")


def is_loopback(url: str) -> bool:
    try:
        return (urlsplit(url).hostname or "") in LOOPBACK
    except ValueError:
        return True


def run_cmd(args: list[str]) -> str:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=2.5).stdout
    except Exception:  # нет программы, нет прав, таймаут — просто нет данных
        return ""


def lan_ips() -> list[str]:
    """Основной адрес в локальной сети (без отправки пакетов: UDP-сокет только выбирает маршрут)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            ip = s.getsockname()[0]
        return [] if ip.startswith(("127.", "169.254.")) else [ip]
    except OSError:
        return []


def tailscale_urls(run: Callable[[list[str]], str] | None = None) -> list[str]:
    """HTTPS-адреса из `tailscale serve status`; запасной вариант — имя узла из `tailscale status`."""
    run = run or run_cmd
    urls: list[str] = []
    try:
        serve = json.loads(run(["tailscale", "serve", "status", "--json"]) or "{}")
        for host in (serve.get("Web") or {}):  # ключи вида "pc.tailnet.ts.net:443"
            name, _, port = host.rpartition(":")
            urls.append(f"https://{name}" if port in ("443", "") else f"https://{name}:{port}")
    except (ValueError, AttributeError):
        pass
    if not urls:
        try:
            st = json.loads(run(["tailscale", "status", "--json"]) or "{}")
            dns = (st.get("Self") or {}).get("DNSName", "").rstrip(".")
            if dns and st.get("BackendState") == "Running":
                urls.append(f"https://{dns}")
        except (ValueError, AttributeError):
            pass
    return urls


async def health_instance(url: str) -> str | None:
    """Вернуть instance сервера по адресу или None, если адрес не отвечает.

    Это не просто проверка доступности: CLI сравнивает instance с идентификатором
    своей БД и не создаёт код, если команда случайно запущена из старой копии проекта.
    """
    try:
        async with httpx.AsyncClient(timeout=1.8, verify=True) as c:
            r = await c.get(f"{url}/api/health")
        if r.status_code != 200:
            return None
        value = r.json().get("instance")
        return value if isinstance(value, str) and value else None
    except Exception:
        return None


def make_checker(instance: str) -> Callable[[str], Awaitable[bool]]:
    async def check(url: str) -> bool:
        return await health_instance(url) == instance
    return check


async def detect(
    instance: str,
    port: int,
    current_origin: str | None = None,
    public_url: str | None = None,
    run: Callable[[list[str]], str] | None = None,
    lan: Callable[[], list[str]] | None = None,
    check: Callable[[str], Awaitable[bool]] | None = None,
) -> list[Candidate]:
    # значения по умолчанию выбираем при вызове, чтобы их можно было подменить в тестах
    run, lan = run or run_cmd, lan or lan_ips
    check = check or make_checker(instance)
    raw: list[tuple[str, str]] = []
    if public_url:
        raw.append((_norm(public_url), "configured"))
    if current_origin and not is_loopback(current_origin):
        raw.append((_norm(current_origin), "current"))
    for u in await asyncio.to_thread(tailscale_urls, run):
        raw.append((_norm(u), "tailscale"))
    for ip in await asyncio.to_thread(lan):
        raw.append((f"http://{ip}:{port}", "lan"))

    seen: set[str] = set()
    items: list[tuple[str, str]] = []
    for url, kind in raw:
        if url and url not in seen:
            seen.add(url)
            items.append((url, kind))

    # проверяем все адреса параллельно (в том числе адрес текущего запроса: телефон может видеть сервер иначе, чем браузер на ПК)
    results = await asyncio.gather(*[check(u) for u, _ in items])
    return [Candidate(u, kind, u.startswith("https://"), bool(ok)) for (u, kind), ok in zip(items, results)]


def pick_best(cands: list[Candidate]) -> int | None:
    """Лучший: достижимый и с HTTPS; иначе первый достижимый; иначе None."""
    for i, c in enumerate(cands):
        if c.reachable and c.secure:
            return i
    for i, c in enumerate(cands):
        if c.reachable:
            return i
    return None
