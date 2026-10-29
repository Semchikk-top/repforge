"""Тестовая среда не должна трогать живую базу приложения.

`server.db` читает WORKOUT_DATA_DIR при импорте, а `server.main` создаёт приложение
(и соединение с SQLite) прямо на уровне модуля. Поэтому каталог подменяем до того,
как тестовые модули импортируют server.main.
"""
import os
import shutil
import tempfile

_TEST_DATA = tempfile.mkdtemp(prefix="workout-tests-")
os.environ["WORKOUT_DATA_DIR"] = _TEST_DATA


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TEST_DATA, ignore_errors=True)
