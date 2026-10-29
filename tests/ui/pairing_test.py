"""Сквозная проверка подключения устройств в настоящем браузере:
QR из окна «Подключить телефон рядом» → телефон подключается; запрос с телефона → подтверждение/отказ на ПК.
Сервер должен слушать 0.0.0.0, чтобы нашёлся адрес локальной сети: python -m server run --host 0.0.0.0 --port 8767"""
import os, re, subprocess, sys, time

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
    return re.search(r"#/pair/(\w{8})", out).group(1)


with sync_playwright() as p:
    b = p.chromium.launch()
    def phone():
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg = ctx.new_page()
        pg.logs = []
        pg.on("console", lambda m: pg.logs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: pg.logs.append(str(e)))
        return pg

    # ---------- ПК: подключён по ссылке из консоли ----------
    pc = phone()
    pc.goto(BASE + "#/pair/" + new_code())
    pc.wait_for_selector("h1:has-text('Настройки')")
    pc.wait_for_selector("text=Синхронизировано", timeout=10000)
    check("ПК подключён", True)

    # ---------- кнопка «Подключить телефон рядом» ----------
    pc.click("button:has-text('Подключить телефон рядом')")
    pc.wait_for_selector(".qr-box img", timeout=10000)
    pc.wait_for_function("() => { const i = document.querySelector('.qr-box img'); return i && i.complete && i.naturalWidth > 0; }")
    check("QR-картинка загрузилась", True)
    link = pc.input_value("input[aria-label='Ссылка для подключения']")
    code = re.search(r"/#/pair/(\w{8})$", link)
    check("ссылка содержит одноразовый код", bool(code), link)
    shown = pc.inner_text(".code-text").replace("-", "")
    check("код для ручного ввода совпадает со ссылкой", code and shown == code.group(1), shown)
    check("адрес — локальная сеть (HTTP) с предупреждением", link.startswith("http://") and pc.locator(".notice:has-text('HTTP')").count() == 1)
    pc.wait_for_timeout(600)
    pc.locator(".qr-box").screenshot(path="/tmp/qr.png")
    pc.screenshot(path="/tmp/invite.png")
    try:
        import cv2
        data, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread("/tmp/qr.png"))
        check("QR на экране расшифровывается в ту же ссылку", data == link, data)
    except ImportError:
        print("SKIP QR-декодирование (нет opencv)")

    # ---------- телефон открывает ссылку из QR ----------
    ph = phone()
    ph.goto(link)
    ph.wait_for_selector("h1:has-text('Настройки')")
    ph.wait_for_selector("text=Синхронизировано", timeout=10000)
    check("телефон подключился по ссылке из QR", True)
    pc.wait_for_selector(".invite-done", timeout=10000)
    check("ПК показал «Подключено»", "Подключено" in pc.inner_text(".invite-done"))
    pc.click(".invite-done button:has-text('Готово')")
    pc.wait_for_selector(".sheet", state="detached")
    # код одноразовый
    again = httpx.post(BASE + "api/pair", json={"code": code.group(1), "deviceId": "intruder-0001", "name": "x"})
    check("использованный код больше не работает", again.status_code == 403)

    # ---------- запрос подключения с телефона, подтверждение на ПК ----------
    ph2 = phone()
    ph2.goto(BASE + "#/settings")
    ph2.click("button:has-text('Запросить подключение к ПК')")
    ph2.wait_for_selector(".pin-wait .pin")
    pin = ph2.inner_text(".pin-wait .pin")
    check("телефон показал PIN из 4 цифр", re.fullmatch(r"\d{4}", pin) is not None, pin)
    pc.wait_for_selector(".sheet:has-text('Запрос на подключение')", timeout=10000)
    check("на ПК тот же PIN для сверки", pc.inner_text(".sheet .pin").strip() == pin)
    pc.screenshot(path="/tmp/approve.png")
    check("в запросе видно имя устройства", "Компьютер" in pc.inner_text(".sheet") or "Телефон" in pc.inner_text(".sheet"))
    pc.click(".sheet button:has-text('Разрешить')")
    ph2.wait_for_selector("text=Синхронизировано", timeout=15000)
    check("после подтверждения телефон подключился сам", True)

    # ---------- отказ ----------
    ph3 = phone()
    ph3.goto(BASE + "#/settings")
    ph3.click("button:has-text('Запросить подключение к ПК')")
    ph3.wait_for_selector(".pin-wait .pin")
    pc.wait_for_selector(".sheet:has-text('Запрос на подключение')", timeout=10000)
    pc.click(".sheet button:has-text('Отклонить')")
    ph3.wait_for_selector("text=ПК отклонил запрос", timeout=8000)
    check("отказ доходит до телефона", True)
    check("после отказа телефон не подключён", ph3.locator("button:has-text('Запросить подключение к ПК')").count() == 1)

    # ---------- без подтверждения код не выдаётся ----------
    r = httpx.post(BASE + "api/pairing/request", json={"deviceId": "sneaky-device-1", "name": "Чужой"}).json()
    time.sleep(2)
    st = httpx.get(BASE + f"api/pairing/request/{r['requestId']}").json()
    check("без подтверждения код не выдаётся", st == {"status": "pending"}, st)
    check("список ожидающих закрыт без авторизации", httpx.get(BASE + "api/pairing/pending").status_code == 401)
    httpx.delete(BASE + f"api/pairing/request/{r['requestId']}")

    ov = pc.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    check("нет горизонтального переполнения", ov[0] <= ov[1], ov)
    for name, pg in (("ПК", pc), ("телефон из запроса", ph2)):
        real = [l for l in pg.logs if "favicon" not in l]
        check(f"нет ошибок в консоли: {name}", not real, real[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
