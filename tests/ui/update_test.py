"""Крупное обновление в настоящем браузере: цели недели, прогрессия, блины, замеры тела, зона приватности, GPX, голос."""
import json, os, re, subprocess, sys
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from tests.ui.fake_gps import FAKE_GPS

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
VERSION = json.loads((Path(__file__).resolve().parents[2] / "package.json").read_text())["version"].split("-")[0]  # на экране без суффикса «-alpha»
errors = []
SPEECH = """
window.__spoken = [];
window.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance || function (t) { this.text = t; };
Object.defineProperty(window, 'speechSynthesis', { value: { speak(u) { window.__spoken.push(u.text); }, cancel() {} }, configurable: true });
"""


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def new_code():
    out = subprocess.run([sys.executable, "-m", "server", "pair", "--url", BASE.rstrip("/")], capture_output=True, text=True).stdout
    return re.search(r"#/pair/(\w{8})", out).group(1)


def new_workout_with(pg, exercise):
    pg.click(".nav button:has-text('Календарь')")
    pg.click(".btn.primary:has-text('Начать тренировку')")
    pg.click("button:has-text('Пустая тренировка')")
    pg.click("button:has-text('Добавить упражнение')")
    pg.fill("input[placeholder='Поиск по названию']", exercise)
    pg.click(f".list .row:has-text('{exercise}')")
    pg.click("button:has-text('Добавить (1)')")


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
    ctx.add_init_script(FAKE_GPS)
    ctx.add_init_script(SPEECH)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(str(e)))
    pg.goto(BASE + "#/pair/" + new_code())
    pg.wait_for_selector("text=Синхронизировано", timeout=10000)

    # --- настройки ---
    pg.click(".nav button:has-text('Профиль')"); pg.click("button[aria-label='Настройки']")
    pg.fill("#goal-km", "5")
    pg.select_option("#zone", "200")
    pg.locator(".toggle:has([aria-label='Голосовые подсказки'])").click()
    check("версия приложения видна", pg.locator(f"text=Версия {VERSION}").count() == 1)

    # --- цели недели ---
    pg.click(".nav button:has-text('Тренировка')")
    pg.wait_for_selector(".goal-card")
    txt = pg.inner_text(".goal-card")
    check("цель недели: тренировки 0 из 3", re.search(r"0\s*из 3", txt) is not None, txt.replace("\n", " "))
    check("цель недели: километры 0 из 5 км", re.search(r"0\s*из 5 км", txt) is not None)

    # --- первая силовая тренировка: 3 × 80 × 12 ---
    new_workout_with(pg, "Жим штанги лёжа")
    pg.wait_for_selector(".set-row")
    rows = pg.locator(".set-row")
    for i in range(rows.count()):
        r = rows.nth(i)
        r.locator("input[aria-label='кг']").fill("80"); r.locator("input[aria-label='кг']").press("Tab")
        r.locator("input[aria-label='повт.']").fill("12"); r.locator("input[aria-label='повт.']").press("Tab")
        r.locator("button.check").click()
    pg.click("button:has-text('Завершить тренировку')")
    pg.wait_for_selector("text=Тренировка завершена")
    pg.click("button:has-text('Готово')")

    # --- вторая: подсказка прогрессии и блины ---
    new_workout_with(pg, "Жим штанги лёжа")
    pg.wait_for_selector("text=Идея на сегодня: 82.5×8", timeout=8000)
    check("подсказка: прибавить вес после 12 повторов", True)
    check("виден прошлый раз", pg.locator("text=В прошлый раз: 80×12").count() >= 1)
    pg.click("button:has-text('Подставить')")
    expect(pg.locator(".set-row >> nth=0 >> input[aria-label='кг']")).to_have_value("82.5")
    check("подсказка подставлена в подходы", pg.input_value(".set-row >> nth=0 >> input[aria-label='повт.']") == "8")
    check("подсказка исчезла после применения", pg.locator("text=Идея на сегодня").count() == 0)
    pg.click("button:has-text('Блины')")
    pg.wait_for_selector(".plates")
    plates = [t.strip() for t in pg.locator(".plate").all_inner_texts()]
    check("82.5 кг на грифе 20: по 25, 5 и 1.25 на сторону", plates == ["25", "5", "1.25"], plates)
    check("итого 82.5", pg.locator("text=Итого на штанге: 82.5 кг").count() == 1)
    pg.fill("#pl-w", "17")
    check("меньше грифа: понятное сообщение", pg.locator("text=меньше грифа").count() == 1)
    pg.click("button[aria-label='Закрыть']")
    pg.wait_for_selector(".plates", state="detached")
    pg.locator(".set-row >> nth=0").locator("button.check").click()
    pg.click("button:has-text('Завершить тренировку')")
    pg.wait_for_selector("text=Тренировка завершена")
    pg.click("button:has-text('Готово')")
    pg.click(".nav button:has-text('Тренировка')")
    pg.wait_for_selector(".goal-card")
    check("цель недели: 2 тренировки", re.search(r"2\s*из 3", pg.inner_text(".goal-card")) is not None, pg.inner_text(".goal-card").replace("\n", " "))

    # --- замеры тела ---
    pg.click(".nav button:has-text('Аналитика')")
    pg.wait_for_selector("h2:has-text('Тело')")
    pg.click("button:has-text('Записать замер')")
    pg.fill("#b-date", (date.today() - timedelta(days=7)).isoformat())
    pg.fill("#b-w", "79,2"); pg.fill("#b-c", "85")
    pg.click(".sheet button:has-text('Сохранить')")
    pg.wait_for_selector("text=Замер сохранён")
    pg.click("button:has-text('Записать замер')")
    pg.fill("#b-w", "999")
    check("нереальный вес не принимается", pg.locator(".sheet button:has-text('Сохранить')").is_disabled())
    pg.fill("#b-w", "78,4")
    pg.click(".sheet button:has-text('Сохранить')")
    pg.wait_for_timeout(1500)
    body = pg.inner_text(".section:has(h2:has-text('Тело'))")
    check("вес и динамика за 30 дней", "78.4" in body and re.search(r"[-−]0\.8", body) is not None, body.replace("\n", " ")[:140])
    check("талия показана", "85" in body)
    check("график веса", pg.locator(".section:has(h2:has-text('Тело')) svg.chart").count() == 1)

    # --- пробежка: зона приватности, GPX, голос ---
    new_workout_with(pg, "Бег")
    pg.click("button:has-text('Начать запись GPS')")
    pg.wait_for_selector(".rec-screen")
    t0 = 1_700_000_000_000
    pg.evaluate("t => window.__gps.run(t, 0, 3, 366, 5, 100)", t0)                  # 1098 м
    pg.wait_for_timeout(1500)
    pg.evaluate("t => window.__gps.run(t, 1098, 3, 334, 5, 100)", t0 + 366_000)      # до 2100 м
    pg.wait_for_timeout(1500)
    spoken = pg.evaluate("window.__spoken")
    check("голос после 1 и 2 км", len(spoken) == 2 and spoken[0].startswith("1 километр. Темп 5 минут") and spoken[1].startswith("2 километра."), spoken)
    pg.click(".rec-screen button:has-text('Завершить')")
    pg.wait_for_selector(".cardio-grid")
    check("пояснение про зону приватности", pg.locator("text=зона приватности 200 м").count() == 1)
    with pg.expect_download() as d:
        pg.click("button:has-text('Экспорт GPX')")
    path = d.value.path()
    gpx = open(path, encoding="utf-8").read()
    check("файл .gpx", d.value.suggested_filename.endswith(".gpx"), d.value.suggested_filename)
    lats = [float(x) for x in re.findall(r'<trkpt lat="([\d.]+)"', gpx)]
    check("GPX: начало срезано на 200 м", len(lats) >= 2 and 55.7517 <= lats[0] <= 55.7519, lats[:2])
    check("GPX: конец срезан на 200 м", abs(lats[-1] - (55.75 + (2100 - 200) / 111195)) < 0.0002, lats[-2:])
    check("GPX валиден", gpx.startswith("<?xml") and "</gpx>" in gpx)
    check("нет горизонтального переполнения", pg.evaluate("document.documentElement.scrollWidth") <= 390)
    pg.screenshot(path="/tmp/update_run.png", full_page=True)

    logs = [l for l in logs if "geolocation" not in l.lower()]
    check("нет ошибок в консоли", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
