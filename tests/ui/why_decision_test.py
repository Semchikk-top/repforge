"""«Почему так» (1.4.0): ⓘ рядом с отдыхом и с идеей на сегодня открывает факт из данных, без сети.
Работает в обычной сборке: факт считает код, принципы из справочника показываются, только если они опубликованы."""
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

    ex = SEED["Жим штанги лёжа"]
    now = 1_790_000_000_000
    past = (TODAY - timedelta(days=3)).isoformat()
    sets_done = [{"id": f"h-{i}", "weight": 80, "reps": 12, "done": True} for i in range(3)]
    sets_todo = [{"id": f"w-{i}", "weight": 70, "reps": 8, "done": False} for i in range(3)]
    base = {"createdAt": now, "updatedAt": now, "deviceId": "t"}
    page.evaluate(PUT, ["workouts", {**base, "id": "hist-1", "date": past, "title": "Было", "status": "done", "finishedAt": now - 1000,
                                     "exercises": [{"id": "he0", "exerciseId": ex, "sets": sets_done}]}])
    page.evaluate(PUT, ["workouts", {**base, "id": "why-2", "date": TODAY.isoformat(), "title": "Сегодня", "status": "planned",
                                     "exercises": [{"id": "we0", "exerciseId": ex, "sets": sets_todo}]}])
    page.goto(BASE + "#/workout/why-2")
    page.reload()
    page.wait_for_selector(".ex-block .ex-name")

    # --- отдых
    rest = page.locator("button[aria-label='Почему так: отдых']")
    check("рядом с отдыхом есть ⓘ «Почему так»", rest.count() == 1)
    ctx.set_offline(True)
    rest.click()
    page.wait_for_selector("[data-testid=why-decision]")
    fact = page.inner_text("[data-testid=why-fact]")
    check("факт про отдых называет источник значения", "Отдых" in fact and ("настроек" in fact or "упражнении" in fact), fact)
    page.wait_for_timeout(700)
    ov = page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    check("нет горизонтального переполнения", ov[0] <= ov[1], ov)
    page.screenshot(path="/tmp/why_decision.png")
    page.locator(".ex-block").first.screenshot(path="/tmp/why_block.png")
    page.click("button[aria-label='Закрыть']")
    page.wait_for_timeout(350)
    check("шторка закрылась", page.locator("[data-testid=why-decision]").count() == 0)

    # --- идея на сегодня: 12 повторов в прошлый раз → «пора прибавить вес»
    idea = page.locator("button[aria-label='Почему так: идея на сегодня']")
    check("рядом с идеей на сегодня есть ⓘ", idea.count() == 1)
    idea.click()
    page.wait_for_selector("[data-testid=why-decision]")
    fact = page.inner_text("[data-testid=why-fact]")
    check("факт объясняет прибавку веса числами из истории", "12+" in fact and "вес" in fact, fact)
    page.click("button[aria-label='Закрыть']")
    page.wait_for_timeout(350)
    ctx.set_offline(False)
    check("нет ошибок в консоли", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "ВСЁ ОК" if not errors else f"ОШИБКИ: {errors}")
raise SystemExit(1 if errors else 0)
