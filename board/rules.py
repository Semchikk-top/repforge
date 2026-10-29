"""Правила приёма: форма снимка, допустимые периоды, правдоподобие чисел, ники.

Подпись доказывает только то, чьи это итоги, а не то, что они правдивы: клиент может прислать любые числа.
Поэтому сервис отсекает невозможное (больше подходов, чем часов в сутках), а остальное остаётся на совести
участника и жалоб. Это дружеский рейтинг в масштабе мира, а не соревнование с призами.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .canon import PROFILE_ID_RE, PUBLIC_KEY_RE

HERE = Path(__file__).parent
SEED: dict[str, dict[str, str]] = json.loads((HERE / "seed_exercises.json").read_text(encoding="utf-8"))

KINDS = ("week", "month", "all")
MAX_FUTURE_MS = 10 * 60 * 1000
MAX_AGE_MS = 10 * 60 * 1000          # снимок должен быть свежим: старый подписанный снимок друга не принимается
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ALL_FROM = "1970-01-01"


class Reject(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _num(v: Any, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if lo <= v <= hi and v == v else None


def _str(v: Any, lo: int, hi: int) -> str | None:
    if not isinstance(v, str) or not lo <= len(v) <= hi or re.search(r"[\u0000-\u001f\u007f]", v):
        return None
    return v


def _date(s: str) -> date | None:
    if not DATE_RE.match(s):
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def today_utc(now_ms: int) -> date:
    return datetime.fromtimestamp(now_ms / 1000, timezone.utc).date()


def classify_period(frm: str, to: str, now_ms: int) -> str:
    """Какой это период: неделя (пн–вс), календарный месяц или всё время. Иначе отказ.
    Периоды календарные, чтобы все участники попадали в одну таблицу (скользящие «4 недели» сюда не годятся)."""
    a, b = _date(frm), _date(to)
    if not a or not b or a > b:
        raise Reject("bad-period")
    today = today_utc(now_ms)
    near = lambda lo, hi: lo <= today + timedelta(days=1) and hi >= today - timedelta(days=1)  # часовые пояса: ±1 день
    if frm == ALL_FROM:
        if abs((b - today).days) <= 1:
            return "all"
        raise Reject("period-not-current")
    if (b - a).days == 6 and a.weekday() == 0:
        if near(a, b):
            return "week"
        raise Reject("period-not-current")
    if a.day == 1 and b == (a.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1):
        if near(a, b):
            return "month"
        raise Reject("period-not-current")
    raise Reject("bad-period")


def period_bounds(kind: str, now_ms: int) -> tuple[str, str]:
    """Текущий период по UTC-дате сервера: он подставляется, если клиент не указал свой."""
    t = today_utc(now_ms)
    if kind == "week":
        a = t - timedelta(days=t.weekday())
        return a.isoformat(), (a + timedelta(days=6)).isoformat()
    if kind == "month":
        a = t.replace(day=1)
        return a.isoformat(), ((a.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)).isoformat()
    return ALL_FROM, t.isoformat()


def validate_snapshot(raw: Any) -> dict:
    """Строгая проверка формы (как validateSnapshot на клиенте) и отбор упражнений каталога."""
    if not isinstance(raw, dict) or raw.get("v") != 1:
        raise Reject("malformed")
    profile_id, public_key = _str(raw.get("profileId"), 3, 40), _str(raw.get("publicKey"), 10, 140)
    nonce, sig = _str(raw.get("nonce"), 8, 64), _str(raw.get("sig"), 20, 200)
    gen = _num(raw.get("generatedAt"), 0, 8.64e15)
    if not profile_id or not PROFILE_ID_RE.match(profile_id) or not public_key or not PUBLIC_KEY_RE.match(public_key) or not nonce or not sig or gen is None:
        raise Reject("malformed")
    p = raw.get("period") if isinstance(raw.get("period"), dict) else {}
    frm, to = _str(p.get("from"), 10, 10), _str(p.get("to"), 10, 10)
    if not frm or not to:
        raise Reject("malformed")
    t, c = raw.get("totals"), raw.get("cardio")
    if not isinstance(t, dict) or not isinstance(c, dict) or not isinstance(raw.get("exercises"), list) or len(raw["exercises"]) > 200:
        raise Reject("malformed")
    workouts, sets, volume = _num(t.get("workouts"), 0, 1e6), _num(t.get("workSets"), 0, 1e7), _num(t.get("volumeKg"), 0, 1e10)
    km, sec, sess = _num(c.get("distanceKm"), 0, 1e6), _num(c.get("movingSec"), 0, 1e9), _num(c.get("sessions"), 0, 1e6)
    if None in (workouts, sets, volume, km, sec, sess):
        raise Reject("malformed")
    exercises = []
    for e in raw["exercises"]:
        if not isinstance(e, dict):
            raise Reject("malformed")
        key = _str(e.get("key"), 1, 120)
        e1, vol, ws = _num(e.get("e1rmKg"), 0, 3000), _num(e.get("volumeKg"), 0, 1e9), _num(e.get("workSets"), 0, 1e6)
        if not key or e1 is None or vol is None or ws is None:
            raise Reject("malformed")
        if key in SEED:  # чужие и самодельные упражнения в мировой рейтинг не идут: сравнивать их не с чем
            exercises.append({"key": key, "e1rm": e1, "volume": vol, "sets": ws})
    return {
        "profile_id": profile_id, "public_key": public_key, "generated_at": int(gen), "from": frm, "to": to,
        "workouts": int(workouts), "work_sets": int(sets), "volume": float(volume),
        "km": float(km), "sec": int(sec), "sessions": int(sess), "exercises": exercises,
    }


def check_plausible(s: dict, kind: str) -> None:
    """Отсекает физически невозможное. Пороги щедрые: честного атлета они не заденут."""
    a, b = date.fromisoformat(s["from"]), date.fromisoformat(s["to"])
    days = (b - a).days + 1 if kind != "all" else 36500
    if s["workouts"] > days * 4 or s["work_sets"] > days * 400 or s["sessions"] > days * 6:
        raise Reject("implausible")
    if s["work_sets"] and s["volume"] > s["work_sets"] * 8000:
        raise Reject("implausible")
    if s["volume"] > (days * 120_000 if kind != "all" else 5e8):
        raise Reject("implausible")
    if s["work_sets"] == 0 and s["volume"] > 0:
        raise Reject("implausible")
    if s["km"] > 0:
        if s["sec"] <= 0 or s["sessions"] <= 0 or s["km"] / (s["sec"] / 3600) > 60:  # быстрее 60 км/ч даже велосипед не едет
            raise Reject("implausible")
        if s["km"] > (days * 400 if kind != "all" else 5e5) or s["sec"] > days * 86400:
            raise Reject("implausible")
    if sum(e["sets"] for e in s["exercises"]) > s["work_sets"] or sum(e["volume"] for e in s["exercises"]) > s["volume"] + 1:
        raise Reject("inconsistent")
    seen = set()
    for e in s["exercises"]:
        if e["key"] in seen:
            raise Reject("inconsistent")
        seen.add(e["key"])
        if e["e1rm"] > 1500 or e["sets"] > days * 200 or (e["e1rm"] > 0 and e["volume"] <= 0):
            raise Reject("implausible")


# ---------- ники ----------
NICK_MIN, NICK_MAX = 2, 24
RESERVED = {"admin", "administrator", "moderator", "support", "system", "root", "anthropic", "claude", "админ", "администратор", "модератор", "поддержка"}
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "ё": "е"})
_BLOCKLIST: set[str] | None = None


def _blocklist() -> set[str]:
    """Список запрещённых слов задаёт владелец сервиса: BOARD_BLOCKLIST=/путь/к/файлу (одно слово на строку)."""
    global _BLOCKLIST
    if _BLOCKLIST is None:
        words: set[str] = set()
        path = os.environ.get("BOARD_BLOCKLIST", "")
        if path and os.path.exists(path):
            for line in Path(path).read_text(encoding="utf-8").splitlines():
                w = line.strip().casefold().translate(_LEET)
                if len(w) >= 3 and not w.startswith("#"):
                    words.add(w)
        _BLOCKLIST = words
    return _BLOCKLIST


def reset_blocklist() -> None:
    global _BLOCKLIST
    _BLOCKLIST = None


def clean_nick(raw: Any) -> str:
    """Ник: буквы, цифры, пробел и _-. · ; без ссылок, невидимых и управляющих символов."""
    if not isinstance(raw, str):
        raise Reject("bad-nick")
    n = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", raw)).strip()
    if not NICK_MIN <= len(n) <= NICK_MAX:
        raise Reject("bad-nick")
    for ch in n:
        cat = unicodedata.category(ch)
        if not (cat[0] in "LN" or cat in ("Mn", "Mc") or ch in " _-.·"):
            raise Reject("bad-nick")
    low = n.casefold()
    if re.search(r"https?|www|\.(com|ru|net|org|me|io|ua|by|kz)\b|t\.me|telegram|whatsapp", low) or re.fullmatch(r"[\d .\-_·]+", n):
        raise Reject("bad-nick")
    flat = re.sub(r"[ _\-.·]", "", low).translate(_LEET)
    if low in RESERVED or flat in RESERVED or any(w in flat for w in _blocklist()):
        raise Reject("bad-nick")
    return n


def resolve_period(kind: str, frm: str | None, now_ms: int) -> tuple[str, str]:
    """Границы периода для запроса таблицы: свои от клиента (его календарная неделя или месяц) или текущие по UTC."""
    if not frm:
        return period_bounds(kind, now_ms)
    a = _date(frm)
    if not a or abs((a - today_utc(now_ms)).days) > 800:
        raise Reject("bad-period")
    if kind == "all":
        return period_bounds("all", now_ms)
    if kind == "week" and a.weekday() == 0:
        return a.isoformat(), (a + timedelta(days=6)).isoformat()
    if kind == "month" and a.day == 1:
        return a.isoformat(), ((a.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)).isoformat()
    raise Reject("bad-period")
