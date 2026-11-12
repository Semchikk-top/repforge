"""Команды: python -m server pair | devices | revoke <id> | restore <id> | backup | run | content …"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime

from . import db as store


def _print_qr(url: str) -> None:
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except Exception:
        print("(для QR-кода: pip install qrcode)")


def netinfo_loopback() -> set[str]:
    return {"127.0.0.1", "localhost", "::1"}


def _pair_target(args: argparse.Namespace, instance: str) -> str | None:
    """Выбрать адрес и убедиться, что он ведёт к серверу с этой же БД.

    Раньше код создавался до определения адреса. Если команду запускали из старой
    копии проекта, код попадал в другую SQLite, а сервер отвечал «устарел». Теперь
    при явном --url проверяется instance, а при автоопределении проверяется ещё и
    запасной loopback-адрес. Код не создаётся, пока адрес не подтверждён.
    """
    import asyncio

    from . import netinfo

    requested = args.url.strip().rstrip("/")
    if requested:
        actual = asyncio.run(netinfo.health_instance(requested))
        if actual is None:
            print(f"Ошибка: {requested}/api/health не отвечает. Код не создан.")
            print("Проверь, что сервис запущен, и запускай команду из каталога app.")
            return None
        if actual != instance:
            print(f"Ошибка: {requested} обслуживает другой сервер (instance {actual}), "
                  f"а БД {store.DB_PATH} имеет instance {instance}. Код не создан.")
            print("Похоже, команда запущена из старой копии проекта. Перейди в каталог app.")
            return None
        print(f"Адрес проверен: {requested}")
        return requested

    cands = asyncio.run(netinfo.detect(instance, args.port))
    best = netinfo.pick_best(cands)
    if best is not None:
        url = cands[best].url
        note = "" if cands[best].secure else "  (HTTP: приложение установить нельзя, нужен HTTPS, см. README)"
        print(f"Лучший найденный адрес: {url}{note}")
        return url

    fallback = f"http://127.0.0.1:{args.port}"
    actual = asyncio.run(netinfo.health_instance(fallback))
    if actual is None:
        print(f"Ошибка: {fallback}/api/health не отвечает. Код не создан.")
        print("Запусти сервер (systemctl --user start workout) и повтори команду.")
        return None
    if actual != instance:
        print(f"Ошибка: {fallback} обслуживает другой сервер (instance {actual}), "
              f"а БД {store.DB_PATH} имеет instance {instance}. Код не создан.")
        print("Похоже, команда запущена из старой копии проекта. Перейди в каталог app.")
        return None
    print(f"Доступный по сети адрес не найден, использую {fallback} (подходит для этого ПК).")
    return fallback


def main() -> int:
    ap = argparse.ArgumentParser(prog="python -m server")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pair", help="создать одноразовый код для подключения устройства")
    p.add_argument("--url", default=os.environ.get("PUBLIC_URL", ""), help="адрес сервера; если не указан, определяется автоматически")
    p.add_argument("--port", type=int, default=int(os.environ.get("WORKOUT_PORT", "8000")), help="порт сервера для автоопределения адреса")
    sub.add_parser("devices", help="список устройств")
    r = sub.add_parser("revoke", help="отозвать устройство")
    r.add_argument("device_id")
    rs = sub.add_parser("restore", help="вернуть отозванное устройство (в течение суток после отзыва)")
    rs.add_argument("device_id")
    sub.add_parser("backup", help="сделать резервную копию сейчас")
    d = sub.add_parser("discover", help="найти опубликованные серверы в локальной сети (mDNS)")
    d.add_argument("--seconds", type=float, default=3.0)
    run = sub.add_parser("run", help="запустить сервер")
    run.add_argument("--host", default=os.environ.get("WORKOUT_HOST", os.environ.get("HOST", "127.0.0.1")))
    run.add_argument("--port", type=int, default=int(os.environ.get("WORKOUT_PORT", os.environ.get("PORT", "8000"))))
    run.add_argument("--mdns", action="store_true", help="опубликовать сервис в локальной сети (нужен --host 0.0.0.0)")
    from .knowledge import cli as knowledge_cli

    knowledge_cli.add_parser(sub)
    args = ap.parse_args()

    if args.cmd == "content":
        return knowledge_cli.run(args)

    if args.cmd == "discover":
        from . import mdns

        try:
            found = mdns.discover(args.seconds)
        except RuntimeError as e:  # нет zeroconf: это ошибка окружения, а не повод для traceback
            print(e)
            return 2
        except Exception as e:  # сеть/сокеты/mDNS: показываем причину, а не стек
            print(f"mDNS: поиск не удался: {e}")
            return 2
        if not found:
            print("Ничего не найдено. Проверь, что сервер запущен с --host 0.0.0.0 --mdns и ПК в той же сети.")
        for f in found:
            print(f"{f['name']}: {', '.join(f['addresses'])}:{f['port']}  {f['txt']}")
        return 0

    if args.cmd == "run":
        import uvicorn

        # нужно приложению: определить адреса и решить, публиковать ли mDNS
        os.environ["WORKOUT_HOST"], os.environ["WORKOUT_PORT"] = args.host, str(args.port)
        if args.mdns:
            os.environ["WORKOUT_MDNS"] = "1"

        if args.host not in netinfo_loopback():
            print("ВНИМАНИЕ: сервер слушает не только localhost. По HTTP токены и данные идут открытым текстом; "
                  "используй только в доверенной сети, лучше Tailscale с HTTPS.")
        uvicorn.run("server.main:app", host=args.host, port=args.port, server_header=False, forwarded_allow_ips="127.0.0.1")
        return 0

    conn = store.connect()
    if args.cmd == "pair":
        instance = store.instance_id(conn)
        print(f"БД: {store.DB_PATH}  instance: {instance}")
        url = _pair_target(args, instance)
        if url is None:
            return 2
        code = store.create_pair_code(conn)
        print(f"\nКод подключения: {code[:4]}-{code[4:]}  (действует 10 минут, один раз)")
        link = f"{url.rstrip('/')}/#/pair/{code}"
        print(f"Ссылка: {link}\n")
        _print_qr(link)
    elif args.cmd == "devices":
        for d in conn.execute("SELECT * FROM devices ORDER BY created_at"):
            seen = datetime.fromtimestamp(d["last_seen"]).strftime("%Y-%m-%d %H:%M") if d["last_seen"] else "никогда"
            print(f"{d['id']}  {store.sanitize_name(d['name']):<20} {'ОТОЗВАНО' if d['revoked'] else 'активно':<9} был: {seen}")
    elif args.cmd == "revoke":
        print("Отозвано" if store.revoke_device(conn, args.device_id) else "Устройство не найдено")
    elif args.cmd == "restore":
        msg = {"ok": "Восстановлено", "not_found": "Устройство не найдено", "not_revoked": "Устройство не было отозвано",
               "expired": "Прошло больше суток после отзыва: подключи устройство заново по коду"}
        print(msg[store.restore_device(conn, args.device_id)])
    elif args.cmd == "backup":
        from .main import backup_once

        print(backup_once(conn, store.DATA_DIR))
    return 0


if __name__ == "__main__":
    sys.exit(main())
