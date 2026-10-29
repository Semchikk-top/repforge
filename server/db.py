"""SQLite-хранилище: устройства, коды сопряжения и сущности с порядковым номером изменений."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any, Iterable

DATA_DIR = Path(os.environ.get("WORKOUT_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "workout.db"

ALLOWED_TABLES = {"exercises", "workouts", "templates", "tracks", "body", "programs", "profile", "game"}
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # без похожих символов
CODE_TTL_SEC = 10 * 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pair_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entities (
    table_name TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (table_name, id)
);
CREATE INDEX IF NOT EXISTS idx_entities_seq ON entities(seq);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def sanitize_name(name: str, limit: int = 60) -> str:
    """Имя устройства приходит от клиента и потом выводится в окне подтверждения и в терминале.
    Убираем управляющие символы (в том числе escape-последовательности терминала), невидимые
    форматирующие (RLO и т.п. для подмены текста) и угловые скобки."""
    cleaned = "".join(ch for ch in name if unicodedata.category(ch) not in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp") and ch not in "<>")
    return re.sub(r"\s+", " ", cleaned).strip()[:limit] or "Устройство"


class _Conn(sqlite3.Connection):
    """Соединение одного потока. Блокировка нужна для вложенных BEGIN/COMMIT в `tx`;
    между потоками соединения больше не разделяются (см. `_ConnPool`)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.lock = threading.RLock()

    def execute(self, *args, **kwargs):
        with self.lock:
            return super().execute(*args, **kwargs)

    def executescript(self, *args, **kwargs):
        with self.lock:
            return super().executescript(*args, **kwargs)

    def backup(self, *args, **kwargs):
        with self.lock:
            return super().backup(*args, **kwargs)


class _ConnPool:
    """Прокси соединения: у каждого потока свой `sqlite3.Connection`.

    FastAPI выполняет синхронные обработчики в пуле потоков. Одно общее соединение
    с `check_same_thread=False` позволяло потокам вклиниваться в чужие `BEGIN`/`COMMIT`:
    при конкурентной синхронизации запросы получали 401, а `meta`/`seq` иногда читались
    как `None`. В режиме WAL SQLite допускает несколько соединений: `BEGIN IMMEDIATE`
    сериализует писателей, чтения идут параллельно. Соединение создаётся лениво на поток,
    а схема и начальные строки `meta` инициализируются один раз главным соединением.
    """

    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        _initialize(self._connection())

    def _connection(self) -> _Conn:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = _open(self.path)
            self._local.conn = conn
        return conn

    @property
    def lock(self) -> threading.RLock:
        return self._connection().lock

    def execute(self, *args, **kwargs):
        return self._connection().execute(*args, **kwargs)

    def executescript(self, *args, **kwargs):
        return self._connection().executescript(*args, **kwargs)

    def backup(self, *args, **kwargs):
        return self._connection().backup(*args, **kwargs)

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def __getattr__(self, name: str):
        return getattr(self._connection(), name)


def _open(p: Path) -> _Conn:
    conn = sqlite3.connect(p, timeout=30, isolation_level=None, check_same_thread=False, factory=_Conn)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")  # ждать чужую запись, а не падать с "database is locked"
    return conn


def _initialize(conn: _Conn) -> None:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('seq', '0')")
    conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('instance', ?)", (secrets.token_hex(8),))


def connect(path: Path | None = None) -> _ConnPool:
    p = path or DB_PATH
    # данные (журнал тренировок, хэши токенов, копии) доступны только владельцу
    p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(p.parent, 0o700)
    except OSError:
        pass
    pool = _ConnPool(p)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return pool


def instance_id(conn: sqlite3.Connection) -> str:
    """Неизменный идентификатор этого сервера: по нему проверяем, что адрес ведёт именно сюда."""
    return conn.execute("SELECT value FROM meta WHERE key = 'instance'").fetchone()["value"]


@contextmanager
def tx(conn: sqlite3.Connection):
    with getattr(conn, "lock", nullcontext()):  # вся транзакция целиком под блокировкой соединения
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise


# ---------- сопряжение ----------

def normalize_pair_code(code: str) -> str:
    """Код показывают с дефисом, а с телефона он может прийти с любым тире или пробелами."""
    return re.sub(r"[\s\-‐‑‒–—―]+", "", code.strip().upper())


def pair_code_state(conn: sqlite3.Connection, code: str) -> str:
    """Состояние кода для диагностики: not_found | used | expired | active."""
    row = conn.execute(
        "SELECT used, expires_at FROM pair_codes WHERE code_hash = ?", (sha(normalize_pair_code(code)),)
    ).fetchone()
    if not row:
        return "not_found"
    if row["used"]:
        return "used"
    if row["expires_at"] < int(time.time()):
        return "expired"
    return "active"


def create_pair_code(conn: sqlite3.Connection) -> str:
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    now = int(time.time())
    with tx(conn):
        conn.execute("DELETE FROM pair_codes WHERE expires_at < ? OR used = 1", (now,))
        conn.execute("INSERT INTO pair_codes(code_hash, expires_at) VALUES (?, ?)", (sha(code), now + CODE_TTL_SEC))
        # не копим неограниченно: оставляем 20 самых свежих неиспользованных кодов
        conn.execute(
            "DELETE FROM pair_codes WHERE rowid NOT IN (SELECT rowid FROM pair_codes ORDER BY expires_at DESC LIMIT 20)"
        )
    return code


def redeem_pair_code(conn: sqlite3.Connection, code: str, device_id: str, name: str) -> str | None:
    """Возвращает токен устройства или None, если код неверный/просрочен/использован."""
    code = normalize_pair_code(code)
    now = int(time.time())
    with tx(conn):
        row = conn.execute(
            "SELECT code_hash FROM pair_codes WHERE code_hash = ? AND used = 0 AND expires_at >= ?",
            (sha(code), now),
        ).fetchone()
        if not row:
            return None
        conn.execute("UPDATE pair_codes SET used = 1 WHERE code_hash = ?", (row["code_hash"],))
        token = secrets.token_urlsafe(32)
        # повторное сопряжение того же устройства заменяет его токен
        conn.execute(
            "INSERT INTO devices(id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, token_hash=excluded.token_hash, revoked=0, last_seen=excluded.last_seen",
            (device_id, sanitize_name(name), sha(token), now, now),
        )
    return token


def device_by_token(conn: sqlite3.Connection, token: str) -> sqlite3.Row | None:
    row = conn.execute("SELECT * FROM devices WHERE token_hash = ? AND revoked = 0", (sha(token),)).fetchone()
    if row:
        conn.execute("UPDATE devices SET last_seen = ? WHERE id = ?", (int(time.time()), row["id"]))
    return row


# ---------- синхронизация ----------

def _next_seq(conn: sqlite3.Connection) -> int:
    conn.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'seq'")
    return int(conn.execute("SELECT value FROM meta WHERE key = 'seq'").fetchone()["value"])


def current_seq(conn: sqlite3.Connection) -> int:
    return int(conn.execute("SELECT value FROM meta WHERE key = 'seq'").fetchone()["value"])


def apply_entities(conn: sqlite3.Connection, items: Iterable[dict[str, Any]]) -> set[tuple[str, str]]:
    """Принимает сущности от устройства. Побеждает запись с большим updatedAt,
    при равенстве — с большим deviceId (чтобы результат не зависел от порядка прихода)."""
    accepted: set[tuple[str, str]] = set()
    for it in items:
        cur = conn.execute(
            "SELECT updated_at, device_id FROM entities WHERE table_name = ? AND id = ?", (it["table"], it["id"])
        ).fetchone()
        if cur and (cur["updated_at"], cur["device_id"]) >= (it["updatedAt"], it["deviceId"]):
            continue
        seq = _next_seq(conn)
        conn.execute(
            "INSERT INTO entities(table_name, id, updated_at, device_id, deleted, data, seq) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(table_name, id) DO UPDATE SET updated_at=excluded.updated_at, device_id=excluded.device_id, "
            "deleted=excluded.deleted, data=excluded.data, seq=excluded.seq",
            (it["table"], it["id"], it["updatedAt"], it["deviceId"], 1 if it["deleted"] else 0, json.dumps(it["data"], ensure_ascii=False), seq),
        )
        accepted.add((it["table"], it["id"]))
    return accepted


def entities_since(conn: sqlite3.Connection, since: int, exclude: set[tuple[str, str]], limit: int = 2000) -> tuple[list[dict[str, Any]], bool, int]:
    rows = conn.execute("SELECT * FROM entities WHERE seq > ? ORDER BY seq LIMIT ?", (since, limit + 1)).fetchall()
    more = len(rows) > limit
    page = rows[:limit]
    last_seq = page[-1]["seq"] if page else since
    out = []
    for r in page:
        if (r["table_name"], r["id"]) in exclude:
            continue
        out.append(
            {
                "table": r["table_name"],
                "id": r["id"],
                "updatedAt": r["updated_at"],
                "deviceId": r["device_id"],
                "deleted": bool(r["deleted"]),
                "data": json.loads(r["data"]),
                "seq": r["seq"],
            }
        )
    return out, more, last_seq
