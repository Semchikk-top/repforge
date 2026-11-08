"""Защитный слой: проверка Host (защита от DNS rebinding и подмены адреса в ссылках), защита от CSRF,
ограничение размера запросов и заголовки безопасности. Чистый ASGI, поэтому не ломает потоковые ответы (SSE)."""
from __future__ import annotations

import ipaddress
import json
import os
import socket
from urllib.parse import urlsplit

LOOPBACK_NAMES = {"localhost", "127.0.0.1", "::1"}
BODY_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
MAX_BODY = 16 * 1024 * 1024      # синхронизация: до 500 записей за раз
MAX_BODY_SMALL = 256 * 1024      # всё остальное

def relay_source(url: str | None) -> str:
    """Источник для connect-src из адреса релея комнаты «Рядом»: только ws:// и wss:// с именем хоста, без пути и логина.
    Пустая строка, если адрес не задан или некорректен: тогда браузер не даст приложению стучаться никуда, кроме себя."""
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return ""
    if parts.scheme not in ("ws", "wss") or not parts.hostname or parts.username or parts.password:
        return ""
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    if any(ch in host for ch in " ;,'\""):
        return ""
    return f"{parts.scheme}://{host}" + (f":{port}" if port else "")


def board_source(url: str | None) -> str:
    """Источник для connect-src из адреса сервиса мирового рейтинга: только http(s)://хост[:порт], без пути и логина."""
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return ""
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password or parts.path.strip("/") or parts.query or parts.fragment:
        return ""
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    if any(ch in host for ch in " ;,'\""):
        return ""
    return f"{parts.scheme}://{host}" + (f":{port}" if port else "")


# Уличное кардио (карта, маршрут, поиск адреса) ходит только на эти источники, и только после действия пользователя.
# По умолчанию — бесплатные публичные сервисы без ключей: тайлы и стили OpenFreeMap, маршруты Valhalla (FOSSGIS), поиск Nominatim.
# Свои копии (self-host): WORKOUT_MAP_ORIGINS=https://tiles.example,https://route.example,https://geo.example (через запятую,
# заменяет список целиком; пустая строка полностью отключает внешние запросы карты). Те же адреса задаются при сборке клиента:
# VITE_MAP_STYLE_LIGHT, VITE_MAP_STYLE_DARK, VITE_ROUTER_URL, VITE_GEOCODER_URL.
DEFAULT_MAP_ORIGINS = (
    "https://tiles.openfreemap.org",
    "https://valhalla1.openstreetmap.de",
    "https://nominatim.openstreetmap.org",
)


def map_origin(url: str | None) -> str:
    """Источник для connect-src из адреса сервиса карты: только https://хост[:порт]; путь отбрасывается, а логин, шаблоны (*) и мусор отклоняются."""
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return ""
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return ""
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    if any(ch in host for ch in " ;,'\"*"):
        return ""
    return f"https://{host}" + (f":{port}" if port else "")


def map_sources(raw: str | None) -> tuple[str, ...]:
    """Список источников карты из WORKOUT_MAP_ORIGINS. None — не задано: публичные по умолчанию; пустая строка — выключено."""
    if raw is None:
        return DEFAULT_MAP_ORIGINS
    out: list[str] = []
    for item in raw.split(","):
        src = map_origin(item)
        if src and src not in out:
            out.append(src)
    return tuple(out)


def build_csp(relay_url: str | None = None, board_url: str | None = None, map_origins: tuple[str, ...] | list[str] = ()) -> str:
    connect = "'self'" + (f" {relay_source(relay_url)}" if relay_source(relay_url) else "") + (f" {board_source(board_url)}" if board_source(board_url) else "")
    for src in map_origins:
        checked = map_origin(src)
        if checked and checked not in connect.split():
            connect += f" {checked}"
    return (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        f"font-src 'self' data:; connect-src {connect}; manifest-src 'self'; worker-src 'self'; "
        "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    )


# Сигнальный релей комнаты «Рядом» (WebSocket на другой адрес): WORKOUT_ROOM_RELAY_URL=wss://relay.example
# Он же задаётся при сборке клиента как VITE_ROOM_RELAY_URL. Камера не нужна: комната работает по коду.
# Сервис мирового рейтинга (отдельный публичный сервис board/): WORKOUT_BOARD_URL=https://board.example
# Он же задаётся при сборке клиента как VITE_BOARD_URL.
CSP = build_csp(os.environ.get("WORKOUT_ROOM_RELAY_URL"), os.environ.get("WORKOUT_BOARD_URL"), map_sources(os.environ.get("WORKOUT_MAP_ORIGINS")))
HEADERS = {
    b"content-security-policy": CSP.encode(),
    b"x-content-type-options": b"nosniff",
    b"x-frame-options": b"DENY",
    b"referrer-policy": b"no-referrer",
    b"cross-origin-opener-policy": b"same-origin",
    b"cross-origin-resource-policy": b"same-origin",
    b"permissions-policy": b"camera=(), microphone=(), geolocation=(self), payment=()"  # геолокация нужна для записи пробежек,
}


def split_host(value: str) -> str:
    """Имя хоста без порта; для IPv6 без скобок."""
    value = (value or "").strip().lower()
    if value.startswith("["):
        return value[1:].split("]")[0]
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _extra_hosts() -> set[str]:
    hosts = {h.strip().lower() for h in os.environ.get("WORKOUT_ALLOWED_HOSTS", "").split(",") if h.strip()}
    pub = os.environ.get("PUBLIC_URL", "")
    if pub:
        try:
            hosts.add((urlsplit(pub).hostname or "").lower())
        except ValueError:
            pass
    try:
        hosts.add(socket.gethostname().split(".")[0].lower())
    except OSError:
        pass
    return hosts - {""}


# Нативная оболочка (Capacitor) открывает приложение с собственного адреса: https://localhost на Android и
# capacitor://localhost на iOS. Для сервера это «чужой сайт», поэтому такие адреса разрешены явно (и только они).
# Это не ослабляет защиту: Origin ставит браузерный движок, страница подделать его не может, а программам вне
# браузера проверка Origin никогда не мешала; доступ к данным по-прежнему требует токена устройства или подтверждённого сопряжения.
# WORKOUT_NATIVE_ORIGINS=через,запятую — свой список; пустая строка отключает поддержку нативных клиентов.
NATIVE_ORIGINS_DEFAULT = "https://localhost,capacitor://localhost"
CORS_ALLOW_METHODS = b"GET, POST, PUT, PATCH, DELETE, OPTIONS"
CORS_ALLOW_HEADERS = b"authorization, content-type"


def native_origins() -> set[str]:
    raw = os.environ.get("WORKOUT_NATIVE_ORIGINS", NATIVE_ORIGINS_DEFAULT)
    return {o.strip().lower().rstrip("/") for o in raw.split(",") if o.strip()}


def cors_headers(origin: str) -> list[tuple[bytes, bytes]]:
    """CORS без cookie: авторизация идёт заголовком Authorization, поэтому Allow-Credentials не нужен."""
    return [
        (b"access-control-allow-origin", origin.encode("latin-1")),
        (b"access-control-allow-methods", CORS_ALLOW_METHODS),
        (b"access-control-allow-headers", CORS_ALLOW_HEADERS),
        (b"access-control-max-age", b"600"),
        (b"vary", b"Origin"),
    ]


def host_allowed(value: str) -> bool:
    """Разрешены: localhost, адреса частных сетей (LAN, Tailscale 100.64/10), *.ts.net, *.local и явно заданные.
    Публичные имена и адреса отклоняются: так чужой сайт не сможет достучаться до сервера через DNS rebinding."""
    host = split_host(value)
    if not host:
        return False
    if host in LOOPBACK_NAMES or host.endswith((".ts.net", ".local", ".localhost")):
        return True
    try:
        return not ipaddress.ip_address(host).is_global
    except ValueError:
        return host in _extra_hosts()


def origin_matches(origin: str, host: str) -> bool:
    try:
        return (urlsplit(origin).netloc or "").lower() == host.strip().lower()
    except ValueError:
        return False


class SecurityMiddleware:
    def __init__(self, app):
        self.app = app

    async def _reject(self, send, status: int, message: str, extra=()):
        body = json.dumps({"detail": message}, ensure_ascii=False).encode()
        headers = [(b"content-type", b"application/json; charset=utf-8"), (b"content-length", str(len(body)).encode()), (b"cache-control", b"no-store")]
        headers += list(HEADERS.items()) + list(extra)
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        h = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        method, path = scope["method"], scope["path"]
        host = h.get("host", "")

        if not host_allowed(host):
            return await self._reject(send, 421, "Неизвестный адрес сервера. Добавь его в WORKOUT_ALLOWED_HOSTS.")

        origin_h = h.get("origin", "")
        native = bool(origin_h) and origin_h.lower().rstrip("/") in native_origins()
        cors = cors_headers(origin_h) if native and path.startswith("/api/") else []

        if native and cors and method == "OPTIONS" and "access-control-request-method" in h:
            # предзапрос CORS: отвечаем сразу, до приложения
            await send({"type": "http.response.start", "status": 204, "headers": cors + [(b"content-length", b"0"), (b"cache-control", b"no-store")] + list(HEADERS.items())})
            return await send({"type": "http.response.body", "body": b""})

        if method in BODY_METHODS and path.startswith("/api/"):
            # CSRF: запросы с другого сайта не принимаем, даже если браузер разрешил их отправить
            origin, site = h.get("origin"), h.get("sec-fetch-site")
            fwd = h.get("x-forwarded-host", "").split(",")[0].strip()
            # За прокси (Tailscale Serve и т.п.) Host может быть переписан, а Origin остаётся публичным: поэтому адрес
            # сверяем и с X-Forwarded-Host, а метка браузера Sec-Fetch-Site (её страница подделать не может) считается надёжной.
            # Чужой сайт не может ни поставить X-Forwarded-Host (нужна проверка CORS), ни подделать Sec-Fetch-Site.
            same_origin = site == "same-origin" or (bool(origin) and (origin_matches(origin, host) or (bool(fwd) and origin_matches(origin, fwd))))
            if not native and (origin == "null" or site == "cross-site" or (origin and not same_origin)):
                return await self._reject(send, 403, "Запрос с чужого сайта отклонён")
            length = h.get("content-length")
            if length is None and "transfer-encoding" in h:
                return await self._reject(send, 411, "Нужен Content-Length", cors)
            limit = MAX_BODY if path == "/api/sync" else MAX_BODY_SMALL
            try:
                if length is not None and int(length) > limit:
                    return await self._reject(send, 413, "Запрос слишком большой", cors)
            except ValueError:
                return await self._reject(send, 400, "Некорректный Content-Length", cors)
            if (length not in (None, "0")) and "application/json" not in h.get("content-type", "").lower():
                return await self._reject(send, 415, "Нужен Content-Type: application/json", cors)

        secure = scope.get("scheme") == "https" or h.get("x-forwarded-proto", "").split(",")[0].strip() == "https"

        async def send_wrapped(msg):
            if msg["type"] == "http.response.start":
                headers = list(msg.get("headers", []))
                names = {k.lower() for k, _ in headers}
                for k, v in HEADERS.items():
                    if k not in names:
                        headers.append((k, v))
                if path.startswith("/api/") and b"cache-control" not in names:
                    headers.append((b"cache-control", b"no-store"))
                headers.extend(cors)
                if secure:
                    headers.append((b"strict-transport-security", b"max-age=31536000"))
                msg = {**msg, "headers": headers}
            await send(msg)

        await self.app(scope, receive, send_wrapped)
