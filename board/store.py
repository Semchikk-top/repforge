"""SQLite-хранилище сервиса. Хранится минимум: ключ, ник и агрегаты за период. Никаких тренировок, дат подходов и маршрутов."""
from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
  profile_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, nick TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','hidden','banned'))
);
CREATE TABLE IF NOT EXISTS snapshots (
  profile_id TEXT NOT NULL, kind TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  generated_at INTEGER NOT NULL, workouts INTEGER NOT NULL, work_sets INTEGER NOT NULL, volume_kg REAL NOT NULL,
  cardio_km REAL NOT NULL, cardio_sec INTEGER NOT NULL, cardio_sessions INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind, period_from)
);
CREATE INDEX IF NOT EXISTS snap_vol ON snapshots (kind, period_from, volume_kg);
CREATE INDEX IF NOT EXISTS snap_sets ON snapshots (kind, period_from, work_sets);
CREATE INDEX IF NOT EXISTS snap_km ON snapshots (kind, period_from, cardio_km);
CREATE TABLE IF NOT EXISTS ex_stats (
  profile_id TEXT NOT NULL, kind TEXT NOT NULL, period_from TEXT NOT NULL, ex_key TEXT NOT NULL,
  e1rm REAL NOT NULL, volume REAL NOT NULL, sets INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind, period_from, ex_key)
);
CREATE INDEX IF NOT EXISTS ex_e1 ON ex_stats (kind, period_from, ex_key, e1rm);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports (
  target_id TEXT NOT NULL, reporter_id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (target_id, reporter_id)
);
"""


def data_dir() -> Path:
    d = Path(os.environ.get("BOARD_DATA_DIR") or Path.home() / "board-data")
    d.mkdir(parents=True, exist_ok=True)
    try:
        d.chmod(0o700)
    except OSError:
        pass
    return d


class Store:
    def __init__(self, path: str | Path | None = None):
        p = str(path) if path else str(data_dir() / "board.db")
        self.db = sqlite3.connect(p, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            if p != ":memory:":
                self.db.execute("PRAGMA journal_mode=WAL")
                try:
                    os.chmod(p, 0o600)
                except OSError:
                    pass
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.executescript(SCHEMA)

    def q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        with self.lock:
            return self.db.execute(sql, args).fetchone()

    def run(self, sql: str, args: tuple = ()) -> int:
        with self.lock:
            return self.db.execute(sql, args).rowcount

    def tx(self):
        return _Tx(self)

    # ---- общие операции ----
    def remember_nonce(self, key: str, now_ms: int) -> bool:
        """False — такой nonce уже был (повтор запроса)."""
        with self.lock:
            try:
                self.db.execute("INSERT INTO nonces (nonce, seen_at) VALUES (?, ?)", (key, now_ms))
            except sqlite3.IntegrityError:
                return False
            if now_ms % 17 == 0:  # чистим изредка: старше часа повтор всё равно не пройдёт проверку свежести
                self.db.execute("DELETE FROM nonces WHERE seen_at < ?", (now_ms - 3_600_000,))
            return True

    def delete_profile_data(self, pid: str) -> None:
        with self.tx():
            self.db.execute("DELETE FROM snapshots WHERE profile_id=?", (pid,))
            self.db.execute("DELETE FROM ex_stats WHERE profile_id=?", (pid,))
            self.db.execute("DELETE FROM reports WHERE target_id=? OR reporter_id=?", (pid, pid))

    def stats(self) -> dict:
        r = self.one("SELECT COUNT(*) n, SUM(status='hidden') h, SUM(status='banned') b FROM profiles")
        return {"profiles": r["n"], "hidden": r["h"] or 0, "banned": r["b"] or 0,
                "snapshots": self.one("SELECT COUNT(*) n FROM snapshots")["n"], "reports": self.one("SELECT COUNT(*) n FROM reports")["n"]}


class _Tx:
    def __init__(self, s: Store):
        self.s = s

    def __enter__(self):
        self.s.lock.acquire()
        self.s.db.execute("BEGIN IMMEDIATE")
        return self

    def __exit__(self, et, ev, tb):
        try:
            self.s.db.execute("ROLLBACK" if et else "COMMIT")
        finally:
            self.s.lock.release()
        return False
