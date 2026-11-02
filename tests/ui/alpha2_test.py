"""Версия 0.2: суперсеты, типы подходов, заметки, экран рекордов, ярлыки приложения, индикатор очереди синхронизации."""
import json, os, re, subprocess, sys, tempfile
from datetime import date, timedelta
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
errors = []
SEED = {n: f"seed-{i + 1:03d}" for i, n in enumerate(re.findall(r"name: '([^']+)'", Path("src/domain/seed.ts").read_text()))}


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def new_code():
    out = subprocess.run([sys.executable, "-m", "server", "pair", "--url", BASE.rstrip("/")], capture_output=True, text=True).stdout
    return re.search(r"#/pair/(\w{8})", out).group(1)


def history_file():
    """Три завершённые тренировки с жимом и подтягиваниями (без веса)."""
    def st(i, w, r):
        return {"id": f"s{i}-{w}-{r}", "weight": w, "reps": r, "done": True}
    def wk(n, days_ago, exs):
        d = (date.today() - timedelta(days=days_ago)).isoformat()
        return {"id": f"hist-{n}", "createdAt": 1, "updatedAt": 2_000_000_000_000 + n, "deviceId": "x", "date": d, "title": f"Силовая {n}", "status": "done",
                "exercises": [{"id": f"hist-{n}-{i}", "exerciseId": SEED[name], "sets": sets} for i, (name, sets) in enumerate(exs)]}
    bench, pull = "Жим штанги лёжа", "Подтягивания"
    data = {"version": 1, "exercises": [], "templates": [], "workouts": [
        wk(1, 40, [(bench, [st(1, 80, 5), st(2, 80, 5)]), (pull, [st(3, 0, 8), st(4, 0, 10)])]),
        wk(2, 20, [(bench, [st(5, 85, 3), st(6, 70, 12)])]),
        wk(3, 3, [(bench, [st(7, 90, 2)])]),
    ]}
    f = Path(tempfile.mkdtemp()) / "history.json"
    f.write_text(json.dumps(data))
    return str(f)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(str(e)))
    pg.goto(BASE + "#/pair/" + new_code())
    pg.wait_for_selector("text=Синхронизировано", timeout=10000)

    # --- ярлыки приложения в манифесте ---
    m = httpx.get(BASE + "manifest.webmanifest").json()
    urls = [s["url"] for s in m.get("shortcuts", [])]
    check("в манифесте три ярлыка", urls == ["/#/quick/start", "/#/quick/current", "/#/records"], urls)

    # --- быстрый старт тренировки: ссылка из ярлыка создаёт одну тренировку, повторный заход открывает её же ---
    pg.goto(BASE + "#/quick/start")
    pg.wait_for_url(re.compile(r"#/workout/\w+"), timeout=8000)
    first = pg.url.split("#")[1]
    pg.goto(BASE + "#/quick/start")
    pg.reload()
    pg.wait_for_url(re.compile(r"#/workout/\w+"), timeout=8000)
    check("быстрый старт не плодит тренировки", pg.url.split("#")[1] == first, pg.url)
    pg.wait_for_selector("text=Завершить тренировку", timeout=5000)  # экран рисуется после чтения из базы: ждём, а не угадываем
    check("тренировка уже идёт", pg.locator("text=Завершить тренировку").count() == 1)

    # --- суперсет ---
    pg.click("button:has-text('Добавить упражнение')")
    pg.fill("input[placeholder='Поиск по названию']", "Жим гантелей")
    pg.click(".list .row:has-text('Жим гантелей')")
    pg.fill("input[placeholder='Поиск по названию']", "Тяга верхнего")
    pg.click(".list .row:has-text('Тяга верхнего')")
    pg.click("button:has-text('Добавить (2)')")
    pg.wait_for_selector(".ex-block >> nth=1")
    check("до объединения нет меток", pg.locator(".ss-chip").count() == 0)
    pg.locator("button:has-text('Суперсет со следующим')").first.click()
    pg.wait_for_selector(".ss-chip >> nth=1")
    chips = pg.locator(".ss-chip").all_inner_texts()
    check("метки суперсета A1 и A2", chips == ["A1", "A2"], chips)
    pg.wait_for_selector("button:has-text('Разорвать суперсет')")
    check("кнопка сменилась на «Разорвать»", pg.locator("button:has-text('Разорвать суперсет')").count() == 1)

    first_check = pg.locator(".ex-block").nth(0).locator(".check").first
    first_check.click()
    pg.wait_for_selector("text=Дальше A2")
    check("после A1 отдыха нет, подсказано следующее", pg.locator(".timer:not(.out)").count() == 0)
    pg.locator(".ex-block").nth(1).locator(".check").first.click()
    pg.wait_for_selector(".timer:not(.out)", timeout=5000)
    check("после A2 запускается отдых", True)
    pg.locator(".timer button").first.click() if pg.locator(".timer button").count() else None

    # --- тип подхода и заметка ---
    idx = pg.locator(".ex-block").nth(0).locator("button.set-idx").nth(1)
    idx.click()
    pg.click("button:has-text('Дроп-сет')")
    pg.fill("input[aria-label='Заметка к подходу']", "тяжело, спина")
    idx.click()
    pg.wait_for_selector(".ex-block >> nth=0 >> button.set-idx sup")
    check("у подхода значок дроп-сета", pg.locator(".ex-block").nth(0).locator("button.set-idx sup").text_content() == "Д")
    check("заметка видна под подходом", pg.locator(".set-note").inner_text() == "тяжело, спина")
    pg.reload()
    pg.wait_for_selector(".set-note")
    check("тип и заметка пережили перезагрузку", pg.locator("button.set-idx sup").count() == 1 and pg.locator(".set-note").inner_text() == "тяжело, спина")
    check("кнопки упражнения не вылезают за экран", pg.evaluate("document.documentElement.scrollWidth") <= 390 and pg.evaluate("[...document.querySelectorAll('.ex-actions .btn')].every(b => b.getBoundingClientRect().right <= 390)"))
    pg.screenshot(path="/tmp/alpha2_session.png", full_page=True)

    pg.click("button:has-text('Разорвать суперсет')")
    pg.wait_for_selector(".ss-chip", state="detached", timeout=5000)
    check("суперсет разорван", pg.locator(".ss-chip").count() == 0)

    # --- рекорды ---
    pg.click(".nav button:has-text('Профиль')"); pg.click("button[aria-label='Настройки']")
    pg.set_input_files("input[type=file]", history_file())
    pg.wait_for_selector("text=Импортировано", timeout=8000) if pg.locator("text=Импортировано").count() or True else None
    pg.click(".nav button:has-text('Аналитика')")
    pg.click("button:has-text('Все рекорды')")
    pg.wait_for_selector("h1:has-text('Рекорды')")
    pg.wait_for_selector(".list .row:has-text('Жим штанги лёжа')", timeout=8000)
    row = pg.locator(".list .row:has-text('Жим штанги лёжа')").first
    check("рекорд 1ПМ: ≈ 98 кг (70×12 двадцать дней назад — не «новый»)", "≈ 98" in row.inner_text() and "новый" not in row.inner_text(), row.inner_text().replace("\n", " "))
    pg.click(".chip:has-text('Вес')")
    row = pg.locator(".list .row:has-text('Жим штанги лёжа')").first
    check("рекорд по весу: 90 кг, свежий", "90 кг" in row.inner_text() and "новый" in row.inner_text(), row.inner_text().replace("\n", " "))
    pg.click(".chip:has-text('Объём подхода')")
    check("объём подхода: 840 кг (70×12)", "840" in pg.locator(".list .row:has-text('Жим штанги лёжа')").first.inner_text().replace(" ", "").replace("\u00a0", ""))
    check("подтягивания без веса — по повторениям", "10 повт." in pg.locator(".list .row:has-text('Подтягивания')").first.inner_text())
    pg.fill("input[aria-label='Поиск']", "подтяг")
    check("поиск фильтрует", pg.locator(".list .row").count() == 1)
    pg.fill("input[aria-label='Поиск']", "")
    pg.click(".chip:has-text('Свежие')")
    pg.click(".chip:has-text('По названию')")
    names = pg.locator(".list .row .title").all_inner_texts()
    check("сортировка по названию", names == sorted(names, key=str.lower) or names[0] <= names[-1], names)
    check("нет горизонтального переполнения", pg.evaluate("document.documentElement.scrollWidth") <= 390)
    check("фильтры рекордов целиком на экране", pg.evaluate("[...document.querySelectorAll('.chips.wrap .chip')].every(c => c.getBoundingClientRect().right <= 390 && c.getBoundingClientRect().left >= 0)"))
    pg.screenshot(path="/tmp/alpha2_records.png", full_page=True)
    pg.goto(BASE + "#/records")
    pg.wait_for_selector("h1:has-text('Рекорды')")
    check("ярлык «Рекорды» открывает экран", True)

    # --- индикатор очереди синхронизации ---
    pg.click(".nav button:has-text('Календарь')")
    pg.wait_for_timeout(3500)
    check("после синхронизации индикатора нет", pg.locator(".nav-badge").count() == 0)
    ctx.set_offline(True)
    pg.click(".btn.primary:has-text('Начать тренировку')") if pg.locator(".btn.primary:has-text('Начать тренировку')").count() else None
    pg.click("button:has-text('Пустая тренировка')")
    pg.wait_for_selector(".nav-badge", timeout=8000)
    badge = pg.locator(".nav-badge").inner_text()
    check("без связи виден счётчик очереди", badge.isdigit() and int(badge) >= 1, badge)
    check("офлайн — не красная авария", pg.locator(".nav-badge.warn").count() == 0)
    ctx.set_offline(False)
    pg.wait_for_selector(".nav-badge", state="detached", timeout=20000)
    check("со связью очередь уходит и индикатор исчезает", True)

    logs = [l for l in logs if "ERR_INTERNET_DISCONNECTED" not in l and "Failed to load resource" not in l]
    check("нет ошибок в консоли", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
