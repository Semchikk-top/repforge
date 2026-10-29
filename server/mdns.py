"""Публикация сервиса в локальной сети (mDNS / DNS-SD): _workout._tcp.local.

Важно: из браузера (PWA) такие сервисы найти нельзя, у веб-платформы нет API для mDNS. Публикация нужна
нативным клиентам, утилитам (avahi-browse, dns-sd) и даёт ПК имя <host>.local там, где система умеет его разрешать."""
from __future__ import annotations

import socket

from . import netinfo

SERVICE_TYPE = "_workout._tcp.local."


async def start(port: int, instance: str):
    """Возвращает объект, который нужно остановить через stop(), или None, если публиковать нельзя."""
    try:
        from zeroconf import ServiceInfo
        from zeroconf.asyncio import AsyncZeroconf
    except ImportError:
        print("mDNS: библиотека zeroconf не установлена (pip install zeroconf)")
        return None
    ips = netinfo.lan_ips()
    if not ips:
        print("mDNS: не нашёл адрес в локальной сети, публикация пропущена")
        return None
    host = socket.gethostname().split(".")[0]
    info = ServiceInfo(
        SERVICE_TYPE,
        f"Workout на {host}.{SERVICE_TYPE}",
        addresses=[socket.inet_aton(ip) for ip in ips],
        port=port,
        properties={"v": "1", "id": instance[:8], "path": "/"},
        server=f"{host}.local.",
    )
    zc = AsyncZeroconf()
    await zc.async_register_service(info)
    print(f"mDNS: сервис опубликован как {host}.local:{port}")
    return zc, info


async def stop(handle) -> None:
    if not handle:
        return
    zc, info = handle
    await zc.async_unregister_service(info)
    await zc.async_close()


def discover(seconds: float = 3.0) -> list[dict]:
    """Ищет _workout._tcp в сети (для проверки с ПК: python -m server discover)."""
    import time

    try:
        from zeroconf import ServiceBrowser, Zeroconf
    except ImportError as e:
        raise RuntimeError(
            "mDNS: библиотека zeroconf не установлена. "
            "Установи зависимости сервера: .venv/bin/pip install -r server/requirements.txt"
        ) from e

    found: dict[str, dict] = {}

    class L:
        def add_service(self, zc, type_, name):
            info = zc.get_service_info(type_, name, timeout=1500)
            if info:
                found[name] = {
                    "name": name.split(".")[0],
                    "addresses": [socket.inet_ntoa(a) for a in info.addresses if len(a) == 4],
                    "port": info.port,
                    "txt": {k.decode(): (v or b"").decode() for k, v in info.properties.items()},
                }

        def update_service(self, *a): ...
        def remove_service(self, *a): ...

    zc = Zeroconf()
    try:
        ServiceBrowser(zc, SERVICE_TYPE, L())
        time.sleep(seconds)
    finally:
        zc.close()
    return list(found.values())
