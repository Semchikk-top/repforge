#!/usr/bin/env bash
# Комната «Рядом» и друзья: нужна отдельная сборка клиента с адресом релея и сервер с тем же адресом в CSP.
# Релей каждый тест поднимает сам (node relay/src/index.js). Нужны: npm install в корне и в relay/.
cd "$(dirname "$0")/../.." || exit 1
export PYTHONPATH=.
PORT=8767; RELAY=8791; fail=0
DIST=$(mktemp -d)
VITE_ROOM_RELAY_URL=ws://127.0.0.1:$RELAY npx vite build --outDir "$DIST" >/dev/null 2>&1 || { echo "FAIL  сборка клиента"; exit 1; }

for name in room_test friends_test; do
  dir=$(mktemp -d)
  WORKOUT_DATA_DIR=$dir WORKOUT_DIST_DIR=$DIST WORKOUT_ROOM_RELAY_URL=ws://127.0.0.1:$RELAY python -m server run --host 127.0.0.1 --port $PORT >/dev/null 2>&1 & srv=$!
  sleep 3
  if BASE_URL=http://127.0.0.1:$PORT/ RELAY_PORT=$RELAY python -m tests.ui.$name > "/tmp/ui_$name.log" 2>&1; then echo "OK    $name"; else echo "FAIL  $name (лог: /tmp/ui_$name.log)"; fail=1; fi
  kill $srv 2>/dev/null; wait $srv 2>/dev/null; rm -rf "$dir"
done
rm -rf "$DIST"
exit $fail
