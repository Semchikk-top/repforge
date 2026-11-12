"""Отметки о прохождении курсов приватны (1.5.0): они живут только на твоих устройствах и на твоём сервере (таблица `learning`).
Ни в мировой рейтинг, ни в снимки друзьям, ни ассистенту они не попадают."""
import json
import re
from pathlib import Path

from board.rules import validate_snapshot

from tests.test_board import Env, Ident, NOW

REPO = Path(__file__).resolve().parent.parent
LEAK = re.compile(r"learning|courseId|muscle-growth|passed|attempt", re.I)


def test_board_drops_unknown_fields_so_attempts_cannot_ride_along(tmp_path, monkeypatch):
    monkeypatch.setenv("BOARD_JOIN_PER_IP_HOUR", "10000")
    monkeypatch.setenv("BOARD_NEW_PROFILES_PER_IP_DAY", "10000")
    env, me = Env(tmp_path), Ident()
    env.join(me)
    sneaky = me.snap(NOW, learning=[{"courseId": "muscle-growth", "passed": True}], marks={"muscle-growth": True})
    assert env.submit(sneaky).json()["accepted"] == 1
    # проверка формы возвращает только известные поля
    clean = validate_snapshot(sneaky)
    assert not LEAK.search(json.dumps(clean))
    # и в самой базе рейтинга после приёма нет ничего похожего
    dump = "\n".join(env.store.db.iterdump())
    assert not re.search(r"learning|courseId|muscle-growth", dump, re.I)
    # публичная таблица тоже чистая
    assert not LEAK.search(env.board().text)


def test_no_social_or_board_code_knows_about_learning():
    """Архитектурная защита: код рейтинга и друзей про `learning` не знает, значит и отдать его не может."""
    files = [*(REPO / "board").rglob("*.py"), *(REPO / "src" / "social").rglob("*.ts*")]
    assert files
    bad = [str(f.relative_to(REPO)) for f in files if re.search(r"learning|LearningAttempt|courseId", f.read_text(encoding="utf-8"))]
    assert bad == []


def test_assistant_has_no_tool_that_reads_attempts():
    """Ассистент видит тренировки, но не отметки о курсах: инструменты не обращаются к таблице `learning`."""
    files = list((REPO / "server" / "assistant").rglob("*.py"))
    assert files
    bad = [f.name for f in files if re.search(r"['\"]learning['\"]|courseId", f.read_text(encoding="utf-8"))]
    assert bad == []
