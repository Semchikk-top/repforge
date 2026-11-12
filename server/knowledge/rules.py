"""Правила проверки из content/rules.json: тот же файл читает приложение, поэтому лимиты не расходятся."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Rules:
    licenses: tuple[str, ...]
    limits: dict[str, tuple[int, int]]
    forbidden: tuple[re.Pattern[str], ...]


def load_rules(root: Path) -> Rules:
    data = json.loads((root / "rules.json").read_text(encoding="utf-8"))
    return Rules(
        licenses=tuple(data["allowedLicenses"]),
        limits={k: (int(v[0]), int(v[1])) for k, v in data["limits"].items()},
        forbidden=tuple(re.compile(p) for p in data["forbidden"]),  # флаг (?i) уже внутри шаблона
    )
