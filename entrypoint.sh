#!/bin/sh
# yt-dlp åldras snabbt mot YouTube — uppdatera best-effort vid varje start.
pip install -q --upgrade yt-dlp \
    || echo "yt-dlp kunde inte uppdateras (offline?) — fortsätter med inbyggd version"

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8201}"
