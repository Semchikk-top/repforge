"""Скользящие лимиты в памяти процесса (сервис рассчитан на один процесс)."""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class Limiter:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.hits: dict[tuple[str, str], deque] = defaultdict(deque)
        self.lock = threading.Lock()
        self.ops = 0

    def allow(self, bucket: str, key: str, limit: int, window_s: float) -> bool:
        now = self.clock()
        with self.lock:
            dq = self.hits[(bucket, key)]
            while dq and dq[0] <= now - window_s:
                dq.popleft()
            if len(dq) >= limit:
                return False
            dq.append(now)
            self.ops += 1
            if self.ops % 2000 == 0:  # не копим ключи тех, кто давно ушёл
                for k in [k for k, v in self.hits.items() if not v or v[-1] <= now - 86400]:
                    del self.hits[k]
            return True
