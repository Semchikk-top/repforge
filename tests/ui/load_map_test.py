"""Карта нагрузки (1.4.0): в «Глубокой» аналитике, рядом с розой; работает без сети; период 7/28 дней; числа текстом."""
import os, re
from datetime import date, timedelta
from pathlib import Path
BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8000/")
from playwright.sync_api import sync_playwright

TODAY = date.today()
SEED = {n: f"seed-{i + 1:03d}" for i, n in enumerate(re.findall(r"name: '([^']+)'", Path("src/domain/seed.ts").read_text()))}
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
errors = []
def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond: errors.append(name)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector(".cal-grid")

    now = 1_790_000_000_000
    base = {"createdAt": now, "updatedAt": now, "deviceId": "t"}
    def sets(n): return [{"id": f"s{i}", "weight": 80, "reps": 8, "done": True} for i in range(n)]
    bench, row = SEED["Жим штанги лёжа"], SEED["Тяга верхнего блока"]
    page.evaluate(PUT, ["workouts", {**base, "id": "m1", "date": (TODAY - timedelta(days=2)).isoformat(), "title": "Недавно", "status": "done", "finishedAt": now - 1000,
                                     "exercises": [{"id": "e0", "exerciseId": bench, "sets": sets(4)}]}])
    page.evaluate(PUT, ["workouts", {**base, "id": "m2", "date": (TODAY - timedelta(days=20)).isoformat(), "title": "Давно", "status": "done", "finishedAt": now - 2000,
                                     "exercises": [{"id": "e1", "exerciseId": row, "sets": sets(3)}]}])
    page.goto(BASE + "#/stats")
    page.reload()
    page.wait_for_selector(".seg")
    page.click(".seg button:has-text('Глубокая')")
    page.wait_for_selector("[data-testid=load-map]")
    ctx.set_offline(True)

    check("в глубокой аналитике есть «Карта нагрузки»", page.locator("[data-testid=load-map] h2").inner_text() == "Карта нагрузки")
    check("схема тела: две фигуры, спереди и сзади", page.locator("[data-testid=body-map] svg").count() == 2)
    label = page.get_attribute("[data-testid=body-map]", "aria-label") or ""
    check("за 28 дней видны грудь и спина", "Грудь 4" in label and "Спина 3" in label, label)
    check("подпись: оценка, а не измерение", "оценка по подходам" in page.inner_text("[data-testid=load-map]").lower())

    page.click("[data-testid=load-map] button:has-text('7 дн.')")
    label7 = page.get_attribute("[data-testid=body-map]", "aria-label") or ""
    check("за 7 дней спины уже нет", "Грудь 4" in label7 and "Спина 0" in label7, label7)
    rows = page.locator("[data-testid=body-map-table] tbody tr").count()
    check("таблица с числами: все десять групп", rows == 10, rows)
    first = page.locator("[data-testid=body-map-table] tbody tr").first.inner_text()
    check("первой идёт самая нагруженная группа", first.startswith("Грудь"), first)
    page.locator("[data-testid=load-map]").scroll_into_view_if_needed()
    page.screenshot(path="/tmp/load_map.png")
    check("в консоли нет ошибок", not logs, logs)
    b.close()

raise SystemExit(1 if errors else 0)
