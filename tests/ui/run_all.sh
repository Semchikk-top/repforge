#!/usr/bin/env bash
# Все браузерные тесты: у каждого свой чистый сервер и своя папка данных (тесты не должны влиять друг на друга).
# Нужны: собранный клиент (npm run build) и Playwright (pip install playwright && playwright install chromium).
cd "$(dirname "$0")/../.." || exit 1
export PYTHONPATH=.
PORT=8767; FAKE=8790; fail=0

uvicorn tests.ui.fake_provider:app --port $FAKE >/dev/null 2>&1 & fake=$!
trap 'kill $fake 2>/dev/null' EXIT
sleep 1

run() { # имя_теста ключ_облака адрес_для_сервера
  local name=$1 key=$2 host=${3:-127.0.0.1} dir srv; dir=$(mktemp -d)
  WORKOUT_DATA_DIR=$dir ANTHROPIC_API_KEY=$key ASSISTANT_CLOUD_BASE_URL=http://127.0.0.1:$FAKE FISH_SPEECH_URL=http://127.0.0.1:$FAKE python -m server run --host "$host" --port $PORT >/dev/null 2>&1 & srv=$!
  sleep 3
  if BASE_URL=http://127.0.0.1:$PORT/ WORKOUT_DATA_DIR=$dir python -m tests.ui.$name > "/tmp/ui_$name.log" 2>&1; then echo "OK    $name"; else echo "FAIL  $name (лог: /tmp/ui_$name.log)"; fail=1; fi
  kill $srv 2>/dev/null; wait $srv 2>/dev/null; rm -rf "$dir"
}

run ui_test ""
run pairing_test "" 0.0.0.0
run assistant_test test
run connect_test ""
run tts_test ""
run cardio_test ""
run update_test ""
run alpha2_test ""
run alpha3_test ""
run today_test ""
run reorder_test ""
run why_test ""
run learn_test ""
run why_decision_test ""
run load_map_test ""
exit $fail
