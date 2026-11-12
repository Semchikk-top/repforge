"""Карточка «Зачем это» (1.3.0): кнопка ⓘ открывает шторку из тренировки и из списка упражнений, без сети и без сервера.

Нужна сборка, в которую попали карточки. Если опубликованных карточек нет, тест сам пропускается (SKIP).
Чтобы прогнать его на черновиках:
    CONTENT_PREVIEW=1 npm run build   # потом снова обычный npm run content:build перед релизом
"""
import os, re
from datetime import date
from pathlib import Path
BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8000/")
from playwright.sync_api import sync_playwright

TODAY = date.today().isoformat()
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

    # --- список упражнений
    page.click(".nav button:has-text('Упражнения')")
    page.wait_for_selector(".list")
    page.wait_for_timeout(400)
    infos = page.locator(".list .info-btn")
    n = infos.count()
    if n == 0:
        print("SKIP нет опубликованных карточек в этой сборке (CONTENT_PREVIEW=1 npm run build)")
        b.close(); raise SystemExit(0)
    check("кнопка ⓘ есть у упражнений с карточкой", n >= 1, n)
    check("у упражнений без карточки кнопки нет", n < page.locator(".list .row").count(), n)

    # --- шторка из списка, без сети
    ctx.set_offline(True)
    infos.first.click()
    page.wait_for_selector("[data-testid=why-card]")
    check("карточка открылась из списка", True)
    check("есть блок источников", page.locator("[data-testid=why-sources]").count() == 1)
    text = page.inner_text("[data-testid=why-card]")
    check("строка про образовательный характер", "Образовательная информация, не медицинская рекомендация." in text)
    low = text.lower()  # заголовки показываются заглавными через CSS
    check("есть подсказки и ошибки", "подсказки по технике" in low and "типичные ошибки" in low)
    ov = page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    check("нет горизонтального переполнения", ov[0] <= ov[1], ov)
    page.wait_for_timeout(600)  # дать шторке доехать
    page.screenshot(path="/tmp/why_card.png")
    page.click("button[aria-label='Закрыть']")
    page.wait_for_timeout(350)
    check("шторка закрылась", page.locator("[data-testid=why-card]").count() == 0)
    ctx.set_offline(False)

    # --- своё упражнение: карточки и кнопки нет
    page.click("button:has-text('Добавить')")
    page.fill("#ex-name", "Моё упражнение")
    page.click("button:has-text('Сохранить')")
    page.wait_for_timeout(400)
    row = page.locator(".list .row:has-text('Моё упражнение')")
    check("у своего упражнения нет ⓘ", row.count() == 1 and page.locator(".row-split:has-text('Моё упражнение')").count() == 0)

    # --- из тренировки одним нажатием, без сети
    now = 1_790_000_000_000
    sets = [{"id": f"w-{i}", "weight": 50, "reps": 10, "done": False} for i in range(3)]
    page.evaluate(PUT, ["workouts", {
        "id": "why-1", "createdAt": now, "updatedAt": now, "deviceId": "t", "date": TODAY, "title": "Карточка", "status": "planned",
        "exercises": [{"id": "we0", "exerciseId": SEED["Жим штанги лёжа"], "sets": sets}],
    }])
    page.goto(BASE + "#/workout/why-1")
    page.reload()
    page.wait_for_selector(".ex-block .ex-name")
    btn = page.locator(".ex-name .info-btn")
    check("в тренировке рядом с названием есть ⓘ", btn.count() == 1)
    ctx.set_offline(True)
    btn.click()
    page.wait_for_selector("[data-testid=why-card]")
    check("карточка открылась из тренировки одним нажатием", "Жим штанги лёжа" in page.inner_text("[data-testid=why-card]"))
    check("в тренировке тоже есть блок источников", page.locator("[data-testid=why-sources]").count() == 1)
    page.click("button[aria-label='Закрыть']")
    page.wait_for_timeout(350)
    ctx.set_offline(False)
    check("нет ошибок в консоли", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "ВСЁ ОК" if not errors else f"ОШИБКИ: {errors}")
raise SystemExit(1 if errors else 0)
