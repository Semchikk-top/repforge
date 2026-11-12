"""Справочник для ассистента (1.4.0): get_exercise_card и get_principle отдают только опубликованное."""
import json
from pathlib import Path

import httpx
import pytest

from server.assistant import content
from server.assistant.agent import SYSTEM_PROMPT
from server.assistant.tools import TOOLS, TOOL_LABELS, DataAccess

from .test_assistant import TODAY, a_text, a_tool, chat, env, install, ok  # noqa: F401  (env — фикстура)

REPO = Path(__file__).resolve().parent.parent


def write(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def card(ex_id, status="published", **over):
    base = {
        "id": ex_id, "summary": "Базовое жимовое движение.", "primaryMuscles": ["pec"], "secondaryMuscles": ["tri"],
        "function": "Горизонтальное приведение плеча.", "cues": ["Лопатки сведены.", "Стопы в пол."],
        "mistakes": ["Отрыв таза.", "Отбив от груди."], "swapNote": "Жим гантелей.", "sources": ["s1"],
        "status": status, "reviewedAt": "2026-11-08" if status != "draft" else None, "contentVersion": 1,
        "techniqueReview": {"by": "тренер", "at": "2026-11-09"} if status == "published" else None,
    }
    base.update(over)
    return base


def principle(pid, title, status="published"):
    return {"id": pid, "title": title, "summary": "Суть.", "points": ["Раз.", "Два."], "sources": ["s1"],
            "status": status, "reviewedAt": "2026-11-08" if status != "draft" else None, "contentVersion": 1}


@pytest.fixture()
def root(tmp_path, monkeypatch):
    c = tmp_path / "content"
    write(c / "exercise_names.json", {"seed-001": "Жим штанги лёжа", "seed-002": "Жим гантелей на наклонной скамье", "seed-003": "Отжимания на брусьях", "seed-016": "Румынская тяга"})
    write(c / "muscles.json", [{"id": "pec", "name": "Большая грудная мышца"}, {"id": "tri", "name": "Трицепс"}])
    write(c / "sources.json", [{"id": "s1", "title": "Источник", "author": "Автор", "license": "CC-BY-4.0", "url": "https://example.org/x", "retrievedAt": "2026-11-08"}])
    write(c / "exercises" / "seed-001.json", card("seed-001"))
    write(c / "exercises" / "seed-003.json", card("seed-003", status="draft"))
    write(c / "exercises" / "seed-002.json", card("seed-002"))
    write(c / "principles" / "rest-between-sets.json", principle("rest-between-sets", "Отдых между подходами"))
    write(c / "principles" / "warm-up.json", principle("warm-up", "Разминка", status="draft"))
    monkeypatch.setenv("REPFORGE_CONTENT_DIR", str(c))
    monkeypatch.delenv("REPFORGE_CONTENT_PREVIEW", raising=False)
    return c


def test_published_card_found_by_approximate_name(root):
    r = content.get_exercise_card("жим лежа")  # без ё, часть названия
    assert r["found"] is True and r["exercise"] == "Жим штанги лёжа"
    assert r["primary_muscles"] == ["Большая грудная мышца"] and r["secondary_muscles"] == ["Трицепс"]
    assert r["sources"] == [{"title": "Источник", "author": "Автор", "license": "CC-BY-4.0", "url": "https://example.org/x"}]
    assert r["technique_reviewed_by"] == {"by": "тренер", "at": "2026-11-09"}
    assert "warning" not in r and "Образовательная информация" in r["note"]


def test_draft_is_hidden_by_default(root):
    r = content.get_exercise_card("отжимания на брусьях")
    assert r["found"] is False and "В справочнике этого нет" in r["message"]
    assert "summary" not in r


def test_preview_returns_draft_with_warning(root, monkeypatch):
    monkeypatch.setenv("REPFORGE_CONTENT_PREVIEW", "1")
    r = content.get_exercise_card("отжимания на брусьях")
    assert r["found"] is True and r["status"] == "draft" and "ЧЕРНОВИК" in r["warning"]


def test_unknown_and_ambiguous_and_empty_queries(root):
    assert content.get_exercise_card("планка на луне")["found"] is False
    assert content.get_exercise_card("")["found"] is False
    amb = content.get_exercise_card("жим")
    assert amb["found"] is False and sorted(amb["matches"]) == ["Жим гантелей на наклонной скамье", "Жим штанги лёжа"]
    assert content.get_exercise_card("румынская тяга")["found"] is False  # карточки нет вовсе


def test_principle_by_id_title_and_unknown(root):
    assert content.get_principle("rest-between-sets")["title"] == "Отдых между подходами"
    assert content.get_principle("отдых")["id"] == "rest-between-sets"
    r = content.get_principle("разминка")  # черновик скрыт
    assert r["found"] is False and "В справочнике этого нет" in r["message"]
    assert [p["id"] for p in r["available"]] == ["rest-between-sets"]  # черновик не светится даже в списке
    assert [p["id"] for p in content.get_principle("")["available"]] == ["rest-between-sets"]


def test_preview_principle_is_marked(root, monkeypatch):
    monkeypatch.setenv("REPFORGE_CONTENT_PREVIEW", "1")
    r = content.get_principle("warm-up")
    assert r["found"] is True and "ЧЕРНОВИК" in r["warning"]


def test_missing_or_broken_content_never_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("REPFORGE_CONTENT_DIR", str(tmp_path / "nope"))
    assert content.get_exercise_card("жим")["found"] is False
    assert content.get_principle("x")["found"] is False
    c = tmp_path / "broken"
    write(c / "exercise_names.json", {"seed-001": "Жим"})
    (c / "exercises").mkdir()
    (c / "exercises" / "seed-001.json").write_text("{не json", encoding="utf-8")
    monkeypatch.setenv("REPFORGE_CONTENT_DIR", str(c))
    assert content.get_exercise_card("жим")["found"] is False


def test_real_repo_content_is_published_and_resolvable(monkeypatch):
    """Опубликованный справочник виден ассистенту без предпросмотра, черновики остаются скрытыми."""
    monkeypatch.delenv("REPFORGE_CONTENT_DIR", raising=False)
    monkeypatch.delenv("REPFORGE_CONTENT_PREVIEW", raising=False)
    names = json.loads((REPO / "content" / "exercise_names.json").read_text(encoding="utf-8"))
    published = [f for f in (REPO / "content" / "exercises").glob("*.json") if json.loads(f.read_text(encoding="utf-8"))["status"] == "published"]
    assert len(published) == 32
    assert content.get_exercise_card("жим штанги лёжа")["found"] is True
    assert content.get_principle("warm-up")["found"] is True
    monkeypatch.setenv("REPFORGE_CONTENT_PREVIEW", "1")
    assert len(names) == 52  # 32 из версии 1.3.0 и 20 новых из 1.5.0
    for ex_id, name in names.items():
        r = content.get_exercise_card(name)
        has_card = (REPO / "content" / "exercises" / f"{ex_id}.json").exists()
        assert has_card or int(ex_id.split("-")[1]) > 32, name  # у первых 32 карточка обязана быть, у новых её готовит конвейер знаний
        assert r["found"] is has_card, name
        if has_card:
            assert r["exercise"] == name


def test_tool_schema_prompt_and_labels(root):
    by_name = {t["name"]: t for t in TOOLS}
    assert {"get_exercise_card", "get_principle"} <= set(by_name)
    assert set(by_name) == set(TOOL_LABELS)  # у каждого инструмента есть подпись для интерфейса
    assert by_name["get_exercise_card"]["input_schema"]["required"] == ["name"]
    assert "get_exercise_card" in SYSTEM_PROMPT and "В справочнике этого нет" in SYSTEM_PROMPT
    assert "лекарствах" in SYSTEM_PROMPT


def test_execute_wraps_tools_and_ignores_extra_args(env, root):  # noqa: F811
    app, _, _ = env
    d = DataAccess(app.state.conn, TODAY)
    out = json.loads(d.execute("get_exercise_card", {"name": "жим штанги", "evil": "rm -rf"}))
    assert out["found"] is True and out["exercise"] == "Жим штанги лёжа"
    assert json.loads(d.execute("get_principle", {"id": "rest-between-sets"}))["found"] is True


def test_full_chat_loop_answers_from_handbook(env, root):  # noqa: F811
    app, client, h = env
    calls = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        calls.append(body)
        if len(calls) == 1:
            assert {"get_exercise_card", "get_principle"} <= {t["name"] for t in body["tools"]}
            assert "В справочнике этого нет" in body["system"]
            return ok(a_tool("toolu_1", "get_exercise_card", {"name": "жим лёжа"}))
        payload = json.loads(body["messages"][-1]["content"][0]["content"])
        assert payload["found"] is True and payload["primary_muscles"] == ["Большая грудная мышца"]
        return ok(a_text("Основная работа идёт на грудную мышцу."))

    install(app, handler)
    ev = chat(client, h, text="Зачем нужен жим лёжа?")
    assert [e["label"] for e in ev if e["type"] == "tool"] == ["Смотрю справочник упражнений приложения"]
    assert len(calls) == 2


def test_chat_tells_model_when_handbook_has_nothing(env, root):  # noqa: F811
    app, client, h = env
    seen = {}

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        if "tool_result" not in json.dumps(body["messages"][-1], ensure_ascii=False):
            return ok(a_tool("toolu_1", "get_exercise_card", {"name": "румынская тяга"}))
        seen.update(json.loads(body["messages"][-1]["content"][0]["content"]))
        return ok(a_text("В справочнике этого нет."))

    install(app, handler)
    chat(client, h, text="Зачем румынская тяга?")
    assert seen["found"] is False and "не из справочника и не проверен" in seen["message"]
