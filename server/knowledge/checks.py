"""Механические проверки черновика. Их делает скрипт, а не модель: модели в проверке цитат верить нельзя."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .rules import Rules
from .text import normalize

MIN_QUOTE = 15   # в нормализованных символах: короче цитата почти ничего не доказывает
MAX_QUOTE = 400  # длиннее значит, что модель переписала кусок источника целиком

CARD_SCALARS = ("summary", "function", "swapNote")
CARD_LISTS = ("cues", "mistakes")
MUSCLE_LISTS = ("primaryMuscles", "secondaryMuscles")
PRINCIPLE_SCALARS = ("title", "summary")


@dataclass
class Problem:
    code: str
    message: str
    where: str = ""

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


def _limit_names(kind: str, field: str) -> tuple[str, str | None]:
    """(лимит на длину текста, лимит на число пунктов)."""
    if kind == "principle":
        return {"title": ("title", None), "summary": ("pSummary", None), "points": ("point", "points")}[field]
    return {"summary": ("summary", None), "function": ("function", None), "swapNote": ("swapNote", None),
            "cues": ("cue", "cues"), "mistakes": ("mistake", "mistakes")}[field]


def _texts(kind: str, fields: dict[str, Any]) -> list[tuple[str, str]]:
    names = (*PRINCIPLE_SCALARS, "points") if kind == "principle" else (*CARD_SCALARS, *CARD_LISTS)
    out: list[tuple[str, str]] = []
    for n in names:
        v = fields.get(n)
        if isinstance(v, str):
            out.append((n, v))
        elif isinstance(v, list):
            out.extend((f"{n}[{i}]", x) for i, x in enumerate(v) if isinstance(x, str))
    return out


def check_fields(kind: str, fields: dict[str, Any], rules: Rules, muscles: set[str]) -> list[Problem]:
    """Обязательные поля, типы, длины, мышцы из справочника, запрещённые темы."""
    P: list[Problem] = []
    scalars = PRINCIPLE_SCALARS if kind == "principle" else CARD_SCALARS
    lists = ("points",) if kind == "principle" else CARD_LISTS
    for n in scalars:
        v = fields.get(n)
        if not isinstance(v, str) or not v.strip():
            P.append(Problem("missing_field", "поле пустое или отсутствует (в источнике может не быть основания)", n))
            continue
        lo, hi = rules.limits[_limit_names(kind, n)[0]]
        if not lo <= len(v.strip()) <= hi:
            P.append(Problem("bad_length", f"длина {len(v.strip())}, нужно от {lo} до {hi}", n))
    for n in lists:
        v = fields.get(n)
        text_key, count_key = _limit_names(kind, n)
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            P.append(Problem("missing_field", "ожидается список строк", n))
            continue
        lo, hi = rules.limits[count_key]  # type: ignore[index]
        if not lo <= len(v) <= hi:
            P.append(Problem("bad_count", f"пунктов {len(v)}, нужно от {lo} до {hi}", n))
        tlo, thi = rules.limits[text_key]
        for i, x in enumerate(v):
            if not tlo <= len(x.strip()) <= thi:
                P.append(Problem("bad_length", f"длина {len(x.strip())}, нужно от {tlo} до {thi}", f"{n}[{i}]"))
    if kind == "card":
        seen: set[str] = set()
        for n in MUSCLE_LISTS:
            v = fields.get(n)
            if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                P.append(Problem("missing_field", "ожидается список id мышц", n))
                continue
            if n == "primaryMuscles" and not v:
                P.append(Problem("missing_field", "нужна хотя бы одна основная мышца", n))
            for m in v:
                if m not in muscles:
                    P.append(Problem("unknown_muscle", f"мышцы «{m}» нет в справочнике (content/muscles.json)", n))
                if m in seen:
                    P.append(Problem("duplicate_muscle", f"мышца «{m}» указана дважды", n))
                seen.add(m)
    for where, text in _texts(kind, fields):
        for re_ in rules.forbidden:
            m = re_.search(text)
            if m:
                P.append(Problem("forbidden", f"запрещённая тема или обещание: «{m.group(0)}»", where))
                break
    return P


def _claim_key(c: dict[str, Any]) -> tuple[str, int | None]:
    item = c.get("item")
    return str(c.get("field", "")), item if isinstance(item, int) and not isinstance(item, bool) else None


def check_claims(kind: str, fields: dict[str, Any], claims: Any, source_text: str) -> list[Problem]:
    """Каждая цитата реально есть в источнике; каждое поле и каждый пункт списка подкреплены цитатой."""
    P: list[Problem] = []
    if not isinstance(claims, list) or not claims:
        return [Problem("no_claims", "нет ни одного утверждения с цитатой-основанием")]
    src = " " + normalize(source_text) + " "
    covered: set[tuple[str, int | None]] = set()
    for n, c in enumerate(claims):
        where = f"claims[{n}]"
        if not isinstance(c, dict) or not isinstance(c.get("quote"), str) or not isinstance(c.get("field"), str):
            P.append(Problem("bad_claim", "утверждение должно содержать field и quote", where))
            continue
        q = normalize(c["quote"])
        label = c["field"] + (f"[{c['item']}]" if isinstance(c.get("item"), int) else "")
        if len(q) < MIN_QUOTE:
            P.append(Problem("quote_short", f"цитата слишком короткая (меньше {MIN_QUOTE} знаков)", label))
        elif len(q) > MAX_QUOTE:
            P.append(Problem("quote_long", f"цитата длиннее {MAX_QUOTE} знаков: возьми главную фразу", label))
        elif f" {q} " not in src:
            P.append(Problem("quote_missing", "такой цитаты в источнике нет", label))
        else:
            covered.add(_claim_key(c))
    # покрытие: у каждого непустого поля и пункта должна быть подтверждённая цитата
    names = (*PRINCIPLE_SCALARS, "points") if kind == "principle" else (*CARD_SCALARS, *CARD_LISTS, *MUSCLE_LISTS)
    for n in names:
        v = fields.get(n)
        if isinstance(v, str) and v.strip():
            if (n, None) not in covered and (n, 0) not in covered:
                P.append(Problem("uncovered", "утверждение не подкреплено найденной цитатой", n))
        elif isinstance(v, list) and v:
            if n in MUSCLE_LISTS:
                if not any(k[0] == n for k in covered):
                    P.append(Problem("uncovered", "мышцы не подкреплены найденной цитатой", n))
                continue
            for i in range(len(v)):
                if (n, i) not in covered:
                    P.append(Problem("uncovered", "пункт не подкреплён найденной цитатой", f"{n}[{i}]"))
    return P


def check_source(source: dict[str, Any] | None, rules: Rules) -> list[Problem]:
    if not source:
        return [Problem("no_source", "источник не записан в content/sources.json")]
    out: list[Problem] = []
    if source.get("license") not in rules.licenses:
        out.append(Problem("license", f"лицензия «{source.get('license')}» не разрешена"))
    for f in ("title", "author", "url", "retrievedAt"):
        if not str(source.get(f, "")).strip():
            out.append(Problem("no_source", f"у источника не заполнено поле {f}"))
    return out


def check_all(kind: str, fields: dict[str, Any], claims: Any, *, rules: Rules, muscles: set[str], source_text: str, source: dict[str, Any] | None) -> list[Problem]:
    return [*check_source(source, rules), *check_fields(kind, fields, rules, muscles), *check_claims(kind, fields, claims, source_text)]
