"""Друзья и рейтинги в настоящем браузере: профиль с ключом, добавление по коду со сверкой, обмен снимками,
таблица лидеров, блокировка, разминка. Нужны релей и сборка с его адресом (см. room_test.py)."""
import os, re, subprocess, sys, time
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
relay = None
if os.environ.get("OWN_RELAY", "1") == "1":
    relay = subprocess.Popen(["node", "relay/src/index.js"], env={**os.environ, "PORT": str(RELAY_PORT), "RELAY_ORIGINS": origin, "RELAY_ALLOW_LOCALHOST": "0"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--disable-features=WebRtcHideLocalIpsWithMdns"])

    def phone():
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg = ctx.new_page()
        pg.logs = []
        pg.on("console", lambda m: pg.logs.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: pg.logs.append(str(e)))
        return pg

    def make_profile(pg, name):
        pg.goto(BASE + "#/settings/server")
        pg.wait_for_selector("h2:has-text('Профиль и друзья')")
        pg.fill("#pf-name", name)
        pg.click("button:has-text('Создать профиль')")
        pg.wait_for_selector("text=Отпечаток ключа")

    def do_workout(pg, weight, reps, warm=False):
        pg.goto(BASE + "#/quick/start")
        pg.wait_for_url(re.compile(r"#/workout/\w+"), timeout=8000)
        pg.click("button:has-text('Добавить упражнение')")
        pg.fill("input[placeholder='Поиск по названию']", "Жим гантелей")
        pg.click(".list .row:has-text('Жим гантелей')")
        pg.click("button:has-text('Добавить (1)')")
        pg.wait_for_selector(".ex-block")
        if warm:  # первый подход — разминка, второй — рабочий
            pg.click("button:has-text('Добавить подход')")
            pg.locator(".set-idx").first.click()
            pg.click("button.chip:has-text('Разминка')")
            pg.wait_for_selector(".set-idx sup:has-text('Р')", timeout=3000)
            check("отметка разминки видна на подходе", pg.locator(".set-idx sup:has-text('Р')").count() == 1)
        sets = pg.locator(".set-row, .ex-block .set").count()
        inputs = pg.locator(".ex-block input[inputmode='decimal'], .ex-block input[type='number']")
        # вес и повторы последнего подхода
        last = pg.locator(".ex-block .check").count() - 1
        row = pg.locator(".ex-block .check").nth(last).locator("xpath=ancestor::div[contains(@class,'set')][1]")
        row.locator("input[aria-label='кг']").fill(str(weight))
        row.locator("input[aria-label='повт.']").fill(str(reps))
        row.locator("input[aria-label='повт.']").press("Tab")  # значения фиксируются при потере фокуса
        pg.locator(".ex-block .check").nth(last).click()
        pg.click("button:has-text('Завершить тренировку')")
        pg.wait_for_timeout(300)

    A, B = phone(), phone()
    make_profile(A, "Дима")
    make_profile(B, "Аня")
    check("отпечаток ключа показан", re.search(r"[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}", A.inner_text("body")) is not None)

    do_workout(A, 100, 5, warm=True)   # 500 кг рабочего тоннажа; разминка не считается
    do_workout(B, 120, 5)              # 600 кг

    # ---------- добавление по коду ----------
    A.goto(BASE + "#/ratings")
    A.wait_for_selector("h1:has-text('Рейтинги')")
    check("до друзей в таблице только я", A.locator(".rank-row").count() == 1 and "(вы)" in A.inner_text(".rank-row"))
    A.click("button:has-text('Добавить друга или обновить итоги')")
    A.wait_for_selector(".sheet[aria-label^='Друзья']")
    A.click("button:has-text('Создать приглашение')")
    A.wait_for_selector(".room-code", timeout=10000)
    code = A.inner_text(".room-code").strip()

    B.goto(BASE + "#/ratings")
    B.click("button:has-text('Добавить друга или обновить итоги')")
    B.fill("#fr-code", code.lower().replace("-", ""))
    B.click("button:has-text('Подключиться')")

    A.wait_for_selector(".room-sas", timeout=30000)
    B.wait_for_selector(".room-sas", timeout=30000)
    sa, sb = A.inner_text(".room-sas"), B.inner_text(".room-sas")
    check("код сверки совпадает", re.fullmatch(r"\d{3} \d{3}", sa) is not None and sa == sb, f"{sa!r}/{sb!r}")
    check("видно имя и отпечаток ключа друга", "Аня" in A.inner_text(".room-status") and re.search(r"[0-9A-F]{4}-[0-9A-F]{4}", A.inner_text(".sheet-body")) is not None)
    A.screenshot(path="/tmp/friends_1_confirm.png")

    A.click("button:has-text('Добавить в друзья')")
    A.wait_for_selector("text=Ждём подтверждения от друга")
    check("после своего подтверждения ждём друга, ничего не сохранено", A.locator("text=добавлен").count() == 0)
    B.click("button:has-text('Добавить в друзья')")
    A.wait_for_selector("text=добавлен(а) в друзья", timeout=15000)
    B.wait_for_selector("text=добавлен(а) в друзья", timeout=15000)
    check("обмен завершён, получено 3 снимка", "Получено снимков: 3" in A.inner_text(".sheet-body"))
    A.click("button:has-text('Готово')")
    B.click("button:has-text('Готово')")
    A.wait_for_selector(".sheet", state="detached")

    # ---------- таблица ----------
    A.wait_for_selector(".rank-row >> nth=1")
    rows = A.locator(".rank-row")
    txt = [rows.nth(i).inner_text().replace("\n", " ") for i in range(rows.count())]
    check("друг в таблице; Аня (600 кг) выше Димы (500 кг)", len(txt) == 2 and txt[0].startswith("1") and "Аня" in txt[0] and "Дима" in txt[1] and "(вы)" in txt[1], txt)
    check("разминка не вошла в тоннаж", "500 кг" in txt[1] and "600 кг" in txt[0], txt)
    A.screenshot(path="/tmp/friends_2_table.png")

    A.click("button.chip:has-text('По упражнению')")
    A.wait_for_selector("#rt-ex")
    check("в выборе упражнения Жим гантелей у двоих", "2 чел." in A.inner_text("#rt-ex"))
    A.click("button.chip:has-text('Кардио')")
    check("кардио-таблица без данных не выдумывает значения", A.locator(".rank-row:not(.off)").count() == 0)
    A.click("button.chip:has-text('Общая нагрузка')")

    # ---------- повторное соединение: без подтверждений ----------
    A.click("button:has-text('Добавить друга или обновить итоги')")
    A.click("button:has-text('Создать приглашение')")
    A.wait_for_selector(".room-code", timeout=10000)
    code2 = A.inner_text(".room-code").strip()
    B.goto(BASE + "#/ratings")
    B.click("button:has-text('Добавить друга или обновить итоги')")
    B.fill("#fr-code", code2)
    B.click("button:has-text('Подключиться')")
    A.wait_for_selector("text=обновлены", timeout=30000)
    B.wait_for_selector("text=обновлены", timeout=30000)
    check("известный друг обновляется без подтверждения", True)
    A.click("button:has-text('Готово')")
    B.click("button:has-text('Готово')")

    # ---------- настройки друзей ----------
    A.goto(BASE + "#/settings/server")
    A.wait_for_selector(".row:has-text('Аня')")
    A.locator("input[aria-label='Аня: участвует в рейтинге']").evaluate("el => el.click()")
    A.goto(BASE + "#/ratings")
    A.wait_for_selector("h1:has-text('Рейтинги')")
    check("друг, выключенный из рейтинга, пропадает из таблицы", A.locator(".rank-row").count() == 1)
    A.goto(BASE + "#/settings/server")
    A.wait_for_selector(".row:has-text('Аня')")
    A.locator("input[aria-label='Аня: участвует в рейтинге']").evaluate("el => el.click()")

    A.click(".row:has-text('Аня') button:has-text('Заблокировать')")
    A.wait_for_selector("h3:has-text('Заблокированные')")
    # заблокированный не может соединиться
    A.goto(BASE + "#/ratings")
    A.click("button:has-text('Добавить друга или обновить итоги')")
    A.click("button:has-text('Создать приглашение')")
    A.wait_for_selector(".room-code")
    code3 = A.inner_text(".room-code").strip()
    B.goto(BASE + "#/ratings")
    B.click("button:has-text('Добавить друга или обновить итоги')")
    B.fill("#fr-code", code3)
    B.click("button:has-text('Подключиться')")
    A.wait_for_selector("[role=alert]", timeout=30000)
    B.wait_for_selector("[role=alert]", timeout=30000)
    check("блокировка: хост видит причину", "списке блокировок" in A.inner_text("[role=alert]"))
    check("блокировка: гость видит только отказ", "отклонил" in B.inner_text("[role=alert]"))

    # ---------- приватность ----------
    def leak(pg, needle):
        return pg.evaluate("""async (n) => { const hits = [];
          for (const {name} of await indexedDB.databases()) { const db = await new Promise((res) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); });
            for (const s of Array.from(db.objectStoreNames)) { const all = await new Promise((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
              try { if (JSON.stringify(all).includes(n)) hits.push(s); } catch (e) { /* CryptoKey не сериализуется в JSON */ } } db.close(); }
          return hits; }""", needle)
    # у Ани хранится только снимок Димы: в нём нет ни названий тренировок, ни заметок
    check("в снимках друга нет заметок и названий тренировок", leak(B, "Тренировка") == [] or leak(B, "Тренировка") == ["workouts"])
    keys = A.evaluate("""async () => { const db = await new Promise((res) => { const r = indexedDB.open('workout-pwa'); r.onsuccess = () => res(r.result); });
        const row = await new Promise((res) => { const r = db.transaction('profile').objectStore('profile').get('me'); r.onsuccess = () => res(r.result); });
        db.close(); return { type: row.privateKey && row.privateKey.constructor.name, extractable: row.privateKey && row.privateKey.extractable }; }""")
    check("приватный ключ хранится как неэкспортируемый CryptoKey", keys == {"type": "CryptoKey", "extractable": False}, keys)

    for name, pg in [("Дима", A), ("Аня", B)]:
        real = [l for l in pg.logs if "favicon" not in l]
        check(f"нет ошибок в консоли ({name})", real == [], real[:3])
    b.close()

if relay:
    relay.terminate()
print("\nИтого ошибок:", len(errors))
sys.exit(1 if errors else 0)
