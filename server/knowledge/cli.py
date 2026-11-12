"""Команды `python -m server content …`."""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime
from pathlib import Path

from ..assistant.content import content_dir
from . import draft as D
from . import golden as G
from . import model as M
from . import sources as S
from .sources import KnowledgeError


def add_parser(sub: argparse._SubParsersAction) -> None:
    c = sub.add_parser("content", help="конвейер знаний: источники, черновики карточек, проверки")
    cs = c.add_subparsers(dest="ccmd", required=True)

    s = cs.add_parser("source", help="источники и снимки текста")
    ss = s.add_subparsers(dest="scmd", required=True)
    a = ss.add_parser("add", help="добавить источник (только открытые лицензии)")
    a.add_argument("--id", required=True)
    a.add_argument("--title", required=True)
    a.add_argument("--author", required=True)
    a.add_argument("--url", required=True, help="адрес оригинала (https://)")
    a.add_argument("--license", required=True, help="например CC-BY-4.0")
    a.add_argument("--file", required=True, type=Path, help="текст или сохранённая страница (.txt, .md, .html)")
    sn = ss.add_parser("snapshot", help="добавить снимок текста к источнику, который уже есть в реестре")
    sn.add_argument("--id", required=True)
    sn.add_argument("--file", required=True, type=Path)
    ss.add_parser("list", help="список источников")

    d = cs.add_parser("draft", help="черновик карточки или принципа от модели")
    d.add_argument("kind", choices=["card", "principle"])
    d.add_argument("target", help="seed-001 для карточки, slug для принципа")
    d.add_argument("--source", required=True)
    d.add_argument("--start", type=int)
    d.add_argument("--end", type=int)
    d.add_argument("--lang", default="ru", help="язык источника; не ru → перевод и обязательная сверка терминов")
    d.add_argument("--backend", default="local", choices=["local", "agent", "cloud"])
    d.add_argument("--allow-cloud", action="store_true", help="разрешить отправку текста облачной модели")

    for name, h in (("check", "заново прогнать механические проверки"), ("review", "показать черновик рядом с источником"), ("accept", "перенести в content/ со статусом draft")):
        p = cs.add_parser(name, help=h)
        p.add_argument("kind", choices=["card", "principle"])
        p.add_argument("target")
        if name == "review":
            p.add_argument("--terms-ok", action="store_true", help="подтвердить, что терминология сверена вручную")
        if name == "accept":
            p.add_argument("--replace", action="store_true")

    g = cs.add_parser("golden", help="золотой набор: прогон на проверенных карточках")
    gs = g.add_subparsers(dest="gcmd", required=True)
    r = gs.add_parser("run")
    r.add_argument("--set", type=Path, default=None, help="по умолчанию content/golden/golden.json")
    r.add_argument("--backend", default="local", choices=["local", "agent", "cloud"])
    r.add_argument("--allow-cloud", action="store_true")
    sc = gs.add_parser("score")
    sc.add_argument("sheet", type=Path)
    sc.add_argument("--threshold", type=float, default=G.DEFAULT_THRESHOLD)


def _load(root: Path, kind: str, target: str) -> tuple[Path, dict]:
    p = D.draft_path(root, kind, target)
    if not p.exists():
        raise KnowledgeError(f"Черновика {kind} {target} нет. Создай: `content draft {kind} {target} --source …`.")
    return p, json.loads(p.read_text(encoding="utf-8"))


def _print_checks(checks: list[dict]) -> None:
    if not checks:
        print("Механические проверки: всё в порядке.")
        return
    print(f"Механические проверки: замечаний {len(checks)}")
    for c in checks:
        print(f"  ✗ {c['where'] or '-'}: {c['message']}")


def _overrides():
    try:  # настройки подключения из приложения лежат в БД; если её нет, берутся переменные окружения
        from .. import db as store
        from ..assistant import config as acfg
        return acfg.load_overrides(store.connect())
    except Exception:
        return None


def _models(args) -> tuple[object, dict]:
    be = M.pick_backend(args.backend, allow_cloud=args.allow_cloud, overrides=_overrides())
    if be.name == "cloud":
        print("ВНИМАНИЕ: текст источника отправляется облачной модели.")
    return M.make_ask(be)


def run(args: argparse.Namespace) -> int:
    root = content_dir()
    try:
        return _run(args, root)
    except KnowledgeError as e:
        print(f"Ошибка: {e}")
        return 2


def _run(args: argparse.Namespace, root: Path) -> int:
    if args.ccmd == "source":
        if args.scmd == "add":
            e = S.add_source(root, id=args.id, title=args.title, author=args.author, url=args.url, license=args.license, file=args.file)
            print(f"Источник {e['id']} добавлен, снимок текста сохранён (content/snapshots/{e['id']}.txt).")
            print("Не забудь запустить `npm run content:check`.")
            return 0
        if args.scmd == "snapshot":
            sha = S.attach_snapshot(root, args.id, args.file)
            print(f"Снимок для {args.id} сохранён (sha256 {sha[:12]}…).")
            return 0
        for s in S.list_sources(root):
            print(f"{s['id']}  {s['license']}  {s['title']}")
        return 0

    if args.ccmd == "draft":
        ask, info = _models(args)
        print("Запрос к модели…")
        doc = asyncio.run(D.make_draft(root, kind=args.kind, target=args.target, source_id=args.source, ask=ask, model=lambda: info["model"], backend=args.backend,
                                       start=args.start, end=args.end, lang=args.lang))
        print(f"Черновик: content/drafts/{args.kind}-{args.target}.json (модель {doc['model']})")
        _print_checks(doc["checks"])
        print("Дальше: `content review …`, потом `content accept …`. Статус reviewed и published ставишь только ты.")
        return 0

    if args.ccmd == "golden":
        if args.gcmd == "score":
            res = G.score_sheet(args.sheet.read_text(encoding="utf-8"), args.threshold)
            print(f"Утверждений: {res['total']}; верно {res['ok']}, правки по смыслу {res['changes']}, искажено {res['distorted']}, цитата не найдена {res['quoteMissing']}")
            print(f"Требуют правки: {res['needFix']} ({res['rate']:.0%}); порог {res['threshold']:.0%} → {'ПРОЙДЕН' if res['passed'] else 'НЕ ПРОЙДЕН'}")
            if not res["passed"]:
                print("Пробуй другую модель или оставайся на ручном наполнении.")
            return 0 if res["passed"] else 1
        path = args.set or root / "golden" / "golden.json"
        if not path.exists():
            raise KnowledgeError(f"Нет файла {path}. Формат: [{{\"kind\": \"card\", \"target\": \"seed-001\", \"source\": \"…\", \"start\": 0, \"end\": 9000, \"lang\": \"en\"}}]")
        ask, info = _models(args)
        out = root / "golden" / "runs" / datetime.now().strftime("%Y%m%d-%H%M%S")
        sheet, st = asyncio.run(G.run_golden(root, json.loads(path.read_text(encoding="utf-8")), ask=ask, model=lambda: info["model"], backend=args.backend, out_dir=out))
        print(f"Лист оценки: {sheet}\nУтверждений {st['claims']}, цитата найдена у {st['quoteFound']}.")
        print(f"Разметь лист и запусти: python -m server content golden score {sheet}")
        return 0

    p, doc = _load(root, args.kind, args.target)
    if args.ccmd == "check":
        doc["checks"] = D.recheck(root, doc)
        D._write_json(p, doc)
        _print_checks(doc["checks"])
        return 0 if not doc["checks"] else 1
    if args.ccmd == "review":
        _review(root, doc)
        if args.terms_ok:
            if doc.get("language", "ru") == "ru":
                print("Источник на русском: подтверждать термины не нужно.")
            else:
                doc["termsChecked"] = datetime.now().date().isoformat()
                D._write_json(p, doc)
                print(f"Терминология отмечена как сверенная ({doc['termsChecked']}).")
        return 0
    path = D.accept(root, doc, replace=args.replace)
    print(f"Записано: {path} (status: draft). Проверь `npm run content:check`, затем `npm run content:status -- {args.target} reviewed`.")
    return 0


def _review(root: Path, doc: dict) -> None:
    text, _ = S.load_snapshot(root, doc["source"])
    frag = text[doc["range"][0] : doc["range"][1]]
    src = S.get_source(root, doc["source"]) or {}
    print(f"{doc['kind']} {doc['target']} · источник: {src.get('title')} ({src.get('license')}) · модель {doc['model']}")
    print("=" * 60)
    from .text import normalize
    fnorm = normalize(frag)
    for k, v in doc["fields"].items():
        print(f"\n{k}:")
        for line in (v if isinstance(v, list) else [v]):
            print(f"  {line}")
    print("\nУтверждения и цитаты:")
    for i, c in enumerate(doc.get("claims") or []):
        if not isinstance(c, dict):
            continue
        found = " " + normalize(str(c.get("quote", ""))) + " " in " " + fnorm + " "
        label = f"{c.get('field')}" + (f"[{c['item']}]" if isinstance(c.get("item"), int) else "")
        print(f"  {'✓' if found else '✗'} {label}: {c.get('text')}\n      «{c.get('quote')}»{'' if found else '  ← в источнике не найдена'}")
    if doc.get("terms"):
        print("\nТермины для сверки:" + ("" if doc.get("termsChecked") else "  (ещё не сверены)"))
        for t in doc["terms"]:
            print(f"  {t['src']} → {t['ru']}")
    print()
    _print_checks(D.recheck(root, doc))
