"""Курсы и отметки (1.5.0): уроки, тест, разбор ошибок, повторная попытка с другими вопросами, отметка в профиле, без сети.

Нужна сборка, в которую попал курс. Пока курс не опубликован, обычная сборка его не содержит, и тест пропускается (SKIP).
Чтобы прогнать его на черновике:  CONTENT_PREVIEW=1 npm run build   (перед релизом снова обычный npm run content:build)
"""
import json, os
from pathlib import Path
BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8000/")
from playwright.sync_api import sync_playwright

COURSE = "muscle-growth"
D = Path("content/courses") / COURSE
QUESTIONS = {q["text"]: q for q in json.loads((D / "questions.json").read_text(encoding="utf-8"))}
errors = []
def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond: errors.append(name)

ROWS = "() => new Promise((res, rej) => { const o = indexedDB.open('workout-pwa'); o.onsuccess = () => { const db = o.result; const r = db.transaction('learning').objectStore('learning').getAll(); r.onsuccess = () => { db.close(); res(r.result); }; }; o.onerror = () => rej(o.error); })"

def run_quiz(page, right):
    """Проходит тест: right=True — все ответы верные, иначе все неверные. Возвращает тексты вопросов."""
    seen = []
    for step in range(10):
        page.wait_for_selector("[data-testid=quiz]")
        text = page.locator(".quiz-q legend").inner_text().strip()
        seen.append(text)
        q = QUESTIONS[text]
        good = q["options"][q["correct"]]
        opts = page.locator("[data-testid=quiz-opt]")
        for i in range(opts.count()):
            if (opts.nth(i).inner_text().strip() == good) == right:
                opts.nth(i).click(); break
        page.click("[data-testid=quiz-next]")
    return seen

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".cal-grid")

    page.goto(BASE + "#/learn"); page.reload()
    page.wait_for_selector("[data-testid=learn-list]")
    if page.locator(".learn-course").count() == 0:
        print("SKIP нет курсов в этой сборке (CONTENT_PREVIEW=1 npm run build)")
        b.close(); raise SystemExit(0)
    ctx.set_offline(True)

    # --- профиль: отдельный блок «Знания», не награды
    page.goto(BASE + "#/profile"); page.wait_for_selector("[data-testid=marks-card]")
    check("в профиле есть блок «Знания»", "Не начат" in page.inner_text("[data-testid=marks-card]"))
    check("в блоке сказано, что отметка не документ", "не документ" in page.inner_text("[data-testid=marks-card]"))

    # --- курс и урок
    page.click("[data-testid=marks-card] .row"); page.wait_for_selector("[data-testid=learn-course]")
    check("шесть уроков", page.locator(".learn-lesson").count() == 6, page.locator(".learn-lesson").count())
    check("нет отметки до теста", page.locator("[data-testid=learn-mark]").count() == 0)
    page.locator(".learn-lesson").first.click(); page.wait_for_selector("[data-testid=learn-lesson]")
    check("текст урока показан", page.locator(".lesson-body p").count() >= 2)
    page.click("[data-testid=lesson-done]"); page.wait_for_selector("[data-testid=learn-lesson]")  # следующий урок
    page.go_back(); page.go_back() if page.locator("[data-testid=learn-course]").count() == 0 else None
    page.goto(BASE + f"#/learn/{COURSE}"); page.wait_for_selector("[data-testid=learn-course]")
    check("прогресс по урокам сохранился", "Прочитано уроков: 1 из 6" in page.inner_text("[data-testid=learn-progress]"), page.inner_text("[data-testid=learn-progress]"))

    # --- первая попытка: все верно
    page.click("[data-testid=learn-start]")
    first = run_quiz(page, right=True)
    page.wait_for_selector("[data-testid=quiz-result]")
    check("десять разных вопросов", len(set(first)) == 10)
    check("результат 10 из 10 и порог", "Верно 10 из 10 (100%). Порог 80%." in page.inner_text("[data-testid=quiz-score]"), page.inner_text("[data-testid=quiz-score]"))
    check("отметка записана, со словами «не документ»", "Отметка о прохождении записана" in page.inner_text("[data-testid=quiz-result]") and "не документ" in page.inner_text("[data-testid=quiz-result]"))
    check("при 10 из 10 разбора ошибок нет", page.locator("[data-testid=quiz-review]").count() == 0)
    check("нет наград: ни монет, ни опыта", not any(w in page.inner_text("[data-testid=quiz-result]").lower() for w in ("монет", "xp", "награда", "сертификат", "диплом")))
    rows = page.evaluate(ROWS)
    check("записана одна попытка без ответов", len(rows) == 1 and rows[0]["passed"] and rows[0]["correct"] == 10 and "answers" not in rows[0] and "review" not in rows[0], rows)
    page.screenshot(path="/tmp/learn_pass.png")

    # --- повторная попытка сразу, другие вопросы; все неверно
    page.click("[data-testid=quiz-again]")
    second = run_quiz(page, right=False)
    page.wait_for_selector("[data-testid=quiz-result]")
    check("другой набор вопросов", len(set(first) & set(second)) == 0, len(set(first) & set(second)))
    check("результат 0 из 10, тест не пройден", "Верно 0 из 10" in page.inner_text("[data-testid=quiz-score]") and "Тест не пройден" in page.inner_text("[data-testid=quiz-result]"))
    check("разбор десяти ошибок с объяснениями", page.locator(".learn-review").count() == 10 and "Верно:" in page.inner_text(".learn-review"))
    check("в разборе есть ссылка на урок", page.locator(".learn-review .link-btn:has-text('Перечитать')").count() >= 10)
    page.screenshot(path="/tmp/learn_fail.png")
    rows = page.evaluate(ROWS)
    check("две попытки, отметка осталась по первой", len(rows) == 2 and sorted(r["passed"] for r in rows) == [False, True], len(rows))

    # --- отметка видна на экране курса и в профиле
    page.click("button:has-text('К курсу')"); page.wait_for_selector("[data-testid=learn-mark]")
    check("на экране курса отметка есть", "Курс пройден" in page.inner_text("[data-testid=learn-mark]") or "курс пройден" in page.inner_text("[data-testid=learn-mark]").lower())
    page.goto(BASE + "#/profile"); page.wait_for_selector("[data-testid=marks-card]")
    check("в профиле отметка с датой", "Отметка о прохождении:" in page.inner_text("[data-testid=marks-card]"))
    ov = page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    check("нет горизонтального переполнения", ov[0] <= ov[1], ov)

    # --- выход из теста посреди попытки ничего не записывает
    page.goto(BASE + f"#/learn/{COURSE}/test"); page.wait_for_selector("[data-testid=quiz]")
    page.locator("[data-testid=quiz-opt]").first.click(); page.click("[data-testid=quiz-next]")
    page.goto(BASE + f"#/learn/{COURSE}"); page.wait_for_selector("[data-testid=learn-course]")
    check("незавершённая попытка не записана", len(page.evaluate(ROWS)) == 2)

    # --- «Узнать больше» из карточки упражнения (карточки есть в предпросмотре)
    ctx.set_offline(False)
    page.goto(BASE + "#/exercises"); page.wait_for_selector(".list")
    page.wait_for_timeout(400)
    infos = page.locator(".list .info-btn")
    if infos.count():
        row = page.locator(".list .row-split:has-text('Жим штанги лёжа')").first
        row.locator(".info-btn").click(); page.wait_for_selector("[data-testid=why-card]")
        check("в карточке упражнения есть «Узнать больше»", page.locator("[data-testid=learn-more] .link-btn").count() >= 1)
        page.locator("[data-testid=learn-more] .link-btn").first.click()
        page.wait_for_selector("[data-testid=learn-lesson]")
        check("ссылка ведёт на урок", page.locator(".lesson-body p").count() >= 2 and page.locator("[data-testid=why-card]").count() == 0)
    else:
        print("SKIP карточек упражнений в сборке нет")

    check("в консоли нет ошибок", not logs, logs)
    b.close()

raise SystemExit(1 if errors else 0)
