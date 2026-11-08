"""RF-003: перемещение упражнений в тренировке настоящим указателем в Chromium.
Проверяет: порядок после перетаскивания вниз и вверх, сохранение порядка после перезагрузки,
что обычное касание ручки ничего не двигает, и что тест не ходит в сеть (все запросы только к своему серверу)."""
import os, re, sys
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
TODAY = date.today().isoformat()
SEED = {n: f"seed-{i + 1:03d}" for i, n in enumerate(re.findall(r"name: '([^']+)'", Path("src/domain/seed.ts").read_text()))}
NAMES = ["Жим штанги лёжа", "Приседания со штангой", "Становая тяга"]
errors = []

PUT = """
([store, row]) => new Promise((res, rej) => {
  const open = indexedDB.open('workout-pwa');
  open.onerror = () => rej(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(row);
    tx.oncomplete = () => { db.close(); res(true); };
    tx.onerror = () => rej(tx.error);
  };
})
"""


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def order(pg):
    return [t.strip() for t in pg.locator(".ex-block .ex-name").all_inner_texts()]


def drag(pg, src_idx, dy_extra, to_idx):
    """Тянет ручку блока src_idx так, чтобы его центр оказался чуть ниже (или выше) центра блока to_idx."""
    blocks = pg.locator(".ex-block")
    handle = blocks.nth(src_idx).locator(".drag-handle")
    hb = handle.bounding_box()
    sb = blocks.nth(src_idx).bounding_box()
    tb = blocks.nth(to_idx).bounding_box()
    dy = (tb["y"] + tb["height"] / 2) - (sb["y"] + sb["height"] / 2) + dy_extra
    x, y = hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2
    pg.mouse.move(x, y)
    pg.mouse.down()
    steps = 12
    for i in range(1, steps + 1):
        pg.mouse.move(x, y + dy * i / steps)
        pg.wait_for_timeout(16)
    pg.mouse.up()
    pg.wait_for_timeout(500)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 1900})  # все три блока на одном экране: автопрокрутка не мешает
    pg = ctx.new_page()
    foreign = []
    host = urlparse(BASE).netloc
    pg.on("request", lambda r: foreign.append(r.url) if urlparse(r.url).scheme in ("http", "https") and urlparse(r.url).netloc != host else None)
    pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    pg.goto(BASE)
    pg.wait_for_selector(".cal-grid")

    now = 1_790_000_000_000
    sets = lambda wid: [{"id": f"{wid}-{i}", "weight": 50, "reps": 10, "done": False} for i in range(3)]
    pg.evaluate(PUT, ["workouts", {
        "id": "reorder-1", "createdAt": now, "updatedAt": now, "deviceId": "t", "date": TODAY, "title": "Перестановка", "status": "planned",
        "exercises": [{"id": f"we{i}", "exerciseId": SEED[n], "sets": sets(f"we{i}")} for i, n in enumerate(NAMES)],
    }])
    pg.goto(BASE + "#/workout/reorder-1")
    pg.reload()
    pg.wait_for_selector(".ex-block .drag-handle")
    check("исходный порядок", order(pg) == NAMES, order(pg))
    check("у каждого блока есть ручка", pg.locator(".ex-block .drag-handle").count() == 3)

    # обычное касание ручки не двигает и не пишет «Порядок изменён»
    pg.locator(".ex-block").nth(0).locator(".drag-handle").click()
    pg.wait_for_timeout(400)
    check("касание ручки не меняет порядок", order(pg) == NAMES, order(pg))
    check("касание не показывает «Порядок изменён»", pg.get_by_text("Порядок изменён").count() == 0)

    # вниз: первое упражнение уходит на последнее место
    drag(pg, 0, 40, 2)
    check("перетаскивание вниз", order(pg) == [NAMES[1], NAMES[2], NAMES[0]], order(pg))
    check("после переноса показана отмена", pg.get_by_text("Порядок изменён").count() >= 1)

    # порядок пережил перезагрузку
    pg.reload()
    pg.wait_for_selector(".ex-block .drag-handle")
    check("порядок сохранился после перезагрузки", order(pg) == [NAMES[1], NAMES[2], NAMES[0]], order(pg))

    # вверх: последнее упражнение поднимается на первое место
    drag(pg, 2, -40, 0)
    check("перетаскивание вверх", order(pg) == [NAMES[0], NAMES[1], NAMES[2]], order(pg))
    pg.reload()
    pg.wait_for_selector(".ex-block .drag-handle")
    check("порядок сохранился и после второго переноса", order(pg) == NAMES, order(pg))

    # короткое движение (меньше середины соседа) тоже ничего не меняет
    blocks = pg.locator(".ex-block")
    hb = blocks.nth(1).locator(".drag-handle").bounding_box()
    x, y = hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2
    pg.mouse.move(x, y); pg.mouse.down(); pg.mouse.move(x, y + 10); pg.mouse.move(x, y + 14); pg.mouse.up()
    pg.wait_for_timeout(400)
    check("сдвиг на несколько пикселей не переставляет блоки", order(pg) == NAMES, order(pg))

    # кнопка «Выше/Ниже» работает как запасной путь без перетаскивания
    pg.get_by_role("button", name="Упражнение ниже").first.click()
    pg.wait_for_timeout(300)
    check("кнопка «ниже» двигает упражнение", order(pg) == [NAMES[1], NAMES[0], NAMES[2]], order(pg))

    check("тест не зависит от сети: запросов к чужим адресам нет", not foreign, foreign[:3])
    browser.close()

if errors:
    print("\nОШИБКИ:", *errors, sep="\n  ")
    sys.exit(1)
print("\nВсё в порядке")
