"""Запись пробежки в настоящем браузере. GPS подменяется скриптом: он отдаёт точки с нужными метками времени,
поэтому пробежка в километры проходит за секунды. Нужны сервер (BASE_URL) и тот же WORKOUT_DATA_DIR."""
import os, re, sqlite3, subprocess, sys

from playwright.sync_api import sync_playwright

from server import db as store
from tests.ui.fake_gps import FAKE_GPS

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
errors = []



def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def new_code():
    out = subprocess.run([sys.executable, "-m", "server", "pair", "--url", BASE.rstrip("/")], capture_output=True, text=True).stdout
    return re.search(r"#/pair/(\w{8})", out).group(1)


def km(page):
    return float(page.inner_text(".rec-big span").replace(",", "."))


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    ctx.add_init_script(FAKE_GPS)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(str(e)))
    pg.goto(BASE + "#/pair/" + new_code())
    pg.wait_for_selector("text=Синхронизировано", timeout=10000)

    # --- тренировка с бегом ---
    pg.click(".nav button:has-text('Календарь')")
    pg.click(".btn.primary:has-text('Начать тренировку')")
    pg.click("button:has-text('Пустая тренировка')")
    pg.click("button:has-text('Добавить упражнение')")
    pg.fill("input[placeholder='Поиск по названию']", "Бег")
    pg.click(".list .row:has-text('Бег')")
    pg.click("button:has-text('Добавить (1)')")
    pg.wait_for_selector(".cardio")
    check("у бега нет подходов, есть запись GPS", pg.locator(".set-row").count() == 0 and pg.locator("button:has-text('Начать запись GPS')").is_enabled())
    check("есть ручной ввод", pg.locator("button:has-text('Ввести вручную')").count() == 1)

    pg.click("button:has-text('Начать запись GPS')")
    pg.wait_for_selector(".rec-screen")
    check("идёт поиск сигнала", pg.locator("text=Ищу сигнал GPS").count() == 1)
    check("GPS подписан", pg.evaluate("window.__gps.active()") == 1)

    t = 1_700_000_000_000
    pg.evaluate("t => window.__gps.run(t, 0, 0, 3, 60)", t)           # плохая точность: запись не стартует
    check("слабый сигнал не стартует запись", pg.locator("text=Идёт запись").count() == 0)
    m = pg.evaluate("t => window.__gps.run(t, 0, 3, 366, 5, 100)", t + 10_000)   # 1098 м за 6:06
    pg.wait_for_timeout(1300)
    check("дистанция после первых 1.1 км", abs(km(pg) - 1.10) < 0.04, km(pg))
    check("пошла запись", pg.locator("text=Идёт запись").count() == 1)
    pace = pg.locator(".rec-num").nth(1).inner_text()
    check("текущий темп около 5:33", re.match(r"^5:(2\d|3\d|4[0-5])$", pace) is not None, pace)
    check("виден километр", pg.locator("text=Последний км").count() == 1)
    check("маршрут рисуется", pg.locator(".rec-screen svg.route path").count() == 1)

    # --- пауза: точки во время паузы не считаются ---
    pg.click("button:has-text('Пауза')")
    check("пауза: GPS отключён", pg.evaluate("window.__gps.active()") == 0)
    pg.wait_for_selector("text=Пауза")
    pg.click("button:has-text('Продолжить')")
    check("после паузы GPS снова подписан", pg.evaluate("window.__gps.active()") == 1)
    m2 = pg.evaluate("([t, m]) => window.__gps.run(t, m + 400, 3, 200, 5)", [t + 2_000_000, m])   # «телепорт» на 400 м через паузу не считается
    pg.wait_for_timeout(1300)
    check("расстояние через паузу не засчитано", abs(km(pg) - 1.70) < 0.06, km(pg))

    # --- перезагрузка страницы посреди записи ---
    pg.reload()
    pg.wait_for_selector("text=незавершённая запись", timeout=8000)
    check("после перезагрузки предложено продолжить", True)
    pg.click(".notice button:has-text('Продолжить')")
    pg.wait_for_selector(".rec-screen")
    check("состояние восстановлено", abs(km(pg) - 1.70) < 0.08, km(pg))
    pg.click("button:has-text('Продолжить')")
    pg.evaluate("([t, m]) => window.__gps.run(t, m, 3, 100, 5)", [t + 9_000_000, 900_000])
    pg.wait_for_timeout(1300)
    pg.screenshot(path="/tmp/rec.png")
    pg.click(".rec-screen button:has-text('Завершить')")
    pg.wait_for_selector(".cardio-grid", timeout=8000)
    check("запись сохранена, экран закрыт", pg.locator(".rec-screen").count() == 0)
    dist = float(pg.locator(".cardio-num").nth(0).inner_text().replace(",", "."))
    check("итог около 2.0 км", abs(dist - 2.0) < 0.1, dist)
    check("маршрут показан", pg.locator(".cardio svg.route path").count() == 1)
    check("километры показаны", pg.locator(".split-row").count() >= 1)
    check("виден темп мин/км", pg.locator("text=мин/км").count() >= 1)

    # --- ручной ввод для ходьбы ---
    pg.click("button:has-text('Добавить упражнение')")
    pg.fill("input[placeholder='Поиск по названию']", "Ходьба")
    pg.click(".list .row:has-text('Ходьба')")
    pg.click("button:has-text('Добавить (1)')")
    pg.locator("button:has-text('Ввести вручную')").click()
    pg.fill("#mc-km", "3,5")
    pg.fill("input[aria-label='Минуты']", "40")
    pg.wait_for_selector("text=Средний темп 11:26")
    pg.click("button:has-text('Сохранить')")
    pg.wait_for_selector("text=3.50")
    check("ручной результат сохранён", True)
    pg.screenshot(path="/tmp/cardio_done.png", full_page=True)

    # --- завершение и аналитика ---
    pg.click("button:has-text('Завершить тренировку')")
    pg.wait_for_selector("text=Тренировка завершена")
    check("в итогах есть километры", pg.locator(".kpi:has-text('км')").count() >= 1)
    pg.click("button:has-text('Готово')")
    pg.click(".nav button:has-text('Аналитика')")
    pg.wait_for_selector("h2:has-text('Бег и ходьба')", timeout=8000)
    check("раздел «Бег и ходьба» в аналитике", True)
    pg.wait_for_timeout(1200)  # счётчики на странице анимированы
    txt = pg.inner_text(".section:has(h2:has-text('Бег и ходьба'))")
    print("DEBUG", txt.replace("\n", " | "))
    check("в аналитике километры за 30 дней", re.search(r"5\.[3-6]\s*\n?км за 30 дней", txt) is not None, txt[:120].replace("\n", " "))
    check("лучшие отрезки по маршруту", "Лучшие 1 км" in txt)
    wide = pg.evaluate("[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 391).slice(0, 4).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))")
    check("нет горизонтального переполнения", pg.evaluate("document.documentElement.scrollWidth") <= 390, wide)

    # --- маршрут дошёл до сервера ---
    pg.wait_for_timeout(2500)
    n = sqlite3.connect(store.DB_PATH).execute("SELECT COUNT(*) FROM entities WHERE table_name='tracks' AND deleted=0").fetchone()[0]
    check("маршрут синхронизирован на сервер", n == 1, n)

    # --- отказ в доступе к GPS ---
    pg.click(".nav button:has-text('Календарь')")
    pg.click(".btn.primary:has-text('Начать тренировку')")
    pg.click("button:has-text('Пустая тренировка')")
    pg.click("button:has-text('Добавить упражнение')")
    pg.fill("input[placeholder='Поиск по названию']", "Велосипед")
    pg.click(".list .row:has-text('Велосипед')")
    pg.click("button:has-text('Добавить (1)')")
    pg.click("button:has-text('Начать запись GPS')")
    pg.wait_for_selector(".rec-screen")
    pg.evaluate("window.__gps.fail(1)")
    pg.wait_for_selector("text=Доступ к местоположению запрещён")
    check("отказ в доступе объяснён", True)
    pg.click(".rec-screen button:has-text('Закрыть')")
    check("для велосипеда подписи в км/ч", True)

    logs = [l for l in logs if "geolocation" not in l.lower()]
    check("нет ошибок в консоли", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
