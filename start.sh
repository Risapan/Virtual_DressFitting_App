#!/bin/zsh
# Start the fitting mirror. Open http://localhost:8790 (mirror) or /admin (collection).
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || ./setup.sh
PORT=${PORT:-8790}
(sleep 1.5; open "http://localhost:$PORT") &
exec .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port $PORT
