"""Озвучка Fish Speech сквозь настоящий браузер: подключение, голос, подготовка пака, локальное воспроизведение (CSP), студия.
Нужен подставной Fish из tests/ui/fake_provider.py (адрес — FISH_SPEECH_URL у сервера)."""
import io, math, os, re, struct, subprocess, sys, tempfile, wave

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8767/")
FAKE = os.environ.get("FAKE_URL", "http://127.0.0.1:8790")
errors = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + (" " + str(extra) if extra else ""))
    if not cond:
        errors.append(name)


def new_code():
    out = subprocess.run([sys.executable, "-m", "server", "pair", "--url", BASE.rstrip("/")], capture_output=True, text=True).stdout
    m = re.search(r"Код подключения: (\w{4})-(\w{4})", out)
    return m.group(1) + m.group(2)


def sample_wav(path, sec=6):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", int(5000 * math.sin(i / 15))) for i in range(sec * 16000)))


wav = os.path.join(tempfile.mkdtemp(), "golos.wav")
sample_wav(wav)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg = ctx.new_page()
    logs = []
    pg.on("console", lambda m: logs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: logs.append(str(e)))
    pg.goto(BASE + "#/pair/" + new_code())
    pg.wait_for_selector("text=Синхронизировано", timeout=10000)

    # --- без включённого Fish озвучка системная, блоков Fish нет
    pg.goto(BASE + "#/settings/voice")
    pg.wait_for_selector("h2:has-text('Голос подсказок')")
    check("по умолчанию системный голос", pg.get_attribute(".seg[aria-label='Движок озвучки']", "data-i") == "0")
    check("блока подготовки нет, пока Fish выключен", pg.locator("h2:has-text('Подготовка озвучки')").count() == 0)

    # --- подключение на вкладке «Сервер»
    pg.click("[role=tab]:has-text('Сервер')")
    pg.wait_for_selector("#fish-url")
    check("адрес Fish подставлен с сервера", pg.input_value("#fish-url").startswith("http://127.0.0.1"))
    pg.fill("#fish-key", "secret-fish-key-9999")
    pg.click("button:has-text('Сохранить')")
    pg.wait_for_selector("label:has-text('задан ••••9999')")
    check("ключ скрыт, виден только хвост", "secret-fish-key" not in pg.content() and pg.input_value("#fish-key") == "")
    pg.click("button:has-text('Проверить')")
    pg.wait_for_selector("text=Fish отвечает")
    check("сервер видит Fish", True)

    # --- включаем Fish, добавляем голос
    pg.click("[role=tab]:has-text('Звук')")
    pg.click(".seg[aria-label='Движок озвучки'] button:has-text('Fish Speech')")
    pg.wait_for_selector("text=ПК отвечает")
    pg.click("button:has-text('Добавить голос')")
    pg.fill("#voice-name", "Тест-голос")
    pg.set_input_files("#voice-file", wav)
    pg.fill("#voice-text", "Это образец моего голоса для проверки.")
    check("без согласия кнопка неактивна", pg.locator("[role=dialog] button:has-text('Добавить голос')").is_disabled())
    pg.check("[role=dialog] input[type=checkbox]")
    pg.click("[role=dialog] button:has-text('Добавить голос')")
    pg.wait_for_selector(".row:has-text('Тест-голос')", timeout=10000)
    pg.wait_for_selector(".row:has-text('Тест-голос'):has-text('выбран')", timeout=5000)
    check("голос добавлен и выбран", True)

    # --- подготовка пака
    pg.click("button:has-text('Подготовить озвучку')")
    pg.wait_for_selector("[role=status]:has-text('Готово:')", timeout=60000)
    total = int(re.search(r"Готово: (\d+) фраз", pg.inner_text("[role=status]:has-text('Готово:')")).group(1))
    check("подготовлены постоянные фразы", total >= 10, total)
    check("счётчик «Готово N из N»", f"Готово {total} из {total} постоянных фраз" in pg.inner_text("body"))
    n_files = pg.evaluate("caches.open('repforge-tts-v1').then(c => c.keys()).then(k => k.length)")
    check("файлы лежат в памяти устройства", n_files == total, n_files)
    calls = httpx.get(FAKE + "/_fish_calls").json()["calls"]
    check("Fish вызывался по разу на фразу", calls == total, calls)

    # --- повторная подготовка ничего не просит у Fish
    pg.click("button:has-text('Подготовить озвучку')")
    pg.wait_for_selector("[role=status]:has-text('Всё уже готово')", timeout=20000)
    check("повтор идемпотентен", httpx.get(FAKE + "/_fish_calls").json()["calls"] == calls)

    # --- пережили перезагрузку
    pg.reload()
    pg.wait_for_selector("text=Готово %d из %d постоянных фраз" % (total, total), timeout=15000)
    check("пак переживает перезагрузку", True)

    # --- студия: синтез, кеш, воспроизведение из blob (проверка CSP media-src)
    pg.fill("#studio-text", "Через 120 метров поверните налево.")
    pg.click("button:has-text('Озвучить')")
    pg.wait_for_selector("[role=status]:has-text('Готово.'), [role=status]:has-text('Не удалось')", timeout=30000)
    msg = pg.inner_text("[role=status]:has-text('Готово.'), [role=status]:has-text('Не удалось')")
    check("студия: файл синтезирован и проигран", msg.startswith("Готово"), msg)
    c1 = httpx.get(FAKE + "/_fish_calls").json()["calls"]
    pg.click("button:has-text('Озвучить')")
    pg.wait_for_selector("[role=status]:has-text('Из кеша ПК')", timeout=30000)
    check("повтор из кеша ПК без обращения к Fish", httpx.get(FAKE + "/_fish_calls").json()["calls"] == c1)
    check("можно сохранить файл", pg.locator("button:has-text('Сохранить файл')").count() == 1)

    # --- удаление озвучки с устройства
    pg.once("dialog", lambda d: d.accept())
    pg.click("button:has-text('Удалить озвучку с устройства')")
    pg.wait_for_selector("text=Готово 0 из")
    check("озвучка удалена с устройства", pg.evaluate("caches.open('repforge-tts-v1').then(c => c.keys()).then(k => k.length)") == 0)

    # --- голос удаляется
    pg.once("dialog", lambda d: d.accept())
    pg.click("button[aria-label='Удалить голос Тест-голос']")
    pg.wait_for_selector("text=Голосов пока нет")
    check("голос удалён", True)

    ov = pg.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    check("нет горизонтального переполнения", ov[0] <= ov[1], ov)
    pg.screenshot(path="/tmp/voice_tab.png")
    check("нет ошибок в консоли (в том числе нарушений CSP)", not logs, logs[:3])
    b.close()

print("\nИТОГ:", "всё хорошо" if not errors else f"провалено: {errors}")
sys.exit(1 if errors else 0)
