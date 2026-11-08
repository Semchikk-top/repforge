"""Живая синхронизация: сервер сообщает подключённым устройствам, что в базе появилась новая ревизия (seq).

Это только сигнал «есть новые изменения»: сами записи по-прежнему забирает обычный POST /api/sync. Поэтому канал
можно терять без последствий: клиент откатывается на опрос. sync() работает в пуле потоков, а подписчики живут в
event loop, так что публикация идёт через call_soon_threadsafe.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

# Сколько устройств могут держать канал одновременно: личный сервер, но защита от утечки соединений нужна.
MAX_SUBSCRIBERS = 50
# Как часто посылать «пинг», чтобы NAT, прокси и сам клиент замечали обрыв.
HEARTBEAT_SEC = 20.0
# Соединение живёт ограниченное время: токен перепроверяется при каждом переподключении, а зависшие каналы не копятся.
MAX_SEC = 600.0


class SyncBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]] = set()

    def count(self) -> int:
        with self._lock:
            return len(self._subs)

    def subscribe(self, loop: asyncio.AbstractEventLoop, q: asyncio.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subs.add((loop, q))

    def unsubscribe(self, loop: asyncio.AbstractEventLoop, q: asyncio.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subs.discard((loop, q))

    def publish(self, seq: int, by: str) -> None:
        """Вызывается из любого потока после записи изменений. by — устройство, приславшее их."""
        with self._lock:
            subs = list(self._subs)
        for loop, q in subs:
            try:
                loop.call_soon_threadsafe(_offer, q, {"seq": seq, "by": by})
            except RuntimeError:  # цикл событий уже закрыт: подписчик мёртв
                self.unsubscribe(loop, q)


def _offer(q: asyncio.Queue[dict[str, Any]], item: dict[str, Any]) -> None:
    """Кладёт событие; если очередь забита, самое старое выбрасывается: важна только последняя ревизия."""
    if q.full():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
    q.put_nowait(item)
