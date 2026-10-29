"""Запросы на подключение с телефона: телефон просит, человек подтверждает на ПК.

Без подтверждения код не выдаётся никому: иначе любой в сети мог бы подключить своё устройство.
Запросы живут только в памяти и недолго."""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Callable

from .db import sanitize_name

REQUEST_TTL = 120   # секунд на подтверждение
MAX_PENDING = 5     # одновременно ожидающих запросов


def now() -> float:
    return time.time()


@dataclass
class Req:
    id: str
    device_id: str
    name: str
    pin: str
    created: float
    ip: str = ""
    status: str = "pending"  # pending | approved | denied | delivered
    code: str | None = None


def clean_name(name: str) -> str:
    return sanitize_name(name)


@dataclass
class Requests:
    items: dict[str, Req] = field(default_factory=dict)

    def _gc(self) -> None:
        t = now()
        for rid in [k for k, r in self.items.items() if t - r.created > REQUEST_TTL * 2]:
            del self.items[rid]

    def _expired(self, r: Req) -> bool:
        return r.status == "pending" and now() - r.created > REQUEST_TTL

    def create(self, device_id: str, name: str, ip: str = "") -> Req | None:
        self._gc()
        pending = [r for r in self.items.values() if r.status == "pending" and not self._expired(r)]
        if len(pending) >= MAX_PENDING:
            return None
        # повторный запрос того же устройства заменяет предыдущий
        for r in pending:
            if r.device_id == device_id:
                del self.items[r.id]
        r = Req(secrets.token_urlsafe(16), device_id, clean_name(name), f"{secrets.randbelow(10000):04d}", now(), ip=ip[:64])
        self.items[r.id] = r
        return r

    def pending(self) -> list[Req]:
        self._gc()
        return sorted((r for r in self.items.values() if r.status == "pending" and not self._expired(r)), key=lambda r: r.created)

    def decide(self, rid: str, approve: bool, mint_code: Callable[[], str]) -> bool:
        r = self.items.get(rid)
        if not r or r.status != "pending" or self._expired(r):
            return False
        if approve:
            r.code, r.status = mint_code(), "approved"
        else:
            r.status = "denied"
        return True

    def poll(self, rid: str) -> dict:
        r = self.items.get(rid)
        if not r:
            return {"status": "expired"}
        if self._expired(r):
            return {"status": "expired"}
        if r.status == "approved":
            code, r.code, r.status = r.code, None, "delivered"  # код отдаётся один раз
            return {"status": "approved", "code": code}
        return {"status": "done" if r.status == "delivered" else r.status}

    def cancel(self, rid: str) -> None:
        self.items.pop(rid, None)
