"""Сквозная проверка ассистента: настоящий браузер → настоящий сервер → подставной провайдер.
Нужны запущенные: сервер (BASE_URL) с ASSISTANT_CLOUD_BASE_URL на подставной провайдер и ANTHROPIC_API_KEY."""
import json, os, re, subprocess, sys
from datetime import datetime, timedelta

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
errors = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def new_code():
    out = subprocess.run([sys.executable, "-m", "server", "pair", "--url", BASE.rstrip("/")], capture_output=True, text=True).stdout
    return re.search(r"Код подключения: (\w{4})-(\w{4})", out).group(1) + re.search(r"Код подключения: (\w{4})-(\w{4})", out).group(2)


# --- данные на сервере: два реальных тренировочных дня за последний месяц
today = datetime.now().date()
tok = httpx.post(BASE + "api/pair", json={"code": new_code(), "deviceId": "seeder-0001", "name": "Сидер"}).json()["token"]
def ent(table, id, data):
    return {"table": table, "id": id, "updatedAt": 100, "deviceId": "seeder-0001", "deleted": False, "data": {"id": id, **data}}
def wk(id, days_ago, sets):
    return ent("workouts", id, {"date": (today - timedelta(days=days_ago)).isoformat(), "title": "Грудь", "status": "done", "startedAt": 1, "finishedAt": 3_000_000,
        "exercises": [{"id": "x" + id, "exerciseId": "seed-001", "sets": [{"id": f"{id}{i}", "weight": w, "reps": r, "done": True} for i, (w, r) in enumerate(sets)]}]})
r = httpx.post(BASE + "api/sync", headers={"Authorization": "Bearer " + tok},
    json={"since": 0, "entities": [ent("exercises", "seed-001", {"name": "Жим штанги лёжа", "muscle": "chest", "equipment": "Штанга"}), wk("a1", 3, [(80, 8), (85, 5)]), wk("a2", 9, [(80, 6)])]})
check("данные засеяны на сервере", r.status_code == 200)

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2).new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append(str(e)))

    # --- подключение по ссылке из QR
    page.goto(BASE + "#/pair/" + new_code())
    page.wait_for_selector("h1:has-text('Настройки')")
    page.wait_for_selector("text=Синхронизировано", timeout=10000)
    check("устройство подключилось по ссылке", True)

    # --- настройки ассистента: ПК по умолчанию Ollama, переключаем на облако
    page.wait_for_selector("h2:has-text('Ассистент')")
    page.click(".seg[aria-label='Модель ассистента'] button:has-text('Облако')")
    page.wait_for_selector("text=Облако готово, модель claude-sonnet-5-5", timeout=8000)
    check("настройки видят облачного провайдера", True)
    check("сегмент модели переключился", page.get_attribute(".seg[aria-label='Модель ассистента']", "data-i") == "0")

    # --- открываем чат кнопкой
    page.click(".nav button:has-text('Календарь')")
    page.wait_for_selector(".fab")
    page.click(".fab")
    page.wait_for_selector(".chat")
    check("в чате нет нижней навигации", page.locator(".nav").count() == 0)
    check("показаны подсказки", page.locator(".chat-suggest .chip").count() == 7)

    # --- предложение тренировки
    page.click(".chat-suggest .chip:has-text('Составь тренировку на завтра')")
    page.wait_for_selector(".msg.user:has-text('на завтра')")
    page.wait_for_selector(".proposal", timeout=10000)
    check("карточка тренировки пришла", page.locator(".proposal-list li").count() == 3)
    check("в карточке вес и подходы", "4×6 · 85 кг" in page.inner_text(".proposal"))
    page.wait_for_selector(".msg.bot:has-text('проверь карточку')", timeout=10000)
    page.wait_for_selector(".send:not(.stop)")
    page.screenshot(path="/tmp/chat_proposal.png")

    page.click("button:has-text('Добавить в календарь')")
    page.wait_for_selector("button:has-text('Открыть тренировку')")
    page.click("button:has-text('Открыть тренировку')")
    page.wait_for_selector(".ex-block")
    names = page.locator(".ex-name").all_inner_texts()
    check("тренировка создана с упражнениями", names == ["Жим штанги лёжа", "Французский жим", "Отжимания с хлопком"], names)
    check("вес подставлен из предложения", page.locator(".ex-block").first.locator(".stepper input").first.input_value() == "85")

    # --- вопрос с инструментом и форматированием
    page.click("button[aria-label='Спросить ассистента']")
    page.wait_for_selector(".chat")
    check("история чата сохранилась при возврате", page.locator(".proposal").count() == 1)
    page.fill("textarea", "Как у меня дела за месяц?")
    page.click("button[aria-label='Отправить']")
    page.wait_for_selector(".tool-chip", timeout=8000)
    check("виден статус работы инструмента", True)
    page.wait_for_selector(".msg.bot:has-text('Держи ритм')", timeout=15000)
    check("жирный текст и список отрисованы", page.locator(".msg-text strong:has-text('Тренировок: 2')").count() == 1 and page.locator(".msg-text li").count() == 2)
    check("ответ основан на данных сервера (2 тренировки)", True)

    # --- остановка длинного ответа
    page.fill("textarea", "Расскажи долго")
    page.click("button[aria-label='Отправить']")
    page.wait_for_selector("button[aria-label='Остановить']")
    page.locator(".msg.bot").last.filter(has_text="слово3").wait_for(timeout=8000)
    page.click("button[aria-label='Остановить']")
    page.wait_for_selector("text=Остановлено")
    page.wait_for_selector("button[aria-label='Отправить']")
    check("остановка работает", True)

    # --- раскладка и консоль
    ov = page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    check("нет горизонтального переполнения", ov[0] <= ov[1], ov)
    page.screenshot(path="/tmp/chat_final.png")

    # --- ошибка провайдера показывается человеку: переключаемся на локальный (Ollama недоступна)
    page.goto(BASE + "#/settings")
    page.click(".seg[aria-label='Модель ассистента'] button:has-text('Ollama')")
    page.wait_for_selector("text=Ollama не отвечает", timeout=8000)
    page.goto(BASE + "#/assistant")
    page.fill("textarea", "Привет")
    page.click("button[aria-label='Отправить']")
    page.wait_for_selector(".msg-error", timeout=10000)
    check("ошибка локальной модели объяснена", "локальн" in page.inner_text(".msg-error").lower(), page.inner_text(".msg-error")[:100])

    real = [l for l in logs if "favicon" not in l]
    check("нет ошибок в консоли", not real, real[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
