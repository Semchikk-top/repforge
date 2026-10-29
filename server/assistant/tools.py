"""Инструменты ассистента: чтение журнала тренировок из БД сервера (только чтение)."""
from __future__ import annotations

import inspect
import json
import sqlite3
from datetime import date, timedelta
from typing import Any

MUSCLES = ["chest", "back", "legs", "glutes", "shoulders", "biceps", "triceps", "core", "calves", "forearms", "cardio"]

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_recent_workouts",
        "description": "Последние завершённые тренировки с упражнениями и подходами (вес × повторы), объёмом и заметками.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "За сколько последних дней, по умолчанию 30"},
                "limit": {"type": "integer", "description": "Максимум тренировок, по умолчанию 10"},
            },
        },
    },
    {
        "name": "get_exercise_history",
        "description": "История одного упражнения по тренировкам: подходы и лучший расчётный максимум на 1 повторение (e1RM). Название можно писать приблизительно.",
        "input_schema": {
            "type": "object",
            "properties": {
                "exercise": {"type": "string", "description": "Название или часть названия, например 'жим лёжа'"},
                "limit": {"type": "integer", "description": "Сколько последних тренировок, по умолчанию 8"},
            },
            "required": ["exercise"],
        },
    },
    {
        "name": "get_personal_records",
        "description": "Личные рекорды по упражнениям (лучший расчётный максимум на 1 повторение и подход, которым он поставлен).",
        "input_schema": {"type": "object", "properties": {"limit": {"type": "integer", "description": "По умолчанию 15"}}},
    },
    {
        "name": "get_weekly_summary",
        "description": "Сводка по неделям: число тренировок, подходов и суммарный объём (кг).",
        "input_schema": {"type": "object", "properties": {"weeks": {"type": "integer", "description": "По умолчанию 8"}}},
    },
    {
        "name": "get_cardio_history",
        "description": "Кардио (бег, ходьба, велосипед) за период: дистанция, время, темп, набор высоты по каждому занятию и итоги. Координаты маршрутов недоступны.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "За сколько последних дней, по умолчанию 30"},
                "limit": {"type": "integer", "description": "Максимум занятий, по умолчанию 15"},
            },
        },
    },
    {
        "name": "get_planned_workouts",
        "description": "Запланированные и идущие сейчас тренировки, начиная с сегодняшнего дня.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_exercises",
        "description": "Справочник упражнений пользователя (название, группа мышц, оборудование). Можно искать по части названия или группе мышц.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "muscle": {"type": "string", "enum": MUSCLES},
            },
        },
    },
    {
        "name": "propose_workout",
        "description": (
            "Предложить пользователю тренировку на конкретную дату. Она НЕ добавляется сама: пользователь увидит карточку и подтвердит. "
            "Используй, когда просят составить, запланировать или изменить тренировку. Предпочитай упражнения из справочника пользователя."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "Дата YYYY-MM-DD"},
                "title": {"type": "string", "description": "Короткое название, например 'Грудь и трицепс'"},
                "exercises": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "sets": {"type": "integer"},
                            "reps": {"type": "integer"},
                            "weight_kg": {"type": "number", "description": "Рабочий вес; если неизвестен, не указывай"},
                            "muscle": {"type": "string", "enum": MUSCLES, "description": "Нужно только для упражнений вне справочника"},
                        },
                        "required": ["name", "sets", "reps"],
                    },
                },
            },
            "required": ["date", "title", "exercises"],
        },
    },
]

TOOL_LABELS = {
    "get_recent_workouts": "Смотрю последние тренировки",
    "get_exercise_history": "Смотрю историю упражнения",
    "get_personal_records": "Смотрю рекорды",
    "get_weekly_summary": "Считаю недели",
    "get_cardio_history": "Смотрю кардио",
    "get_planned_workouts": "Смотрю план",
    "list_exercises": "Смотрю справочник упражнений",
    "propose_workout": "Составляю тренировку",
}


def e1rm(weight: float, reps: int) -> float:
    if reps <= 0 or weight <= 0:
        return 0.0
    return float(weight) if reps == 1 else weight * (1 + reps / 30)


def _norm(s: str) -> str:
    return s.lower().replace("ё", "е").strip()


def _matches(query: str, name: str) -> bool:
    """Все слова запроса должны встречаться в названии: «жим лёжа» находит «Жим штанги лёжа»."""
    tokens = _norm(query).split()
    n = _norm(name)
    return bool(tokens) and all(t in n for t in tokens)


def _clamp(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _fmt_w(w: float) -> str:
    return str(int(w)) if float(w).is_integer() else f"{w:g}"


class DataAccess:
    def __init__(self, conn: sqlite3.Connection, today: str):
        self.today = date.fromisoformat(today)
        self.exercises: dict[str, dict[str, Any]] = {}
        self.workouts: list[dict[str, Any]] = []
        for r in conn.execute("SELECT table_name, data FROM entities WHERE deleted = 0 AND table_name IN ('exercises','workouts')"):
            d = json.loads(r["data"])
            if not isinstance(d, dict) or not isinstance(d.get("id"), str):
                continue  # запись пришла с устройства и может быть любой формы
            if r["table_name"] == "exercises":
                self.exercises[d["id"]] = d
            elif isinstance(d.get("date"), str) and isinstance(d.get("exercises", []), list):
                self.workouts.append(d)
        self.workouts.sort(key=lambda w: (w.get("date", ""), w.get("startedAt") or 0))

    def _name(self, ex_id: str) -> str:
        return self.exercises.get(ex_id, {}).get("name", "Неизвестное упражнение")

    def _done(self) -> list[dict[str, Any]]:
        return [w for w in self.workouts if w.get("status") == "done"]

    @staticmethod
    def _sets(we: dict[str, Any]) -> list[dict[str, Any]]:
        return [s for s in we.get("sets", []) if s.get("done")]

    @staticmethod
    def _superset_labels(w: dict[str, Any]) -> list[str | None]:
        """Подписи суперсетов A1, A2, B1…: связка — это подряд идущие упражнения с одинаковым group."""
        exs = [e if isinstance(e, dict) else {} for e in w.get("exercises", []) if isinstance(e, (dict, str))]
        labels: list[str | None] = [None] * len(exs)
        letter, i = 0, 0
        while i < len(exs):
            g, j = exs[i].get("group"), i + 1
            if g:
                while j < len(exs) and exs[j].get("group") == g:
                    j += 1
            if g and j - i >= 2:
                ch = chr(65 + letter % 26)
                letter += 1
                for k in range(i, j):
                    labels[k] = f"{ch}{k - i + 1}"
            i = j
        return labels

    @staticmethod
    def _set_text(s: dict[str, Any]) -> str:
        kind = {"drop": " (дроп-сет)", "restpause": " (rest-pause)"}.get(s.get("kind"), "")
        return f"{_fmt_w(s['weight'])}x{s['reps']}{kind}"

    @staticmethod
    def _cardio(we: dict[str, Any]) -> tuple[float, float, float] | None:
        """(км, секунды, набор высоты в метрах) или None, если у упражнения нет результата кардио."""
        c = we.get("cardio")
        if not isinstance(c, dict):
            return None
        d, t, e = c.get("distanceM"), c.get("durationSec"), c.get("elevGainM") or 0
        if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (d, t, e)) or d <= 0 or t <= 0:
            return None
        return d / 1000, float(t), float(e)

    def _cardio_item(self, we: dict[str, Any], r: tuple[float, float, float]) -> dict[str, Any]:
        km, sec, elev = r
        ex = self.exercises.get(we.get("exerciseId", ""), {})
        item: dict[str, Any] = {"name": self._name(we.get("exerciseId", "")), "distance_km": round(km, 2), "time_min": round(sec / 60, 1)}
        if "вело" in _norm(str(ex.get("name", ""))):
            item["avg_speed_kmh"] = round(km / (sec / 3600), 1)
        else:
            pace = sec / km
            item["avg_pace_min_per_km"] = f"{int(pace // 60)}:{int(round(pace % 60)) % 60:02d}"
        if elev >= 1:
            item["elevation_gain_m"] = round(elev)
        return item

    def _volume(self, w: dict[str, Any]) -> float:
        return sum(s["weight"] * s["reps"] for we in w.get("exercises", []) for s in self._sets(we))

    # ----- инструменты -----
    def get_recent_workouts(self, days: Any = 30, limit: Any = 10) -> dict[str, Any]:
        days, limit = _clamp(days, 1, 365, 30), _clamp(limit, 1, 30, 10)
        since = (self.today - timedelta(days=days)).isoformat()
        out = []
        for w in reversed(self._done()):
            if w["date"] < since:
                break
            exs = []
            labels = self._superset_labels(w)
            for n, we in enumerate(w.get("exercises", [])):
                sets = self._sets(we)
                if sets:
                    item_ex: dict[str, Any] = {"name": self._name(we["exerciseId"]), "sets": [self._set_text(s) for s in sets]}
                    if n < len(labels) and labels[n]:
                        item_ex["superset"] = labels[n]
                    exs.append(item_ex)
                elif (cr := self._cardio(we)):
                    exs.append(self._cardio_item(we, cr))
            item: dict[str, Any] = {"date": w["date"], "title": w.get("title", ""), "volume_kg": round(self._volume(w)), "exercises": exs}
            if w.get("startedAt") and w.get("finishedAt"):
                item["duration_min"] = round((w["finishedAt"] - w["startedAt"]) / 60000)
            if w.get("note"):
                item["note"] = str(w["note"])[:300]
            out.append(item)
            if len(out) >= limit:
                break
        return {"workouts": out, "count": len(out)}

    def get_exercise_history(self, exercise: Any = "", limit: Any = 8) -> dict[str, Any]:
        q, limit = _norm(str(exercise)), _clamp(limit, 1, 30, 8)
        ids = [i for i, e in self.exercises.items() if _matches(q, e.get("name", ""))][:3]
        if not ids:  # запасной вариант: подходит любое длинное слово из запроса
            long_words = [t for t in q.split() if len(t) >= 4]
            ids = [i for i, e in self.exercises.items() if any(t in _norm(e.get("name", "")) for t in long_words)][:3]
        if not ids:
            names = sorted(e.get("name", "") for e in self.exercises.values())
            return {"error": "Упражнение не найдено", "available_examples": names[:15]}
        result = []
        for ex_id in ids:
            sessions = []
            for w in reversed(self._done()):
                for we in w.get("exercises", []):
                    sets = self._sets(we)
                    if we["exerciseId"] == ex_id and sets:
                        best = max(e1rm(s["weight"], s["reps"]) for s in sets)
                        sessions.append({"date": w["date"], "sets": [f"{_fmt_w(s['weight'])}x{s['reps']}" for s in sets], "best_e1rm": round(best, 1)})
                if len(sessions) >= limit:
                    break
            result.append({"exercise": self._name(ex_id), "sessions": sessions})
        return {"results": result}

    def get_personal_records(self, limit: Any = 15) -> dict[str, Any]:
        limit = _clamp(limit, 1, 40, 15)
        best: dict[str, dict[str, Any]] = {}
        for w in self._done():
            for we in w.get("exercises", []):
                for s in self._sets(we):
                    v = e1rm(s["weight"], s["reps"])
                    cur = best.get(we["exerciseId"])
                    if v > 0 and (not cur or v > cur["e1rm"]):
                        best[we["exerciseId"]] = {"e1rm": v, "set": f"{_fmt_w(s['weight'])}x{s['reps']}", "date": w["date"]}
        rows = sorted(best.items(), key=lambda kv: kv[1]["date"], reverse=True)[:limit]
        return {"records": [{"exercise": self._name(i), "best_e1rm": round(r["e1rm"], 1), "set": r["set"], "date": r["date"]} for i, r in rows]}

    def get_weekly_summary(self, weeks: Any = 8) -> dict[str, Any]:
        weeks = _clamp(weeks, 1, 26, 8)
        monday = self.today - timedelta(days=self.today.weekday())
        out = []
        for i in range(weeks - 1, -1, -1):
            start = monday - timedelta(days=7 * i)
            end = start + timedelta(days=7)
            ws = [w for w in self._done() if start.isoformat() <= w["date"] < end.isoformat()]
            out.append({
                "week_start": start.isoformat(),
                "workouts": len(ws),
                "sets": sum(len(self._sets(we)) for w in ws for we in w.get("exercises", [])),
                "volume_kg": round(sum(self._volume(w) for w in ws)),
            })
        return {"weeks": out}

    def get_cardio_history(self, days: Any = 30, limit: Any = 15) -> dict[str, Any]:
        days, limit = _clamp(days, 1, 365, 30), _clamp(limit, 1, 60, 15)
        since = (self.today - timedelta(days=days)).isoformat()
        rows, total_km, total_sec, runs_km, runs_sec = [], 0.0, 0.0, 0.0, 0.0
        for w in reversed(self._done()):
            if w["date"] < since:
                break
            for we in w.get("exercises", []):
                r = self._cardio(we)
                if not r:
                    continue
                total_km += r[0]; total_sec += r[1]
                if "вело" not in _norm(str(self.exercises.get(we.get("exerciseId", ""), {}).get("name", ""))):
                    runs_km += r[0]; runs_sec += r[1]
                if len(rows) < limit:
                    rows.append({"date": w["date"], **self._cardio_item(we, r)})
        out: dict[str, Any] = {"sessions": rows, "total_distance_km": round(total_km, 1), "total_time_h": round(total_sec / 3600, 1)}
        if runs_km > 0:
            pace = runs_sec / runs_km
            out["avg_pace_run_walk_min_per_km"] = f"{int(pace // 60)}:{int(round(pace % 60)) % 60:02d}"
        return out

    def get_planned_workouts(self) -> dict[str, Any]:
        since = (self.today - timedelta(days=1)).isoformat()
        out = []
        for w in self.workouts:
            if w.get("status") in ("planned", "active") and w["date"] >= since:
                out.append({
                    "date": w["date"], "title": w.get("title", ""), "status": w["status"],
                    "exercises": [f"{self._name(we['exerciseId'])}: " + ("кардио" if self.exercises.get(we.get("exerciseId", ""), {}).get("muscle") == "cardio" else f"{len(we.get('sets', []))} подх.") for we in w.get("exercises", [])],
                })
        return {"planned": out[:20]}

    def list_exercises(self, query: Any = "", muscle: Any = "") -> dict[str, Any]:
        q = _norm(str(query or ""))
        rows = [
            {"name": e.get("name"), "muscle": e.get("muscle"), "equipment": e.get("equipment")}
            for e in self.exercises.values()
            if (not q or _matches(q, e.get("name", ""))) and (not muscle or e.get("muscle") == muscle)
        ]
        rows.sort(key=lambda r: str(r["name"]))
        return {"exercises": rows[:60], "total": len(rows)}

    def execute(self, name: str, args: dict[str, Any]) -> str:
        fn = getattr(self, name, None)
        if name not in TOOL_LABELS or name == "propose_workout" or fn is None:
            return json.dumps({"error": f"Неизвестный инструмент: {name}"}, ensure_ascii=False)
        try:
            allowed = set(inspect.signature(fn).parameters)
            text = json.dumps(fn(**{k: v for k, v in (args or {}).items() if k in allowed}), ensure_ascii=False)
        except Exception as e:  # ошибка инструмента не должна обрывать диалог
            return json.dumps({"error": f"Не удалось выполнить: {e}"}, ensure_ascii=False)
        return text[:12000]


def validate_proposal(args: dict[str, Any], today: str) -> tuple[dict[str, Any] | None, str]:
    """Проверяет предложение тренировки от модели. Возвращает (предложение, ошибка)."""
    try:
        day = date.fromisoformat(str(args.get("date", "")))
    except ValueError:
        return None, "Некорректная дата: нужен формат YYYY-MM-DD"
    if day < date.fromisoformat(today) - timedelta(days=1) or day > date.fromisoformat(today) + timedelta(days=365):
        return None, "Дата вне разумного диапазона"
    raw = args.get("exercises")
    if not isinstance(raw, list) or not raw:
        return None, "Нужно хотя бы одно упражнение"
    exs = []
    for e in raw[:12]:
        if not isinstance(e, dict) or not str(e.get("name", "")).strip():
            return None, "У каждого упражнения должно быть название"
        item: dict[str, Any] = {
            "name": str(e["name"]).strip()[:80],
            "sets": _clamp(e.get("sets"), 1, 10, 3),
            "reps": _clamp(e.get("reps"), 1, 50, 10),
        }
        try:
            w = float(e["weight_kg"]) if e.get("weight_kg") is not None else None
        except (TypeError, ValueError):
            w = None
        if w is not None and 0 <= w <= 500:
            item["weight"] = round(w * 4) / 4
        if e.get("muscle") in MUSCLES:
            item["muscle"] = e["muscle"]
        exs.append(item)
    return {"date": day.isoformat(), "title": (str(args.get("title", "")).strip() or "Тренировка")[:80], "exercises": exs}, ""
