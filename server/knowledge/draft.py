"""Черновик по кнопке: локальная модель получает только поданный текст и должна подкрепить каждое утверждение цитатой."""
from __future__ import annotations

import dataclasses
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from .checks import check_all
from .rules import load_rules
from .sources import ID, KnowledgeError, _read_json, _write_json, get_source, load_snapshot

PROMPT_VERSION = 1
MAX_FRAGMENT = 12_000   # символов текста за один запрос: больше локальная модель держит плохо
CARD_ID = re.compile(r"^seed-\d{3}$")

Ask = Callable[[str, str], Awaitable[str]]  # (system, user) -> текст ответа модели


def system_prompt(kind: str, lang: str) -> str:
    fields = ('{"title": "...", "summary": "...", "points": ["...", "..."]}' if kind == "principle" else
              '{"summary": "...", "primaryMuscles": ["id"], "secondaryMuscles": ["id"], "function": "...", "cues": ["..."], "mistakes": ["..."], "swapNote": "..."}')
    return (
        "Ты помогаешь составлять образовательную справочную заметку по фрагменту открытого источника.\n"
        "ПРАВИЛА:\n"
        "1. Используй ТОЛЬКО поданный текст. Ничего не добавляй от себя и из общих знаний.\n"
        "2. К КАЖДОМУ утверждению приложи цитату-основание: точную выдержку из поданного текста, слово в слово, на языке источника, 15–400 знаков.\n"
        "3. Если текст не подтверждает поле, оставь его пустым (пустая строка или пустой список). Придумывать нельзя.\n"
        "4. Пиши на русском простыми словами, коротко. Не давай медицинских советов; не упоминай лекарства, добавки, диеты, диагнозы и лечение.\n"
        "5. Названия мышц бери только из списка id, который дан в запросе.\n"
        + ("6. Источник на английском: переведи на русский, а в поле terms перечисли все термины с твоим переводом, чтобы человек их сверил.\n" if lang != "ru" else "")
        + "Ответ: ТОЛЬКО один JSON-объект без пояснений и без markdown:\n"
        f'{{"fields": {fields}, "claims": [{{"field": "имя поля", "item": номер пункта списка или null, "text": "утверждение", "quote": "цитата из текста"}}], "terms": [{{"src": "термин", "ru": "перевод"}}]}}'
    )


def user_prompt(kind: str, target: str, title: str, fragment: str, muscles: list[dict[str, Any]], exercise_name: str | None) -> str:
    what = f"принцип «{target}»" if kind == "principle" else f"карточку упражнения «{exercise_name or target}»"
    head = f"Составь {what}.\nИсточник: {title}\n"
    if kind == "card":
        head += "Допустимые id мышц (id: название):\n" + "\n".join(f"{m['id']}: {m['name']}" for m in muscles) + "\n"
    return head + "\nТЕКСТ ИСТОЧНИКА:\n<<<\n" + fragment + "\n>>>"


def extract_json(text: str) -> dict[str, Any]:
    """Модели любят оборачивать JSON в ```json или пояснения: берём внешний объект и разбираем его."""
    t = re.sub(r"```(?:json)?", "", text)
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        raise KnowledgeError("Модель не вернула JSON. Попробуй ещё раз или возьми другую модель.")
    try:
        data = json.loads(t[a : b + 1])
    except ValueError as e:
        raise KnowledgeError(f"Модель вернула неверный JSON ({e}). Попробуй ещё раз или возьми другую модель.") from e
    if not isinstance(data, dict):
        raise KnowledgeError("Модель вернула не объект JSON.")
    return data


def draft_path(root: Path, kind: str, target: str) -> Path:
    return root / "drafts" / f"{kind}-{target}.json"


def load_muscles(root: Path) -> list[dict[str, Any]]:
    return _read_json(root / "muscles.json", [])


def fragment_of(text: str, start: int | None, end: int | None) -> tuple[str, int, int]:
    s = max(0, start or 0)
    e = min(len(text), end if end is not None else s + MAX_FRAGMENT)
    if end is None and len(text) - s > MAX_FRAGMENT:
        raise KnowledgeError(f"Текст источника длиннее {MAX_FRAGMENT} знаков ({len(text) - s} с позиции {s}). Укажи нужный кусок: --start N --end M.")
    if e <= s:
        raise KnowledgeError("Пустой фрагмент: проверь --start и --end.")
    return text[s:e], s, e


def recheck(root: Path, doc: dict[str, Any]) -> list[dict[str, str]]:
    """Те же проверки по файлу черновика: человек мог поправить текст руками, поэтому при принятии они гоняются заново."""
    rules = load_rules(root)
    text, sha = load_snapshot(root, doc["source"])
    if sha != doc.get("snapshotSha256"):
        raise KnowledgeError("Снимок источника изменился после создания черновика. Создай черновик заново.")
    frag = text[doc["range"][0] : doc["range"][1]]
    muscles = {m["id"] for m in load_muscles(root)}
    probs = check_all(doc["kind"], doc.get("fields") or {}, doc.get("claims"), rules=rules, muscles=muscles, source_text=frag, source=get_source(root, doc["source"]))
    return [p.as_dict() for p in probs]


async def make_draft(root: Path, *, kind: str, target: str, source_id: str, ask: Ask, model: str | Callable[[], str], backend: str,
                     start: int | None = None, end: int | None = None, lang: str = "ru", now: datetime | None = None) -> dict[str, Any]:
    if kind not in ("card", "principle"):
        raise KnowledgeError("kind: card или principle.")
    names = _read_json(root / "exercise_names.json", {})
    if kind == "card" and not CARD_ID.match(target):
        raise KnowledgeError("Для карточки укажи id стартового упражнения, например seed-001.")
    if kind == "card" and target not in names:
        raise KnowledgeError(f"Упражнения {target} нет среди стартовых (content/exercise_names.json).")
    if kind == "principle" and not ID.match(target):
        raise KnowledgeError("Для принципа укажи slug латиницей, например progressive-overload.")
    source = get_source(root, source_id)
    if not source:
        raise KnowledgeError(f"Источник {source_id} не найден. Сначала `content source add`.")
    text, sha = load_snapshot(root, source_id)
    frag, s, e = fragment_of(text, start, end)
    raw = await ask(system_prompt(kind, lang), user_prompt(kind, target, source["title"], frag, load_muscles(root), names.get(target)))
    data = extract_json(raw)
    fields = data.get("fields") if isinstance(data.get("fields"), dict) else {}
    claims = data.get("claims") if isinstance(data.get("claims"), list) else []
    terms = [t for t in (data.get("terms") or []) if isinstance(t, dict) and isinstance(t.get("src"), str) and isinstance(t.get("ru"), str)]
    allowed = ("title", "summary", "points") if kind == "principle" else ("summary", "primaryMuscles", "secondaryMuscles", "function", "cues", "mistakes", "swapNote")
    doc: dict[str, Any] = {
        "kind": kind, "target": target, "source": source_id, "snapshotSha256": sha, "range": [s, e],
        "model": model() if callable(model) else model, "backend": backend, "promptVersion": PROMPT_VERSION,
        "createdAt": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
        "status": "draft",   # статус выше draft ставит только человек
        "fields": {k: v for k, v in fields.items() if k in allowed},
        "claims": claims, "language": lang, "terms": terms,
        "termsChecked": None if lang == "ru" else False,
    }
    doc["checks"] = recheck(root, doc)
    _write_json(draft_path(root, kind, target), doc)
    return doc


def accept(root: Path, doc: dict[str, Any], *, replace: bool = False, today: str | None = None) -> Path:
    """Переносит черновик в content/exercises или content/principles со статусом draft. Ничего не публикует."""
    if doc.get("termsChecked") is False:
        raise KnowledgeError("Перевод: сначала сверь терминологию и подтверди командой `content review … --terms-ok`.")
    errors = recheck(root, doc)
    if errors:
        raise KnowledgeError("Черновик не прошёл проверки:\n" + "\n".join(f"  · {e['where'] or '-'}: {e['message']}" for e in errors))
    kind, target, f = doc["kind"], doc["target"], doc["fields"]
    path = root / ("principles" if kind == "principle" else "exercises") / f"{target}.json"
    version = 1
    if path.exists():
        if not replace:
            raise KnowledgeError(f"{path.name} уже есть. Чтобы заменить, добавь --replace (новая версия начнётся как draft).")
        version = int(_read_json(path, {}).get("contentVersion", 1)) + 1
    common = {"sources": [doc["source"]], "status": "draft", "reviewedAt": None, "contentVersion": version}
    if kind == "principle":
        out = {"id": target, "title": f["title"].strip(), "summary": f["summary"].strip(), "points": [x.strip() for x in f["points"]], **common}
    else:
        out = {"id": target, "summary": f["summary"].strip(), "primaryMuscles": f["primaryMuscles"], "secondaryMuscles": f["secondaryMuscles"],
               "function": f["function"].strip(), "cues": [x.strip() for x in f["cues"]], "mistakes": [x.strip() for x in f["mistakes"]],
               "swapNote": f["swapNote"].strip(), **common, "techniqueReview": None}
    _write_json(path, out)
    return path
