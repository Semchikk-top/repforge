"""Конвейер знаний (1.5.0, этап A): источники, черновики, механические проверки, ручной шаг, золотой набор.
Настоящая модель не нужна: вместо неё подставляется функция, которая возвращает заготовленный ответ."""
import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from server.knowledge import checks, draft as D, golden as G, sources as S
from server.knowledge.model import pick_backend
from server.knowledge.rules import load_rules
from server.knowledge.sources import KnowledgeError

REPO = Path(__file__).resolve().parent.parent

SOURCE_TEXT = (
    "The pectoralis major is a large muscle that covers the upper chest and pulls the arm across the body. "
    "During a bench press it works together with the anterior deltoid at the front of the shoulder and with the "
    "triceps brachii, which straightens the elbow. The serratus anterior holds the shoulder blade against the ribs "
    "while the arm pushes forward. Muscle fibres shorten when they contract and lengthen when they relax. "
)


@pytest.fixture()
def root(tmp_path):
    r = tmp_path / "content"
    shutil.copytree(REPO / "content", r, ignore=shutil.ignore_patterns("golden"))
    return r


@pytest.fixture()
def src_file(tmp_path):
    f = tmp_path / "chapter.txt"
    f.write_text(SOURCE_TEXT, encoding="utf-8")
    return f


def add(root, src_file, id="test-src", license="CC-BY-4.0"):
    return S.add_source(root, id=id, title="Test chapter", author="Автор", url="https://example.org/ch", license=license, file=src_file, today="2026-11-11")


GOOD = {
    "fields": {
        "summary": "Большая грудная мышца приводит руку к корпусу и работает при жиме вместе с передней дельтой и трицепсом.",
        "primaryMuscles": ["pectoralis-major"],
        "secondaryMuscles": ["deltoid-anterior", "triceps-brachii"],
        "function": "Тянет руку через грудь к корпусу; в жиме разгибает руку вместе с трицепсом.",
        "cues": ["Лопатка прижата к рёбрам зубчатой мышцей.", "Локти разгибает трицепс."],
        "mistakes": ["Не давай лопатке отходить от рёбер.", "Не разгибай локти рывком."],
        "swapNote": "Подойдёт жим гантелей: та же большая грудная работает с передней дельтой.",
    },
    "claims": [
        {"field": "summary", "item": None, "text": "t", "quote": "The pectoralis major is a large muscle that covers the upper chest"},
        {"field": "primaryMuscles", "item": None, "text": "t", "quote": "pulls the arm across the body"},
        {"field": "secondaryMuscles", "item": None, "text": "t", "quote": "works together with the anterior deltoid at the front of the shoulder"},
        {"field": "function", "item": None, "text": "t", "quote": "with the triceps brachii, which straightens the elbow"},
        {"field": "cues", "item": 0, "text": "t", "quote": "holds the shoulder blade against the ribs"},
        {"field": "cues", "item": 1, "text": "t", "quote": "triceps brachii, which straightens the elbow"},
        {"field": "mistakes", "item": 0, "text": "t", "quote": "holds the shoulder blade against the ribs while the arm pushes"},
        {"field": "mistakes", "item": 1, "text": "t", "quote": "which straightens the elbow"},
        {"field": "swapNote", "item": None, "text": "t", "quote": "it works together with the anterior deltoid"},
    ],
    "terms": [{"src": "pectoralis major", "ru": "большая грудная мышца"}],
}


def fake(reply):
    async def ask(system, user):
        ask.system, ask.user = system, user
        return reply if isinstance(reply, str) else "```json\n" + json.dumps(reply, ensure_ascii=False) + "\n```"
    return ask


def run_draft(root, ask, **kw):
    args = dict(kind="card", target="seed-001", source_id="test-src", ask=ask, model="fake", backend="local", lang="en")
    args.update(kw)
    return asyncio.run(D.make_draft(root, **args))


# ---------- источники ----------

def test_license_not_allowed_is_rejected(root, src_file):
    with pytest.raises(KnowledgeError, match="лицензия «CC-BY-NC-4.0» не разрешена"):
        add(root, src_file, license="CC-BY-NC-4.0")
    assert not (root / "snapshots").exists() and all(s["id"] != "test-src" for s in S.list_sources(root))


def test_source_added_with_snapshot_and_hash(root, src_file):
    e = add(root, src_file)
    assert e["retrievedAt"] == "2026-11-11" and S.get_source(root, "test-src")["license"] == "CC-BY-4.0"
    text, sha = S.load_snapshot(root, "test-src")
    assert text == SOURCE_TEXT.strip() and len(sha) == 64
    with pytest.raises(KnowledgeError, match="уже есть"):
        add(root, src_file)


def test_source_needs_author_https_and_real_text(root, tmp_path, src_file):
    with pytest.raises(KnowledgeError, match="author"):
        S.add_source(root, id="a1", title="T", author=" ", url="https://x.org", license="CC0-1.0", file=src_file)
    with pytest.raises(KnowledgeError, match="https"):
        S.add_source(root, id="a1", title="T", author="A", url="http://x.org", license="CC0-1.0", file=src_file)
    tiny = tmp_path / "t.txt"
    tiny.write_text("мало", encoding="utf-8")
    with pytest.raises(KnowledgeError, match="почти нет текста"):
        S.add_source(root, id="a1", title="T", author="A", url="https://x.org", license="CC0-1.0", file=tiny)


def test_html_source_is_converted_to_text(root, tmp_path):
    f = tmp_path / "p.html"
    f.write_text("<html><head><style>x{}</style></head><body><script>bad()</script><h1>Muscles</h1><p>" + SOURCE_TEXT + "</p></body></html>", encoding="utf-8")
    add(root, f, id="html-src")
    text, _ = S.load_snapshot(root, "html-src")
    assert "bad()" not in text and text.startswith("Muscles") and "pectoralis major" in text


def test_tampered_snapshot_is_detected(root, src_file):
    add(root, src_file)
    p = root / "snapshots" / "test-src.txt"
    p.write_text(p.read_text(encoding="utf-8") + " подмена", encoding="utf-8")
    with pytest.raises(KnowledgeError, match="хэш не совпал"):
        S.load_snapshot(root, "test-src")


def test_snapshot_for_existing_source(root, src_file):
    sha = S.attach_snapshot(root, "openstax-ap2e", src_file, "2026-11-11")
    assert S.load_snapshot(root, "openstax-ap2e")[1] == sha
    with pytest.raises(KnowledgeError, match="уже есть снимок"):
        S.attach_snapshot(root, "openstax-ap2e", src_file)
    with pytest.raises(KnowledgeError, match="нет в реестре"):
        S.attach_snapshot(root, "nope", src_file)


# ---------- черновик и проверки ----------

def test_good_draft_passes_all_checks_and_model_only_gets_source_text(root, src_file):
    add(root, src_file)
    ask = fake(GOOD)
    doc = run_draft(root, ask)
    assert doc["checks"] == [] and doc["status"] == "draft"
    assert "ТОЛЬКО поданный текст" in ask.system and "цитату-основание" in ask.system
    assert "pectoralis-major: " in ask.user and "pectoralis major is a large muscle" in ask.user
    assert doc["termsChecked"] is False  # источник на английском


def test_quote_not_in_source_is_caught_by_script(root, src_file):
    add(root, src_file)
    bad = json.loads(json.dumps(GOOD))
    bad["claims"][3]["quote"] = "The triceps cause hypertrophy within two weeks of training"
    doc = run_draft(root, fake(bad))
    codes = {(c["code"], c["where"]) for c in doc["checks"]}
    assert ("quote_missing", "function") in codes and ("uncovered", "function") in codes


def test_quote_matching_ignores_case_yo_dashes_and_spacing(root, tmp_path):
    f = tmp_path / "ru.txt"
    f.write_text("Ёмкость мышцы растёт при регулярной нагрузке — это называется гипертрофией.\n" * 4, encoding="utf-8")
    add(root, f, id="ru-src")
    probs = checks.check_claims("principle", {"title": "Т"}, [{"field": "title", "quote": "ЕМКОСТЬ  мышцы растет при регулярной нагрузке - это называется"}], f.read_text(encoding="utf-8"))
    assert probs == []


def test_short_and_long_quotes_are_flagged(root, src_file):
    short = checks.check_claims("principle", {"title": "T"}, [{"field": "title", "quote": "muscle"}], SOURCE_TEXT)
    assert short[0].code == "quote_short"
    long_ = checks.check_claims("principle", {"title": "T"}, [{"field": "title", "quote": SOURCE_TEXT}], SOURCE_TEXT)
    assert long_[0].code == "quote_long"


def test_unknown_muscle_forbidden_topic_and_limits(root, src_file):
    add(root, src_file)
    bad = json.loads(json.dumps(GOOD))
    bad["fields"]["primaryMuscles"] = ["pectoralis-major", "bicep-of-doom"]
    bad["fields"]["swapNote"] = "Принимай креатин и протеин для роста."
    bad["fields"]["summary"] = "коротко"
    codes = {(c["code"], c["where"]) for c in run_draft(root, fake(bad))["checks"]}
    assert ("unknown_muscle", "primaryMuscles") in codes
    assert ("forbidden", "swapNote") in codes
    assert ("bad_length", "summary") in codes


def test_missing_field_is_reported_not_invented(root, src_file):
    add(root, src_file)
    part = json.loads(json.dumps(GOOD))
    part["fields"]["swapNote"] = ""
    part["claims"] = [c for c in part["claims"] if c["field"] != "swapNote"]
    codes = {(c["code"], c["where"]) for c in run_draft(root, fake(part))["checks"]}
    assert codes == {("missing_field", "swapNote")}


def test_license_and_source_checked_in_draft(root, src_file):
    add(root, src_file)
    reg = json.loads((root / "sources.json").read_text(encoding="utf-8"))
    for s in reg:
        if s["id"] == "test-src":
            s["license"] = "All-Rights-Reserved"
    (root / "sources.json").write_text(json.dumps(reg), encoding="utf-8")
    assert any(c["code"] == "license" for c in run_draft(root, fake(GOOD))["checks"])


def test_model_garbage_is_a_clear_error(root, src_file):
    add(root, src_file)
    with pytest.raises(KnowledgeError, match="не вернула JSON"):
        run_draft(root, fake("Извините, не могу."))
    with pytest.raises(KnowledgeError, match="неверный JSON"):
        run_draft(root, fake("{ не json }"))


def test_long_source_requires_explicit_fragment(root, tmp_path):
    f = tmp_path / "long.txt"
    f.write_text(SOURCE_TEXT * 80, encoding="utf-8")
    add(root, f, id="long-src")
    with pytest.raises(KnowledgeError, match="--start N --end M"):
        run_draft(root, fake(GOOD), source_id="long-src")
    doc = run_draft(root, fake(GOOD), source_id="long-src", start=0, end=900)
    assert doc["range"] == [0, 900]


def test_bad_targets_are_rejected(root, src_file):
    add(root, src_file)
    with pytest.raises(KnowledgeError, match="стартового упражнения"):
        run_draft(root, fake(GOOD), target="bench")
    with pytest.raises(KnowledgeError, match="нет среди стартовых"):
        run_draft(root, fake(GOOD), target="seed-999")
    with pytest.raises(KnowledgeError, match="не найден"):
        run_draft(root, fake(GOOD), source_id="nope")


# ---------- принятие: только draft, перевод требует ручной сверки ----------

def test_accept_writes_draft_status_only_and_blocks_until_terms_checked(root, src_file):
    add(root, src_file)
    doc = run_draft(root, fake(GOOD))
    with pytest.raises(KnowledgeError, match="сверь терминологию"):
        D.accept(root, doc, replace=True)
    doc["termsChecked"] = "2026-11-11"
    path = D.accept(root, doc, replace=True)
    out = json.loads(path.read_text(encoding="utf-8"))
    assert out["status"] == "draft" and out["reviewedAt"] is None and out["techniqueReview"] is None
    assert out["sources"] == ["test-src"] and out["contentVersion"] == 2  # заменили карточку 1.3.0: версия выросла


def test_accept_refuses_to_overwrite_and_rechecks_hand_edits(root, src_file):
    add(root, src_file)
    doc = run_draft(root, fake(GOOD), lang="ru")
    with pytest.raises(KnowledgeError, match="--replace"):
        D.accept(root, doc)
    doc["fields"]["swapNote"] = "Лучше принимать креатин."  # человек поправил и внёс запрещённое
    with pytest.raises(KnowledgeError, match="запрещённая тема"):
        D.accept(root, doc, replace=True)


def test_new_principle_accepted_and_passes_the_apps_own_validation(root, src_file):
    add(root, src_file)
    fields = {"title": "Мышцы работают вместе", "summary": "При жиме большая грудная работает вместе с передней дельтой и трицепсом.",
              "points": ["Грудная мышца тянет руку к корпусу.", "Трицепс разгибает локоть."]}
    claims = [{"field": "title", "quote": "it works together with the anterior deltoid"},
              {"field": "summary", "quote": "During a bench press it works together"},
              {"field": "points", "item": 0, "quote": "pulls the arm across the body"},
              {"field": "points", "item": 1, "quote": "which straightens the elbow"}]
    doc = run_draft(root, fake({"fields": fields, "claims": claims}), kind="principle", target="muscles-work-together", lang="ru")
    assert doc["checks"] == []
    D.accept(root, doc)
    assert json.loads((root / "principles" / "muscles-work-together.json").read_text(encoding="utf-8"))["status"] == "draft"
    # то, что принял конвейер, обязано проходить те же проверки, что приложение (`npm run content:check`)
    if not (REPO / "node_modules").exists():
        pytest.skip("нет node_modules")
    r = subprocess.run(["npx", "vite-node", "scripts/content.ts", "check"], cwd=REPO, env={**__import__("os").environ, "REPFORGE_CONTENT_DIR": str(root)}, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr


def test_accepted_card_passes_the_apps_own_validation(root, src_file):
    add(root, src_file)
    doc = run_draft(root, fake(GOOD))
    doc["termsChecked"] = "2026-11-11"
    D.accept(root, doc, replace=True)
    if not (REPO / "node_modules").exists():
        pytest.skip("нет node_modules")
    r = subprocess.run(["npx", "vite-node", "scripts/content.ts", "check"], cwd=REPO, env={**__import__("os").environ, "REPFORGE_CONTENT_DIR": str(root)}, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr


# ---------- модель и облако ----------

def test_cloud_is_off_unless_explicitly_allowed():
    with pytest.raises(KnowledgeError, match="--allow-cloud"):
        pick_backend("cloud", allow_cloud=False)


# ---------- золотой набор ----------

def test_golden_run_and_score(root, src_file, tmp_path):
    add(root, src_file)
    entries = [{"kind": "card", "target": "seed-001", "source": "test-src", "lang": "en"}]
    bad = json.loads(json.dumps(GOOD))
    bad["claims"][0]["quote"] = "Выдуманная цитата, которой нет в источнике вовсе"
    sheet, st = asyncio.run(G.run_golden(root, entries, ask=fake(bad), model="fake", backend="local", out_dir=tmp_path / "run"))
    assert st == {"claims": 9, "quoteFound": 8}
    assert not (root / "drafts" / "card-seed-001.json").exists()  # золотой набор не засоряет черновики
    text = sheet.read_text(encoding="utf-8")
    assert "проверенный текст:" in text  # рядом показан текст карточки, проверенный вручную
    with pytest.raises(KnowledgeError, match="Не размечено"):
        G.score_sheet(text)
    marked = text.replace("- [ ]", "- [x]")
    res = G.score_sheet(marked)
    assert res["total"] == 9 and res["quoteMissing"] == 1 and res["needFix"] == 1  # цитата не найдена — ошибка, даже если человек отметил «верно»
    assert not res["passed"]                                                      # 1/9 = 11% > 10%
    assert G.score_sheet(marked, threshold=0.12)["passed"]
    two = marked.replace("- [x] seed-001#1", "- [~] seed-001#1", 1)
    assert G.score_sheet(two)["changes"] == 1 and G.score_sheet(two)["needFix"] == 2


def test_rules_are_shared_with_the_app():
    rules = load_rules(REPO / "content")
    raw = json.loads((REPO / "content" / "rules.json").read_text(encoding="utf-8"))
    assert list(rules.licenses) == raw["allowedLicenses"] and len(rules.forbidden) == len(raw["forbidden"]) == 4
    assert rules.forbidden[0].search("Препарат для роста") and not rules.forbidden[2].search("жим штанги")
