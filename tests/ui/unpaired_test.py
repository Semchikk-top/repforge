"""Неподключённый клиент: кнопка настройки ассистента ведёт к сопряжению, а не молчит."""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
errors = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append(str(e)))
    page.goto(BASE + "#/settings/server")
    page.wait_for_selector("h1:has-text('Настройки')", timeout=10000)

    button = page.locator("button:has-text('Сначала подключить устройство')")
    check("кнопка объясняет причину", button.count() == 1)
    check("кнопка не заблокирована", not button.is_disabled())

    button.click()
    page.wait_for_selector("text=Сначала подключи это устройство", timeout=3000)
    check("показан тост", True)
    page.wait_for_selector("#sync-section", timeout=3000)
    check("виден блок синхронизации", page.locator("#sync-section").is_visible())
    check("окно настроек ассистента не открылось", page.locator("[role=dialog]").count() == 0)
    check("остались в настройках", "settings" in page.url)
    check("нет ошибок в консоли", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
