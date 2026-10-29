"""Модерация: только из командной строки на самом сервере (веб-админки нет, значит и атаковать там нечего)."""
from __future__ import annotations

import re
import time

from .store import Store

PID_RE = re.compile(r"p_[A-Za-z0-9_-]{22}")


def _pid(store: Store, ref: str) -> str:
    """Принимает полный id или короткий тег из таблицы (#ab12); тег должен быть однозначным."""
    ref = ref.strip().lstrip("#")
    if PID_RE.fullmatch(ref):
        return ref
    rows = store.q("SELECT profile_id FROM profiles WHERE substr(profile_id, 3, ?) = ?", (len(ref), ref))
    if len(rows) != 1:
        raise SystemExit(f"«{ref}» подходит {len(rows)} участникам: укажите полный id (команда find)")
    return rows[0]["profile_id"]


def find(store: Store, text: str) -> list[dict]:
    like = f"%{text.strip().lstrip('#')}%"
    rows = store.q("SELECT profile_id, nick, status, created_at FROM profiles WHERE nick LIKE ? OR profile_id LIKE ? ORDER BY created_at DESC LIMIT 50", (like, like))
    return [dict(r) for r in rows]


def reports(store: Store) -> list[dict]:
    rows = store.q("""SELECT p.profile_id, p.nick, p.status, COUNT(*) n, GROUP_CONCAT(DISTINCT r.reason) reasons
                      FROM reports r JOIN profiles p ON p.profile_id=r.target_id GROUP BY p.profile_id ORDER BY n DESC LIMIT 100""")
    return [dict(r) for r in rows]


def set_status(store: Store, ref: str, status: str) -> str:
    """ok — вернуть в таблицу, hidden — скрыть, banned — скрыть и не пускать (итоги стираются)."""
    pid = _pid(store, ref)
    if status not in ("ok", "hidden", "banned"):
        raise SystemExit("статус: ok, hidden или banned")
    if not store.run("UPDATE profiles SET status=?, updated_at=? WHERE profile_id=?", (status, int(time.time() * 1000), pid)):
        raise SystemExit("такого участника нет")
    if status == "banned":
        store.delete_profile_data(pid)
    if status == "ok":
        store.run("DELETE FROM reports WHERE target_id=?", (pid,))
    return pid


def delete(store: Store, ref: str) -> str:
    """Стереть участника целиком. Он может вступить заново; чтобы не пускать, используйте ban."""
    pid = _pid(store, ref)
    store.delete_profile_data(pid)
    store.run("DELETE FROM profiles WHERE profile_id=?", (pid,))
    return pid
