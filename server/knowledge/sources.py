"""Реестр источников и снимки текста. Принимаются только открытые лицензии, остальное отклоняется."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date
from pathlib import Path

from .rules import load_rules
from .text import html_to_text

ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_BYTES = 2_000_000


class KnowledgeError(Exception):
    """Понятная человеку ошибка: печатается без стека."""


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def list_sources(root: Path) -> list[dict]:
    return _read_json(root / "sources.json", [])


def get_source(root: Path, source_id: str) -> dict | None:
    return next((s for s in list_sources(root) if s.get("id") == source_id), None)


def save_snapshot(root: Path, id: str, file: Path, day: str) -> str:
    """Читает файл, переводит в текст, сохраняет снимок и хэш. Возвращает хэш."""
    try:
        raw = file.read_bytes()
    except OSError as e:
        raise KnowledgeError(f"Не удалось прочитать файл {file}: {e.strerror or e}") from e
    if len(raw) > MAX_BYTES:
        raise KnowledgeError("Файл больше 2 МБ: возьми нужную главу, а не всю книгу.")
    text = raw.decode("utf-8", errors="replace")
    if file.suffix.lower() in (".html", ".htm"):
        text = html_to_text(text)
    text = text.strip()
    if len(text) < 200:
        raise KnowledgeError("В файле почти нет текста (меньше 200 символов): проверь, что сохранена страница с содержимым.")
    data = text.encode("utf-8")
    sha = hashlib.sha256(data).hexdigest()
    snap = root / "snapshots"
    snap.mkdir(parents=True, exist_ok=True)
    (snap / f"{id}.txt").write_bytes(data)
    _write_json(snap / f"{id}.json", {"id": id, "sha256": sha, "chars": len(text), "savedAt": day, "originalFile": file.name})
    return sha


def add_source(root: Path, *, id: str, title: str, author: str, url: str, license: str, file: Path, today: str | None = None) -> dict:
    rules = load_rules(root)
    if license not in rules.licenses:
        raise KnowledgeError(f"Источник отклонён: лицензия «{license}» не разрешена. Можно: {', '.join(rules.licenses)}.")
    if not ID.match(id):
        raise KnowledgeError("id источника: латиница в нижнем регистре, цифры и дефисы (например openstax-ap2e).")
    for name, value in (("title", title), ("author", author)):
        if not value.strip():
            raise KnowledgeError(f"Поле {name} обязательно: без автора и названия источник не принимается.")
    if not url.startswith("https://"):
        raise KnowledgeError("url должен начинаться с https://: это ссылка на оригинал для читателя.")
    if get_source(root, id):
        raise KnowledgeError(f"Источник {id} уже есть. Для другого фрагмента заведи новый id.")
    day = today or date.today().isoformat()
    save_snapshot(root, id, file, day)
    entry = {"id": id, "title": title.strip(), "author": author.strip(), "url": url.strip(), "license": license, "retrievedAt": day}
    _write_json(root / "sources.json", [*list_sources(root), entry])
    return entry


def load_snapshot(root: Path, source_id: str) -> tuple[str, str]:
    """Текст снимка и его хэш. Хэш сверяется с записью: если файл правили руками, цитатам верить нельзя."""
    txt, meta = root / "snapshots" / f"{source_id}.txt", root / "snapshots" / f"{source_id}.json"
    if not txt.exists() or not meta.exists():
        raise KnowledgeError(f"Для источника {source_id} нет снимка текста. Добавь его командой `content source add`.")
    data = txt.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    if sha != json.loads(meta.read_text(encoding="utf-8")).get("sha256"):
        raise KnowledgeError(f"Снимок {source_id} изменён после сохранения (хэш не совпал). Верни файл или добавь источник заново.")
    return data.decode("utf-8"), sha


def attach_snapshot(root: Path, source_id: str, file: Path, today: str | None = None) -> str:
    """Для источника, который уже есть в реестре (например, из 1.3.0), но снимка текста у него нет."""
    if not get_source(root, source_id):
        raise KnowledgeError(f"Источника {source_id} нет в реестре. Добавь его командой `content source add`.")
    if (root / "snapshots" / f"{source_id}.json").exists():
        raise KnowledgeError(f"У источника {source_id} уже есть снимок. Снимки не перезаписываются: заведи новый id.")
    return save_snapshot(root, source_id, file, today or date.today().isoformat())
