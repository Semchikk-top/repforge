"""Главный экран отвечает на «что делать сегодня»: путь новичка, тренировка на сегодня, идущая и выполненная."""
import json, os, sys
from datetime import date

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
TODAY = date.today().isoformat()
errors = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


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
CLEAR = """
(store) => new Promise((res, rej) => {
  const open = indexedDB.open('workout-pwa');
  open.onsuccess = () => { const db = open.result; const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); };
  open.onerror = () => rej(open.error);
})
"""


def workout(wid, status, title="Грудь", **extra):
    now = 1_790_000_000_000
    return {"id": wid, "createdAt": now, "updatedAt": now, "deviceId": "t", "date": TODAY, "title": title, "status": status,
            "exercises": [], **extra}


def card(pg):
    pg.wait_for_selector(".today-card", timeout=8000)
    return pg.locator(".today-card")


def overflow(pg):
    pg.wait_for_timeout(600)  # вход экрана анимирован (сдвиг): до конца анимации ширина прокрутки не настоящая
    return pg.evaluate("[document.documentElement.scrollWidth, innerWidth]")


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    pg = ctx.new_page()
    pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    pg.goto(BASE)
    pg.wait_for_selector(".cal-grid")

    # --- новичок: пустой дневник
    c = card(pg)
    check("новичку: «С чего начать»", "С чего начать" in c.inner_text(), c.inner_text()[:60])
    check("новичку: три шага", pg.locator(".today-steps li").count() == 3)
    check("новичку: главная кнопка — подбор программы", c.locator("button.primary").inner_text().strip() == "Подобрать программу")
    ov = overflow(pg)
    check("календарь не вылезает за экран при карточке", ov[0] <= ov[1], ov)
    pg.wait_for_timeout(300)
    cols = pg.evaluate("getComputedStyle(document.querySelector('.cal-grid')).gridTemplateColumns.split(' ').map(parseFloat)")
    check("колонки календаря равной ширины (класс today не конфликтует)", max(cols) - min(cols) < 2, cols)
    c.locator("button.primary").click()
    pg.wait_for_selector("text=Стартовая программа", timeout=5000)
    check("подбор программы открылся", "#/start" in pg.url, pg.url)
    pg.goto(BASE + "#/calendar"); pg.wait_for_selector(".today-card")

    # --- на сегодня запланирована тренировка
    pg.evaluate(PUT, ["workouts", workout("w-plan", "planned", "Грудь")])
    pg.reload(); c = card(pg)
    pg.wait_for_selector("text=Сегодня: Грудь", timeout=5000)
    check("запланированная: заголовок", "Сегодня: Грудь" in c.inner_text(), c.inner_text()[:60])
    check("запланированная: кнопка «Начать»", c.locator("button.primary").inner_text().strip() == "Начать")
    c.locator("button.primary").click()
    pg.wait_for_url("**/workout/w-plan", timeout=5000)
    check("«Начать» открывает тренировку", "workout/w-plan" in pg.url, pg.url)

    # --- тренировка уже идёт
    pg.goto(BASE + "#/calendar")
    pg.evaluate(PUT, ["workouts", workout("w-plan", "active", "Грудь", startedAt=1_790_000_100_000)])
    pg.reload(); c = card(pg)
    pg.wait_for_selector("text=Идёт тренировка: Грудь", timeout=5000)
    check("идущая: «Продолжить»", c.locator("button.primary").inner_text().strip() == "Продолжить")

    # --- на сегодня уже всё выполнено
    pg.evaluate(PUT, ["workouts", workout("w-plan", "done", "Грудь", startedAt=1_790_000_100_000, finishedAt=1_790_000_900_000)])
    pg.reload(); c = card(pg)
    pg.wait_for_selector("text=Сегодняшняя тренировка выполнена", timeout=5000)
    check("выполненная: показан итог", "Грудь" in c.inner_text(), c.inner_text()[:80])
    ov = overflow(pg)
    check("нет горизонтального переполнения в конце", ov[0] <= ov[1], ov)

    pg.evaluate(CLEAR, "workouts")
    browser.close()

print("\nИТОГ: провалено:" if errors else "\nИТОГ: всё хорошо", errors if errors else "")
sys.exit(1 if errors else 0)
