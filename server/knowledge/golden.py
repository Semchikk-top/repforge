"""Золотой набор: прогон конвейера на карточках, которые уже проверены вручную, и подсчёт искажений.

Механика (цитата найдена или нет) считается скриптом. Смысл (не исказила ли модель мысль источника) оценивает человек
по листу оценки: без этого честной цифры не получить.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .draft import Ask, make_draft
from .sources import KnowledgeError, _read_json

DEFAULT_THRESHOLD = 0.10  # не более 10% утверждений требуют правки по смыслу
LINE = re.compile(r"^- \[(?P<mark>[ x~!])\] (?P<id>\S+) \| (?P<mech>ok|NO) \|")


def _reference(root: Path, kind: str, target: str, label: str) -> str:
    ref = _read_json(root / ("principles" if kind == "principle" else "exercises") / f"{target}.json", {})
    m = re.match(r"^(\w+)(?:\[(\d+)\])?$", label)
    if not m or not isinstance(ref, dict):
        return ""
    v = ref.get(m.group(1))
    if isinstance(v, list) and m.group(2) is not None and int(m.group(2)) < len(v):
        v = v[int(m.group(2))]
    return v if isinstance(v, str) else ""


async def run_golden(root: Path, entries: list[dict[str, Any]], *, ask: Ask, model: Any, backend: str, out_dir: Path) -> tuple[Path, dict[str, int]]:
    """entries: [{kind, target, source, start, end, lang}]. Черновики не пишутся в content/drafts, только в out_dir."""
    if not entries:
        raise KnowledgeError("Набор пуст. Заполни content/golden/golden.json.")
    out_dir.mkdir(parents=True, exist_ok=True)
    lines = ["# Лист оценки золотого набора", "",
             "Для каждого утверждения поставь отметку вместо пробела в скобках:",
             "`[x]` верно, `[~]` нужна правка по смыслу, `[!]` искажено или не подтверждено источником.",
             "Колонка после id: `ok` — цитата найдена в источнике скриптом, `NO` — не найдена (считается как ошибка автоматически).", ""]
    total = ok = 0
    for e in entries:
        doc = await make_draft(root, kind=e["kind"], target=e["target"], source_id=e["source"], ask=ask, model=model, backend=backend,
                               start=e.get("start"), end=e.get("end"), lang=e.get("lang", "ru"))
        # make_draft пишет в content/drafts; для золотого набора это лишний файл
        p = root / "drafts" / f"{e['kind']}-{e['target']}.json"
        p.replace(out_dir / p.name)
        bad = {c["where"] for c in doc["checks"] if c["code"] in ("quote_missing", "quote_short", "quote_long")}
        lines += [f"## {e['kind']} {e['target']} (источник {e['source']})", ""]
        for i, c in enumerate(doc.get("claims") or []):
            if not isinstance(c, dict):
                continue
            label = f"{c.get('field')}" + (f"[{c['item']}]" if isinstance(c.get("item"), int) else "")
            mech = "NO" if label in bad else "ok"
            total += 1
            ok += mech == "ok"
            ref = _reference(root, e["kind"], e["target"], label)
            lines += [f"- [ ] {e['target']}#{i} | {mech} | {label}", f"    модель: {c.get('text', '')}", f"    цитата: {c.get('quote', '')}"]
            if ref:
                lines.append(f"    проверенный текст: {ref}")
        lines.append("")
    sheet = out_dir / "sheet.md"
    sheet.write_text("\n".join(lines), encoding="utf-8")
    return sheet, {"claims": total, "quoteFound": ok}


def score_sheet(text: str, threshold: float = DEFAULT_THRESHOLD) -> dict[str, Any]:
    """Утверждение требует правки, если человек отметил [~] или [!], либо скрипт не нашёл цитату (даже при отметке [x])."""
    rows = [m for line in text.splitlines() if (m := LINE.match(line))]
    if not rows:
        raise KnowledgeError("В листе нет ни одного утверждения: проверь файл.")
    unmarked = sum(1 for m in rows if m["mark"] == " ")
    if unmarked:
        raise KnowledgeError(f"Не размечено утверждений: {unmarked} из {len(rows)}. Поставь [x], [~] или [!] у каждого.")
    need = sum(1 for m in rows if m["mark"] in ("~", "!") or m["mech"] == "NO")
    rate = need / len(rows)
    return {"total": len(rows), "ok": len(rows) - need, "changes": sum(1 for m in rows if m["mark"] == "~"),
            "distorted": sum(1 for m in rows if m["mark"] == "!"), "quoteMissing": sum(1 for m in rows if m["mech"] == "NO"),
            "needFix": need, "rate": rate, "threshold": threshold, "passed": rate <= threshold}
