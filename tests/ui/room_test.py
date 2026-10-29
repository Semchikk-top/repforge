"""Комната «Рядом» в настоящем браузере: два «телефона», живой релей и прямое соединение WebRTC.
Нужен клиент, собранный с адресом релея, и сервер с WORKOUT_ROOM_RELAY_URL (см. run_all.sh).
Релей поднимается самим тестом: node relay/src/index.js на порту RELAY_PORT."""
import json, os, re, subprocess, sys, time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
RELAY_PORT = int(os.environ.get("RELAY_PORT", "8791"))
errors = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


origin = "{0.scheme}://{0.netloc}".format(urlsplit(BASE))
relay = subprocess.Popen(
    ["node", "relay/src/index.js"],
    env={**os.environ, "PORT": str(RELAY_PORT), "RELAY_ORIGINS": origin, "RELAY_ALLOW_LOCALHOST": "0"},
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
time.sleep(1)

SECRET = "секрет-1b7f"

with sync_playwright() as p:
    # Chrome прячет адреса за mDNS-именами; в одной песочнице их не разрешить, поэтому для теста выключаем это
    b = p.chromium.launch(args=["--disable-features=WebRtcHideLocalIpsWithMdns"])

    def phone():
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, permissions=["clipboard-read", "clipboard-write"])
        pg = ctx.new_page()
        pg.logs = []
        pg.on("console", lambda m: pg.logs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: pg.logs.append(str(e)))
        return pg

    def open_room(pg):
        pg.goto(BASE + "#/workout")
        pg.wait_for_selector("h1:has-text('Тренировка')")
        pg.click(".room-card")
        pg.wait_for_selector(".sheet[aria-label='Рядом']")

    # ---------- хост создаёт комнату ----------
    host = phone()
    open_room(host)
    check("без имени и кода кнопка «Присоединиться» заблокирована", host.locator("button:has-text('Присоединиться')").is_disabled())
    host.fill("#room-name", "Дима")
    host.click("button:has-text('Создать комнату')")
    host.wait_for_selector(".room-code", timeout=10000)
    code = host.inner_text(".room-code").strip()
    check("код вида XXXX-XXXX без 0/O/1/I", re.fullmatch(r"[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}", code) is not None, code)
    check("есть таймер жизни кода", "действует ещё" in host.inner_text(".room-status"))
    host.screenshot(path="/tmp/room_1_waiting.png")

    # ---------- друг вводит код (в нижнем регистре и без дефиса) ----------
    guest = phone()
    open_room(guest)
    guest.fill("#room-name", "Аня")
    guest.fill("#room-code", code.replace("-", "").lower())
    check("поле кода подставляет дефис и заглавные", guest.input_value("#room-code") == code, guest.input_value("#room-code"))
    guest.click("button:has-text('Присоединиться')")

    # ---------- сверка кода ----------
    host.wait_for_selector(".room-sas", timeout=25000)
    guest.wait_for_selector(".room-sas", timeout=25000)
    sas_h, sas_g = host.inner_text(".room-sas"), guest.inner_text(".room-sas")
    check("код сверки: 6 цифр, одинаковый на обоих экранах", re.fullmatch(r"\d{3} \d{3}", sas_h) is not None and sas_h == sas_g, f"{sas_h!r} / {sas_g!r}")
    check("хост видит имя друга, пришедшее по защищённому каналу", "Аня" in host.inner_text(".room-status"))
    check("гость видит «ожидаем подтверждения»", "Ожидаем подтверждения" in guest.inner_text(".room-status"))
    host.screenshot(path="/tmp/room_2_approval.png")
    guest.screenshot(path="/tmp/room_2_awaiting.png")

    # хост закрывает шторку с запросом: полоса сверху напоминает, что ждут подтверждения
    host.click(".sheet-head .icon-btn")
    host.wait_for_selector(".sheet", state="detached")
    host.wait_for_selector(".room-bar.alert")
    check("RoomBar показывает ожидание подтверждения", "ждёт подтверждения" in host.inner_text(".room-bar"))
    host.click(".room-bar-main")
    host.click("button:has-text('Разрешить')")
    host.wait_for_selector(".room-presence", timeout=10000)
    guest.wait_for_selector(".room-presence", timeout=10000)
    check("после разрешения оба в чате", True)

    # ---------- чат ----------
    guest.click(".chip:has-text('Подстрахуй')")
    host.wait_for_selector(".bubble.peer:has-text('Подстрахуй')")
    check("быстрая фраза дошла", True)
    host.fill("input[aria-label='Сообщение']", f"Ты где? {SECRET}")
    host.press("input[aria-label='Сообщение']", "Enter")
    guest.wait_for_selector(f".bubble.peer:has-text('{SECRET}')")
    check("сообщение дошло и показано как моё у отправителя", host.locator(f".bubble.me:has-text('{SECRET}')").count() == 1)

    # ---------- «Позвать» ----------
    host.evaluate("window.__vib = []; window.__vibStack = []; navigator.vibrate = (p) => { window.__vib.push(p); window.__vibStack.push(new Error().stack); return true; }; 0")
    guest.evaluate("window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; }; 0")
    guest.click("button:has-text('Позвать')")
    host.wait_for_selector(".bubble.sys:has-text('зовёт')", timeout=5000)
    vib = host.evaluate("window.__vib")
    check("у друга вибрация", len(vib) == 1, vib)
    if len(vib) != 1:
        print(host.evaluate("window.__vibStack")[0][:600])
    check("кнопка «Позвать» на паузе, чтобы не спамить", guest.locator("button:has-text('Позвали')").is_disabled())

    # ---------- presence из настоящей тренировки ----------
    host.click(".sheet-head .icon-btn")
    host.wait_for_selector(".sheet", state="detached")
    host.goto(BASE + "#/quick/start")
    host.wait_for_url(re.compile(r"#/workout/\w+"), timeout=8000)
    host.click("button:has-text('Добавить упражнение')")
    host.fill("input[placeholder='Поиск по названию']", "Жим гантелей")
    host.click(".list .row:has-text('Жим гантелей')")
    host.click("button:has-text('Добавить (1)')")
    host.wait_for_selector(".ex-block")
    check("переход между экранами не рвёт связь (RoomBar на месте)", host.locator(".room-bar").count() == 1)
    host.click("button[aria-label='Рядом: комната с другом']")
    host.wait_for_selector(".room-presence")
    guest.wait_for_function("() => /Жим гантелей/.test(document.querySelector('.room-presence .what')?.textContent || '')", timeout=15000)
    what = guest.inner_text(".room-presence .what")
    check("друг видит упражнение и подход", re.search(r"Жим гантелей.* · подход 1/\d", what) is not None, what)

    host.click(".sheet-head .icon-btn")
    host.wait_for_selector(".sheet", state="detached")
    host.locator(".ex-block .check").first.click()
    host.wait_for_selector(".timer:not(.out)", timeout=5000)
    guest.wait_for_function("() => /отдых \\d:\\d\\d/.test(document.querySelector('.room-presence .what')?.textContent || '')", timeout=15000)
    check("друг видит отдых с таймером", True, guest.inner_text(".room-presence .what"))
    host.screenshot(path="/tmp/room_3_workout_bar.png")
    guest.screenshot(path="/tmp/room_3_chat.png")

    # выключенный тумблер: друг перестаёт видеть упражнение
    host.click("button[aria-label='Рядом: комната с другом']")
    host.locator("input[aria-label='Показывать, что я делаю']").last.evaluate("el => el.click()")
    guest.wait_for_function("() => /не показывает/.test(document.querySelector('.room-presence .what')?.textContent || '')", timeout=15000)
    check("тумблер «Показывать, что я делаю» скрывает упражнение", "Жим гантелей" not in guest.inner_text(".room-presence .what"))

    # ---------- приватность: ничего не попало в базу и localStorage ----------
    def leaks(pg):
        return pg.evaluate("""async (needle) => {
          const found = [];
          for (const { name } of await indexedDB.databases()) {
            const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            for (const store of Array.from(db.objectStoreNames)) {
              const all = await new Promise((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
              if (JSON.stringify(all).includes(needle)) found.push(name + '/' + store);
            }
            db.close();
          }
          for (let i = 0; i < localStorage.length; i++) if ((localStorage.getItem(localStorage.key(i)) || '').includes(needle)) found.push('localStorage/' + localStorage.key(i));
          return found;
        }""", SECRET)
    check("текст сообщения не сохранён ни в IndexedDB, ни в localStorage (у хоста)", leaks(host) == [], leaks(host))
    check("текст сообщения не сохранён ни в IndexedDB, ни в localStorage (у гостя)", leaks(guest) == [], leaks(guest))

    # ---------- выход ----------
    host.click("button:has-text('Выйти из комнаты')")
    guest.wait_for_selector(".room-status:has-text('Друг вышел')", timeout=8000)
    check("друг видит «вышел», связь закрыта", True)
    guest.click("button:has-text('Создать комнату заново')")
    guest.wait_for_selector("button:has-text('Создать комнату')")
    check("после выхода переписка стёрта", guest.locator(".bubble").count() == 0)
    check("полоска RoomBar исчезла у вышедшего", host.locator(".room-bar").count() == 0)

    # ---------- ошибки ----------
    bad = phone()
    open_room(bad)
    bad.fill("#room-name", "Тест")
    bad.fill("#room-code", "ZZZZZZZZ")
    bad.click("button:has-text('Присоединиться')")
    bad.wait_for_selector(".room-status[role=alert]", timeout=10000)
    check("неверный код: понятное сообщение", "Неверный или просроченный код" in bad.inner_text(".room-status"))
    bad.click("button:has-text('Попробовать снова')")
    bad.wait_for_selector("#room-code")
    check("«Попробовать снова» возвращает к вводу кода", True)

    # отказ хоста
    host2, guest2 = phone(), phone()
    open_room(host2)
    host2.fill("#room-name", "Дима")
    host2.click("button:has-text('Создать комнату')")
    host2.wait_for_selector(".room-code")
    c2 = host2.inner_text(".room-code").strip()
    open_room(guest2)
    guest2.fill("#room-name", "Аня")
    guest2.fill("#room-code", c2)
    guest2.click("button:has-text('Присоединиться')")
    host2.wait_for_selector("button:has-text('Отклонить')", timeout=25000)
    host2.click("button:has-text('Отклонить')")
    guest2.wait_for_selector(".room-status:has-text('Хост отклонил')", timeout=8000)
    check("отказ хоста: гость видит отказ", True)
    check("после отказа у хоста снова форма создания", host2.locator("button:has-text('Создать комнату')").count() == 1)

    # код сгорел после соединения: повторный вход невозможен
    late = phone()
    open_room(late)
    late.fill("#room-name", "Поздно")
    late.fill("#room-code", c2)
    late.click("button:has-text('Присоединиться')")
    late.wait_for_selector(".room-status[role=alert]", timeout=10000)
    check("использованный код не работает", "Неверный или просроченный код" in late.inner_text(".room-status"))

    # ---------- сеть: ни одного запроса к STUN/TURN и чужим адресам ----------
    for name, pg in [("хост", host), ("гость", guest)]:
        real = [l for l in pg.logs if "favicon" not in l]
        check(f"нет ошибок в консоли ({name}; в том числе CSP)", real == [], real[:3])

    b.close()

relay.terminate()
print("\nИтого ошибок:", len(errors))
sys.exit(1 if errors else 0)
