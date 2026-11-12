"""Справочник «Зачем это» и «Почему так» для ассистента: чтение content/ из репозитория (только чтение).

Правила те же, что на клиенте: отдаётся только содержимое со статусом published. Черновики и непроверенное
ассистент не видит, пока владелец сам не включит предпросмотр (REPFORGE_CONTENT_PREVIEW=1), и тогда каждый ответ
помечен как черновик. Если в справочнике ничего нет, инструмент прямо об этом говорит: модель не должна
выдавать общий ответ за проверенный.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

NOT_FOUND = "В справочнике этого нет."


def content_dir() -> Path:
    """Папка content/. Можно переопределить REPFORGE_CONTENT_DIR (нужно тестам и нестандартной установке)."""
    env = os.environ.get("REPFORGE_CONTENT_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "content"


def _preview() -> bool:
    return os.environ.get("REPFORGE_CONTENT_PREVIEW") == "1"


def _norm(s: str) -> str:
    return s.lower().replace("ё", "е").strip()


def _read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _visible(item: Any) -> bool:
    return isinstance(item, dict) and (item.get("status") == "published" or _preview())


def _mark(item: dict[str, Any]) -> dict[str, Any]:
    """Пометка статуса: в обычном режиме её нет, потому что отдаётся только опубликованное."""
    return {} if item.get("status") == "published" else {"status": item.get("status"), "warning": "ЧЕРНОВИК: текст не проверен человеком, не выдавай его за проверенный"}


def _seed_names(root: Path) -> dict[str, str]:
    """id стартового упражнения → название. Файл генерирует `npm run content:build` из seed.ts, тест следит за актуальностью."""
    data = _read(root / "exercise_names.json")
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(data, dict) else {}


def _sources(root: Path, ids: list[Any]) -> list[dict[str, str]]:
    reg = _read(root / "sources.json")
    by_id = {s["id"]: s for s in reg if isinstance(s, dict) and isinstance(s.get("id"), str)} if isinstance(reg, list) else {}
    out = []
    for i in ids:
        s = by_id.get(i)
        if s:
            out.append({k: str(s.get(k, "")) for k in ("title", "author", "license", "url")})
    return out


def _muscle_names(root: Path, ids: list[Any]) -> list[str]:
    reg = _read(root / "muscles.json")
    names = {m["id"]: m["name"] for m in reg if isinstance(m, dict) and "id" in m and "name" in m} if isinstance(reg, list) else {}
    return [names.get(i, str(i)) for i in ids]


def get_exercise_card(name: str) -> dict[str, Any]:
    root = content_dir()
    names = _seed_names(root)
    q = _norm(str(name or ""))
    tokens = q.split()
    hits = [(i, n) for i, n in names.items() if tokens and all(t in _norm(n) for t in tokens)]
    exact = [h for h in hits if _norm(h[1]) == q]
    hits = exact or hits
    cards = []
    for ex_id, ex_name in sorted(hits, key=lambda h: h[1]):
        card = _read(root / "exercises" / f"{ex_id}.json")
        if _visible(card):
            cards.append((ex_name, card))
    if not cards:
        return {"found": False, "message": f"{NOT_FOUND} Карточки для «{name}» нет. Скажи об этом прямо; дальше можно дать общий ответ, но с пометкой, что он не из справочника и не проверен."}
    if len(cards) > 1:
        return {"found": False, "message": "Под запрос подходит несколько упражнений, уточни название.", "matches": [n for n, _ in cards]}
    ex_name, c = cards[0]
    out: dict[str, Any] = {
        "found": True,
        "exercise": ex_name,
        "summary": c.get("summary"),
        "primary_muscles": _muscle_names(root, c.get("primaryMuscles", [])),
        "secondary_muscles": _muscle_names(root, c.get("secondaryMuscles", [])),
        "function": c.get("function"),
        "cues": c.get("cues"),
        "common_mistakes": c.get("mistakes"),
        "how_to_swap": c.get("swapNote"),
        "sources": _sources(root, c.get("sources", [])),
        "reviewed_at": c.get("reviewedAt"),
        "technique_reviewed_by": c.get("techniqueReview"),
        "note": "Образовательная информация, не медицинская рекомендация. Отвечай по этим данным, ничего не добавляя от себя.",
    }
    out.update(_mark(c))
    return out


def _principles(root: Path) -> list[dict[str, Any]]:
    d = root / "principles"
    if not d.is_dir():
        return []
    items = [_read(p) for p in sorted(d.glob("*.json"))]
    return [p for p in items if _visible(p) and isinstance(p.get("id"), str)]


def get_principle(id: str = "") -> dict[str, Any]:
    root = content_dir()
    items = _principles(root)
    q = _norm(str(id or ""))
    pick = [p for p in items if _norm(p["id"]) == q] or [p for p in items if q and (q in _norm(p["id"]) or q in _norm(str(p.get("title", ""))))]
    if not pick:
        listing = [{"id": p["id"], "title": p.get("title")} for p in items]
        return {"found": False, "message": f"{NOT_FOUND} Такого принципа нет. Скажи об этом прямо; дальше можно дать общий ответ, но с пометкой, что он не из справочника и не проверен.", "available": listing}
    if len(pick) > 1:
        return {"found": False, "message": "Подходит несколько принципов, уточни.", "available": [{"id": p["id"], "title": p.get("title")} for p in pick]}
    p = pick[0]
    out: dict[str, Any] = {
        "found": True, "id": p["id"], "title": p.get("title"), "summary": p.get("summary"), "points": p.get("points"),
        "sources": _sources(root, p.get("sources", [])), "reviewed_at": p.get("reviewedAt"),
        "note": "Образовательная информация, не медицинская рекомендация. Отвечай по этим данным, ничего не добавляя от себя.",
    }
    out.update(_mark(p))
    return out
