"""Экран «Подключение ассистента» в настоящем браузере: облако (ключ), Ollama, агент.
Нужны: сервер (BASE_URL), подставной провайдер `uvicorn tests.ui.fake_provider:app --port 8790`
и ASSISTANT_CLOUD_BASE_URL=http://127.0.0.1:8790 у сервера."""
import os, re, subprocess, sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
FAKE = "http://127.0.0.1:8790"
errors = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def new_code():
    out = subprocess.run([sys.executable, "-m", "server", "pair", "--url", BASE.rstrip("/")], capture_output=True, text=True).stdout
    return re.search(r"#/pair/(\w{8})", out).group(1)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(str(e)))
    pg.goto(BASE + "#/pair/" + new_code())
    pg.wait_for_selector("text=Синхронизировано", timeout=10000)

    pg.click("button:has-text('Настроить подключение')")
    pg.wait_for_selector("[role=dialog] [role=tablist]")
    check("три способа подключения", pg.locator("[role=tab]").count() == 3)

    # --- облако (на ПК по умолчанию открывается Ollama) ---
    pg.click("[role=tab]:has-text('Облако')")
    pg.wait_for_selector("#c-key")
    check("без ключа кнопка неактивна", pg.locator("button:has-text('Сохранить и проверить')").is_disabled())
    pg.fill("#c-key", "sk-ant-test-key-7777")
    check("ключ скрыт (password)", pg.get_attribute("#c-key", "type") == "password")
    pg.click("button:has-text('Сохранить и проверить')")
    pg.wait_for_selector(".conn-status.ok", timeout=10000)
    check("облако проверено, модели показаны", pg.locator(".conn-models .chip").count() == 2)
    check("поле ключа очищено, виден хвост ••••7777", pg.input_value("#c-key") == "" and "7777" in (pg.get_attribute("#c-key", "placeholder") or ""))
    check("ключа нет в тексте страницы", "sk-ant-test-key" not in pg.content())
    pg.click(".conn-models .chip >> nth=1")
    check("выбор модели из списка", pg.input_value("#c-model") == "fake-model-2")

    # --- Ollama: адрес вне своей сети отклоняется ---
    pg.click("[role=tab]:has-text('Ollama')")
    pg.fill("#l-url", "http://8.8.8.8:11434/v1")
    pg.click("button:has-text('Сохранить и проверить')")
    pg.wait_for_selector("text=Локальный адрес должен вести", timeout=5000)
    check("публичный адрес для Ollama отклонён", True)

    # --- агент ---
    pg.click("[role=tab]:has-text('Агент')")
    pg.fill("#a-url", FAKE + "/v1")
    pg.fill("#a-token", "agent-token-4242")
    pg.click("button:has-text('Сохранить и проверить')")
    pg.wait_for_selector(".conn-status.ok", timeout=10000)
    check("агент подключён", True)
    check("виден хвост токена", "4242" in (pg.get_attribute("#a-token", "placeholder") or ""))
    pg.screenshot(path="/tmp/connect.png")
    check("нет горизонтального переполнения", pg.evaluate("document.documentElement.scrollWidth") <= 390)

    # --- после закрытия: статус в настройках ---
    pg.click("button[aria-label=Закрыть]")
    pg.wait_for_selector("[role=dialog]", state="detached")
    pg.click(".seg.three button:has-text('Агент')")
    pg.wait_for_selector("text=Агент отвечает", timeout=8000)
    check("в настройках виден статус агента", True)
    pg.click(".seg.three button:has-text('Облако')")
    pg.wait_for_selector("text=Облако готово", timeout=8000)
    check("в настройках виден статус облака", True)

    # --- перезагрузка: ключ остался на сервере ---
    pg.reload()
    pg.wait_for_selector("button:has-text('Настроить подключение')")
    pg.click("button:has-text('Настроить подключение')")
    pg.wait_for_selector("#c-key, #a-token")
    check("после перезагрузки настройки на месте", pg.locator("[placeholder*='Сохранён']").count() >= 1)
    logs = [l for l in logs if "422" not in l]  # 422 — ожидаемый отказ на публичный адрес Ollama
    check("нет ошибок в консоли", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
