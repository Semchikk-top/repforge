import os
BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8000/")
from playwright.sync_api import sync_playwright
import re, sys

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
    check("календарь открылся", True)

    for tab in ["Календарь","Тренировка","Аналитика","Упражнения","Профиль"]:
        page.click(f".nav button:has-text('{tab}')")
        page.wait_for_timeout(350)
        ov = page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
        lab = page.evaluate("""() => [...document.querySelectorAll('.nav button')].every(b => { const r=b.getBoundingClientRect(); return r.right <= innerWidth + 0.5 && r.left >= -0.5; })""")
        check(f"нет горизонтального переполнения: {tab}", ov[0] <= ov[1] and lab, ov)
    page.click(".nav button:has-text('Календарь')")
    page.wait_for_selector(".cal-grid")
    page.wait_for_timeout(350)

    # --- вкладки: направление перехода
    page.click(".nav button:has-text('Профиль')"); page.click("button[aria-label='Настройки']")
    page.wait_for_selector("h1:has-text('Настройки')")
    cls = page.get_attribute(".view", "class")
    check("переход вправо: view-fwd", "view-fwd" in cls, cls)
    ind = page.get_attribute(".nav-ind", "style")
    check("индикатор вкладки сдвинулся", "translateX(400%)" in ind, ind)
    page.wait_for_timeout(500)

    # --- тумблеры: реальные клики по координатам
    toggles = page.locator(".toggle")
    n = toggles.count()
    check("найдено 5 тумблеров", n == 5, n)
    for i in range(n):
        inp = toggles.nth(i).locator("input")
        before = inp.is_checked()
        toggles.nth(i).click()
        page.wait_for_timeout(120)
        check(f"тумблер {i+1} переключается", inp.is_checked() != before, f"{before}->{inp.is_checked()}")
    page.screenshot(path="/tmp/settings.png")

    # --- сегментный переключатель
    page.click(".seg button:has-text('Глубокая')")
    page.wait_for_timeout(100)
    check("сегмент: data-i=1", page.get_attribute(".seg", "data-i") == "1")

    # --- назад к календарю
    page.click(".nav button:has-text('Календарь')")
    page.wait_for_selector(".cal-grid")
    check("переход влево: view-back", "view-back" in page.get_attribute(".view", "class"))

    # --- смена месяца
    page.click("button[aria-label='Следующий месяц']")
    check("смена месяца: класс fwd", "fwd" in page.get_attribute(".cal-grid", "class"))

    # --- тренировка
    page.click("button[aria-label='Предыдущий месяц']")
    page.click("button:has-text('Начать тренировку')")
    page.wait_for_selector(".sheet")
    page.screenshot(path="/tmp/sheet.png")
    page.click("button:has-text('Пустая тренировка')")
    page.wait_for_selector(".ex-name, button:has-text('Добавить упражнение')")
    page.click("button:has-text('Добавить упражнение')")
    page.wait_for_selector(".sheet .row")
    page.locator(".sheet .row").nth(0).click()
    page.locator(".sheet .row").nth(3).click()
    page.click("button:has-text('Добавить (2)')")
    page.wait_for_selector(".ex-block")
    check("упражнения добавлены", page.locator(".ex-block").count() == 2)

    page.locator(".check").first.click()
    page.wait_for_selector(".timer")
    check("после подхода запустился таймер", True)
    check("анимация pop на галочке", page.locator(".check.pop").count() == 1)
    page.wait_for_timeout(450)
    page.screenshot(path="/tmp/session.png")

    # --- шторка закрывается плавно
    page.click("button:has-text('Добавить упражнение')")
    page.wait_for_selector(".sheet")
    page.click("button[aria-label='Закрыть']")
    page.wait_for_timeout(60)
    check("шторка в состоянии closing", page.locator(".sheet-backdrop.closing").count() == 1)
    page.wait_for_timeout(350)
    check("шторка убрана из дерева", page.locator(".sheet").count() == 0)

    # --- таймер уезжает
    page.click(".timer button:has-text('Пропустить')")
    page.wait_for_timeout(60)
    check("таймер в состоянии out", page.locator(".timer.out").count() == 1)
    page.wait_for_timeout(350)
    check("таймер убран", page.locator(".timer").count() == 0)

    # --- завершение + аналитика
    page.click("button:has-text('Завершить тренировку')")
    page.wait_for_selector(".sheet")
    page.wait_for_timeout(900)
    page.screenshot(path="/tmp/finish.png")
    page.click("button:has-text('Готово')")
    page.wait_for_selector(".cal-grid")
    page.click(".nav button:has-text('Аналитика')")
    page.wait_for_selector(".kpis")
    page.wait_for_timeout(1000)
    page.screenshot(path="/tmp/stats.png")
    check("счётчики на аналитике есть", page.locator(".kpi .bignum").count() >= 3)

    real = [l for l in logs if "favicon" not in l]
    check("нет ошибок в консоли", not real, real[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
