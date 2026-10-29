"""Запуск и модерация:  python -m board run | stats | find | reports | hide | unhide | ban | delete"""
from __future__ import annotations

import argparse
import json
import os

from . import admin
from .store import Store


def main() -> None:
    ap = argparse.ArgumentParser(prog="board")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="запустить сервис")
    r.add_argument("--host", default=os.environ.get("BOARD_HOST", "127.0.0.1"))
    r.add_argument("--port", type=int, default=int(os.environ.get("BOARD_PORT", "8800")))
    sub.add_parser("stats", help="сколько участников, итогов и жалоб")
    f = sub.add_parser("find", help="найти участника по нику или id"); f.add_argument("text")
    sub.add_parser("reports", help="на кого жаловались")
    for name, hlp in (("hide", "скрыть из таблиц"), ("unhide", "вернуть в таблицы и стереть жалобы"), ("ban", "скрыть навсегда и стереть итоги"), ("delete", "стереть участника целиком")):
        p = sub.add_parser(name, help=hlp); p.add_argument("who", help="id участника или тег из таблицы (#ab12)")
    a = ap.parse_args()

    if a.cmd == "run":
        import uvicorn
        from .app import create_app
        uvicorn.run(create_app(), host=a.host, port=a.port, log_level="warning", proxy_headers=False)
        return
    st = Store()
    if a.cmd == "stats":
        print(json.dumps(st.stats(), ensure_ascii=False, indent=1))
    elif a.cmd == "find":
        for row in admin.find(st, a.text):
            print(row["profile_id"], row["status"], row["nick"])
    elif a.cmd == "reports":
        for row in admin.reports(st):
            print(f'{row["n"]:3d}  {row["status"]:7s}  {row["profile_id"]}  {row["nick"]}  [{row["reasons"]}]')
    else:
        status = {"hide": "hidden", "unhide": "ok", "ban": "banned"}.get(a.cmd)
        print((admin.set_status(st, a.who, status) if status else admin.delete(st, a.who)), "готово")


if __name__ == "__main__":
    main()
