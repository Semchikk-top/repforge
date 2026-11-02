#!/usr/bin/env bash
# Установка на ПК (Omarchy / Arch). Запускать из папки проекта: bash deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Нужен Node.js: sudo pacman -S nodejs npm"; exit 1; }
command -v python3 >/dev/null || { echo "Нужен Python 3: sudo pacman -S python"; exit 1; }

echo "→ сборка клиента"
npm ci
npm run build

echo "→ окружение сервера"
python3 -m venv .venv
.venv/bin/pip install -q -r server/requirements.txt

echo "→ настройки ассистента"
mkdir -p ~/workout-data && chmod 700 ~/workout-data
[ -f ~/workout-data/.env ] || { cp deploy/env.example ~/workout-data/.env; chmod 600 ~/workout-data/.env; }

echo "→ сервис systemd"
mkdir -p ~/.config/systemd/user
esc=$(printf '%s' "$PWD" | sed -e 's/[\\&|]/\\&/g')
sed "s|%h/workout-app|$esc|g" deploy/workout.service > ~/.config/systemd/user/workout.service
systemctl --user daemon-reload
systemctl --user enable workout
# restart, а не только start: при обновлении сервис уже запущен и иначе продолжил бы работать на старом коде
systemctl --user restart workout
loginctl enable-linger "$USER" || true

cat << MSG

Готово. Сервер слушает 127.0.0.1:8000.

Дальше:
  1) Открой сервер по HTTPS через Tailscale:   sudo tailscale serve --bg 8000
     (адрес будет вида https://<имя-пк>.<tailnet>.ts.net — см. 'tailscale serve status')
  2) Подключи этот ПК: открой в браузере на нём ссылку ниже.
  3) Подключи телефон: в приложении на ПК Настройки → Синхронизация → «Подключить телефон рядом»
     и отсканируй QR-код камерой телефона.
MSG
echo "Ссылка для этого ПК:"
WORKOUT_DATA_DIR=~/workout-data .venv/bin/python -m server pair --url http://127.0.0.1:8000 | grep -E "Ссылка|Код подключения"
