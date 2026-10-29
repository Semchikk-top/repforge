"""Версия 0.3: тема, RPE и прогрессия, программы, экспорт за период, фото, конфликты синхронизации, напоминания,
анализ темпа, профиль высоты, цвет маршрута по темпу, сравнение маршрутов, подсказки ассистента."""
import base64, io, json, os, re, struct, subprocess, sys, tempfile, zlib
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

from tests.ui.fake_gps import FAKE_GPS

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
errors = []
SEED = {n: f"seed-{i + 1:03d}" for i, n in enumerate(re.findall(r"name: '([^']+)'", Path("src/domain/seed.ts").read_text()))}
BENCH = SEED["Жим штанги лёжа"]
TODAY = date.today().isoformat()

CONTRAST_JS = """
(sel) => {
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const bg = (el) => { while (el) { const c = getComputedStyle(el).backgroundColor; const m = c.match(/[\\d.]+/g); if (m && (m.length < 4 || Number(m[3]) > 0.9)) return c; el = el.parentElement; } return 'rgb(255,255,255)'; };
  const el = document.querySelector(sel); if (!el) return null;
  const a = lum(getComputedStyle(el).color), b = lum(bg(el));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
"""


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def new_code():
    out = subprocess.run([sys.executable, "-m", "server", "pair", "--url", BASE.rstrip("/")], capture_output=True, text=True).stdout
    return re.search(r"#/pair/(\w{8})", out).group(1)


def png(color):
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    w = h = 8
    raw = b"".join(b"\x00" + bytes(color) * w for _ in range(h))
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    f = Path(tempfile.mkdtemp()) / f"p{color[0]}.png"
    f.write_bytes(data)
    return str(f)


def history_file():
    def st(i, w, r, **kw):
        return {"id": f"s{i}", "weight": w, "reps": r, "done": True, **kw}
    d = lambda n: (date.today() - timedelta(days=n)).isoformat()
    wk = lambda n, days, sets, title="Силовая": {"id": f"h{n}", "createdAt": 1, "updatedAt": 2_000_000_000_000 + n, "deviceId": "x", "date": d(days), "title": title, "status": "done",
                                                  "exercises": [{"id": f"h{n}e", "exerciseId": BENCH, "sets": sets}]}
    data = {"version": 1, "exercises": [], "workouts": [
        wk(1, 5, [st(1, 80, 12, rpe=10), st(2, 80, 12, rpe=10)]),
        wk(2, 60, [st(3, 70, 8, note="=1+1")], title="Старая"),
        {"id": "plan1", "createdAt": 1, "updatedAt": 2_000_000_000_050, "deviceId": "x", "date": TODAY, "title": "План на сегодня", "status": "planned", "exercises": []},
    ], "templates": [{"id": "tpl1", "title": "Грудь", "createdAt": 1, "updatedAt": 2_000_000_000_001, "deviceId": "x", "exercises": [{"exerciseId": BENCH, "sets": 3, "reps": 10, "weight": 60}]}]}
    f = Path(tempfile.mkdtemp()) / "hist.json"
    f.write_text(json.dumps(data))
    return str(f)


def wait_for(page, expr, arg=None, timeout=15000):
    """Ждём выражение опросом: wait_for_function выполняет строку через eval, а CSP приложения (script-src 'self') его запрещает."""
    import time
    end = time.time() + timeout / 1000
    while time.time() < end:
        if (page.evaluate(expr, arg) if arg is not None else page.evaluate(expr)):
            return
        page.wait_for_timeout(200)
    raise TimeoutError(f"не дождались: {expr}")


def settings_import(pg, path):
    pg.click(".nav button:has-text('Профиль')"); pg.click("button[aria-label='Настройки']")
    pg.set_input_files("input[type=file][accept*='json']", path)
    pg.wait_for_selector("text=Импортировано")


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True, color_scheme="light")
    ctx.add_init_script(FAKE_GPS)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(str(e)))
    pg.goto(BASE + "#/pair/" + new_code())
    pg.wait_for_selector("text=Синхронизировано", timeout=10000)

    # ---------- тема ----------
    check("по умолчанию тёмная, даже если система светлая", pg.evaluate("document.documentElement.dataset.theme") == "dark")
    settings_import(pg, history_file())
    pg.click(".seg button:has-text('Светлая')")
    check("светлая тема применилась", pg.evaluate("document.documentElement.dataset.theme") == "light")
    bg = pg.evaluate("getComputedStyle(document.body).backgroundColor")
    check("фон светлый", sum(int(x) for x in re.findall(r"\d+", bg)[:3]) > 600, bg)
    pg.reload()
    pg.wait_for_selector("text=Внешний вид")
    check("тема переживает перезагрузку", pg.evaluate("document.documentElement.dataset.theme") == "light")
    pg.click(".seg button:has-text('Как в системе')")
    check("авто + светлая система = светлая", pg.evaluate("document.documentElement.dataset.theme") == "light")
    pg.emulate_media(color_scheme="dark")
    wait_for(pg, "document.documentElement.dataset.theme === 'dark'")
    check("авто следует за системой", True)
    pg.click(".seg button:has-text('Светлая')")
    pg.emulate_media(color_scheme="light")

    # ---------- RPE и подсказка прогрессии ----------
    pg.click(".nav button:has-text('Календарь')")
    pg.click(".btn.primary:has-text('Начать тренировку')")
    pg.click("button:has-text('Пустая тренировка')")
    pg.click("button:has-text('Добавить упражнение')")
    pg.fill("input[placeholder='Поиск по названию']", "Жим штанги лёжа")
    pg.click(".list .row:has-text('Жим штанги лёжа')")
    pg.click("button:has-text('Добавить (1)')")
    pg.wait_for_selector(".hint.suggest")
    hint = pg.inner_text(".hint.suggest")
    check("после RPE 10 подсказка «не прибавляй»", "на пределе" in hint and pg.locator(".hint.suggest.hold").count() == 1, hint.replace("\n", " "))
    pg.locator("button.set-idx").first.click()
    pg.click(".chips[aria-label='Усилие, RPE'] .chip:has-text('9')")
    pg.locator("button.set-idx").first.click()
    check("RPE виден под подходом", "RPE 9" in pg.locator(".set-note").first.inner_text())
    pg.screenshot(path="/tmp/light_session.png", full_page=True)
    check("контраст основного текста ≥ 4.5", (pg.evaluate(CONTRAST_JS, ".ex-name") or 0) >= 4.5)
    check("контраст подсказки ≥ 4.5", (pg.evaluate(CONTRAST_JS, ".hint.suggest .why") or 0) >= 4.5, pg.evaluate(CONTRAST_JS, ".hint.suggest .why"))
    check("контраст приглушённого текста ≥ 4.5", (pg.evaluate(CONTRAST_JS, ".sub, .meta") or 0) >= 4.5)
    check("контраст главной кнопки ≥ 4.5", (pg.evaluate(CONTRAST_JS, ".btn.primary") or 0) >= 4.5, pg.evaluate(CONTRAST_JS, ".btn.primary"))

    # ---------- «спросить ассистента» из подсказки ----------
    pg.locator(".hint.suggest button:has-text('Спросить ассистента')").click()
    pg.wait_for_selector("textarea[aria-label='Сообщение ассистенту']")
    wait_for(pg, "document.querySelector(\"textarea[aria-label='Сообщение ассистенту']\").value.length > 0")
    ta = pg.input_value("textarea[aria-label='Сообщение ассистенту']")
    check("вопрос подставлен, но не отправлен", "Жим штанги лёжа" in ta and pg.locator(".msg-user, .msg.user").count() == 0, ta[:60])
    check("«Сохранить» неактивна без диалога", pg.locator("header button:has-text('Сохранить')").is_disabled())

    # ---------- программы ----------
    pg.goto(BASE + "#/programs")
    pg.wait_for_selector("h1:has-text('Программы')")
    pg.click("button:has-text('Создать программу')")
    pg.fill("#pg-title", "Сила на 2 недели")
    pg.fill("#pg-weeks", "2")
    pg.click(".chips[aria-label='Дни недели'] .chip:has-text('Пн')")
    pg.click(".chips[aria-label='Дни недели'] .chip:has-text('Чт')")
    check("для выбранных дней есть выбор шаблона", pg.locator("select[aria-label^='Шаблон на']").count() == 2)
    pg.click("button:has-text('Сохранить')")
    pg.wait_for_selector(".program-row")
    pg.click("button:has-text('Назначить в календарь')")
    pg.wait_for_selector("text=Назначено тренировок")
    first = pg.locator(".toast, [role=status]").last.inner_text() if pg.locator(".toast, [role=status]").count() else ""
    check("назначены тренировки", "Назначено тренировок" in pg.content())
    pg.wait_for_timeout(2600)
    pg.click("button:has-text('Назначить в календарь')")
    pg.wait_for_selector("text=Новых тренировок нет")
    check("повторное назначение не создаёт дубликатов", True)
    pg.screenshot(path="/tmp/light_programs.png", full_page=True)
    pg.once("dialog", lambda d: d.accept())
    pg.click("button[aria-label^='Удалить программу']")
    pg.wait_for_selector("text=Программа удалена")
    check("при удалении программы убраны её тренировки", "убрано тренировок" in pg.content())

    # ---------- напоминание ----------
    pg.click(".nav button:has-text('Профиль')"); pg.click("button[aria-label='Настройки']")
    pg.locator(".row:has-text('Напоминать о тренировке') .toggle").click()
    pg.fill("#rem-time", "00:00")
    pg.reload()
    pg.wait_for_selector(".reminder", timeout=8000)
    check("напоминание про запланированную на сегодня тренировку", "План на сегодня" in pg.inner_text(".reminder"))
    pg.click(".reminder button:has-text('Скрыть')")
    pg.wait_for_timeout(500)  # запись «скрыто на сегодня» должна успеть сохраниться
    pg.reload()
    pg.wait_for_selector("text=Внешний вид")
    pg.wait_for_timeout(800)
    check("скрытое напоминание не возвращается в тот же день", pg.locator(".reminder").count() == 0)

    # ---------- экспорт за период ----------
    pg.click("button:has-text('Экспорт за период')")
    pg.click(".chips[aria-label='Период'] .chip:has-text('30 дней')")
    with pg.expect_download() as dl:
        pg.click("button:has-text('Таблица тренировок (CSV)')")
    csv = Path(dl.value.path()).read_text(encoding="utf-8")
    check("CSV начинается с BOM и заголовка", csv.startswith("\ufeffДата;Тренировка;Упражнение"))
    check("в CSV только тренировки за 30 дней", "Силовая" in csv and "Старая" not in csv)
    with pg.expect_download() as dl2:
        pg.click("button:has-text('Резервная копия (JSON)')")
    backup = json.loads(Path(dl2.value.path()).read_text(encoding="utf-8"))
    titles = [w["title"] for w in backup["workouts"]]
    check("в резервной копии нет тренировок вне периода", "Силовая" in titles and "Старая" not in titles, titles)
    pg.click(".chips[aria-label='Период'] .chip:has-text('Всё время')")
    with pg.expect_download() as dl3:
        pg.click("button:has-text('Таблица тренировок (CSV)')")
    csv_all = Path(dl3.value.path()).read_text(encoding="utf-8")
    check("ячейка-формула обезврежена", "'=1+1" in csv_all and ";=1+1" not in csv_all)
    pg.click("button:has-text('Все маршруты (GPX)')")
    pg.wait_for_selector("text=За этот период нет маршрутов")
    check("без маршрутов GPX не создаётся", True)
    pg.screenshot(path="/tmp/light_export.png", full_page=True)
    pg.click("[role=dialog] button[aria-label='Закрыть']")
    pg.wait_for_selector("[role=dialog]", state="detached", timeout=5000)

    # ---------- фото прогресса ----------
    pg.click(".nav button:has-text('Аналитика')")
    pg.wait_for_selector("h2:has-text('Фото прогресса')")
    pg.set_input_files("input[aria-label='Выбрать фото']", [png((200, 60, 60)), png((60, 60, 200))])
    pg.wait_for_selector(".photo-thumb >> nth=1", timeout=8000)
    check("два фото добавлены", pg.locator(".photo-thumb").count() == 2)
    pg.click("button:has-text('Сравнить')")
    pg.locator(".photo-thumb").nth(0).click()
    pg.locator(".photo-thumb").nth(1).click()
    pg.wait_for_selector(".photo-compare")
    check("сравнение двух фото рядом", pg.locator(".photo-compare img").count() == 2)
    pg.click("[role=dialog] button[aria-label='Закрыть']")
    pg.locator(".photo-thumb").first.click()
    pg.once("dialog", lambda d: d.accept())
    pg.click("button:has-text('Удалить фото')")
    pg.locator(".photo-thumb").nth(1).wait_for(state="detached", timeout=8000)  # liveQuery асинхронна
    check("фото удаляется", pg.locator(".photo-thumb").count() == 1)
    n = pg.evaluate("indexedDB.databases().then(d => d.length)")
    pg.screenshot(path="/tmp/light_stats.png", full_page=True)

    # ---------- анализ темпа, высота, цвет, сравнение маршрутов ----------
    def record_run(start_url):
        pg.goto(BASE + start_url)
        pg.wait_for_url(re.compile(r"#/workout/\w+"), timeout=8000)
        pg.click("button:has-text('Добавить упражнение')")
        pg.fill("input[placeholder='Поиск по названию']", "Бег")
        pg.click(".list .row:has-text('Бег')")
        pg.click("button:has-text('Добавить (1)')")
        pg.click("button:has-text('Начать запись GPS')")
        pg.wait_for_selector(".rec-screen")
        t = 1_700_000_000_000
        m = pg.evaluate("t => window.__gps.run(t, 0, 3.4, 300, 5, 120)", t)
        m = pg.evaluate("([t, m]) => window.__gps.run(t, m, 3.0, 340, 5, 150)", [t + 400_000, m])
        pg.evaluate("([t, m]) => window.__gps.run(t, m, 2.7, 380, 5, 170)", [t + 900_000, m])
        pg.wait_for_timeout(1300)
        pg.click(".rec-screen button:has-text('Завершить')")
        pg.wait_for_selector(".cardio-grid", timeout=8000)

    pg.click(".nav button:has-text('Тренировка')")
    for w in pg.locator("button:has-text('Удалить тренировку')").all():
        pass
    record_run("#/quick/start")
    txt = pg.inner_text(".cardio")
    check("анализ темпа: вторая половина медленнее", "вторая половина медленнее" in txt, txt[-200:].replace("\n", " "))
    check("профиль высоты нарисован", pg.locator("svg[aria-label='Профиль высоты']").count() == 1)
    base_paths = pg.locator(".cardio svg.route path").count()
    pg.click("button:has-text('Цвет по темпу')")
    colored = pg.locator(".cardio svg.route path").count()
    check("цвет по темпу: несколько цветных участков", colored > base_paths and colored >= 3, (base_paths, colored))
    pg.screenshot(path="/tmp/light_cardio.png", full_page=True)
    pg.click("button:has-text('Завершить тренировку')")
    pg.wait_for_selector("text=Тренировка завершена")
    pg.click("button:has-text('Готово')")
    record_run("#/quick/start")
    pg.click("button:has-text('Тот же маршрут')")
    pg.wait_for_selector("text=Найдено прошлых пробежек: 1", timeout=8000)
    check("найдена прошлая пробежка по тому же маршруту", True)
    pg.click("[role=dialog] .row")
    check("маршрут наложен пунктиром", pg.locator("[role=dialog] svg.route path[stroke-dasharray]").count() == 1)
    pg.screenshot(path="/tmp/light_compare.png", full_page=True)

    logs = [l for l in logs if "geolocation" not in l.lower()]
    check("нет ошибок в консоли", not logs, logs[:3])

    # ---------- конфликты синхронизации: два устройства ----------
    ca = b.new_context(viewport={"width": 390, "height": 844})
    cb = b.new_context(viewport={"width": 390, "height": 844})
    a, bpg = ca.new_page(), cb.new_page()
    a.goto(BASE + "#/pair/" + new_code()); a.wait_for_selector("text=Синхронизировано", timeout=10000)
    bpg.goto(BASE + "#/pair/" + new_code()); bpg.wait_for_selector("text=Синхронизировано", timeout=10000)
    a.click(".nav button:has-text('Календарь')")
    a.click(".btn.primary:has-text('Начать тренировку')")
    a.click("button:has-text('Пустая тренировка')")  # всегда новая тренировка (быстрый старт мог бы открыть чужую активную)
    a.wait_for_url(re.compile(r"#/workout/\w+"))
    wid = a.url.split("/workout/")[1]
    a.wait_for_timeout(800)
    wait_for(a, "document.querySelector('.nav-badge') === null", timeout=20000)
    a.wait_for_timeout(800)
    bpg.reload()
    bpg.wait_for_timeout(2500)  # синхронизация запускается при загрузке страницы
    bpg.goto(BASE + f"#/workout/{wid}")
    bpg.wait_for_selector("textarea", timeout=15000)
    note = "textarea"
    ca.set_offline(True)
    a.fill(note, "правка с телефона A")
    a.wait_for_timeout(1500)
    bpg.fill(note, "правка с устройства B")
    bpg.wait_for_timeout(800)   # правка должна попасть в очередь, иначе «очередь пуста» увидим раньше времени
    wait_for(bpg, "document.querySelector('.nav-badge') === null", timeout=20000)
    bpg.wait_for_timeout(800)
    ca.set_offline(False)
    a.reload()  # связь вернулась: синхронизация стартует при загрузке
    a.click(".nav button:has-text('Профиль')"); a.click("button[aria-label='Настройки']")
    a.wait_for_selector("h2:has-text('Конфликты синхронизации')", timeout=25000)
    check("конфликт обнаружен и показан", "правки с устройства B" not in a.inner_text("h2:has-text('Конфликты')"))
    check("в навигации сигнал о конфликте", a.locator(".nav-badge.warn").count() == 1)
    a.click("button:has-text('Вернуть мою')")
    a.wait_for_selector("h2:has-text('Конфликты синхронизации')", state="detached")
    a.goto(BASE + f"#/workout/{wid}")
    a.wait_for_selector("textarea")
    check("моя версия возвращена", a.input_value(note) == "правка с телефона A", a.input_value(note))
    a.wait_for_timeout(800)
    wait_for(a, "document.querySelector('.nav-badge') === null", timeout=20000)   # возвращённая правка ушла на сервер
    a.wait_for_timeout(800)
    bpg.reload()
    bpg.wait_for_selector("textarea")
    wait_for(bpg, "(s) => document.querySelector('textarea').value === s", arg="правка с телефона A", timeout=25000)
    check("возвращённая версия доехала до второго устройства", True)
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
