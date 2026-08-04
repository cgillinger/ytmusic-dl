import os
import sqlite3
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "app.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY,
    home TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pw_hash TEXT,
    color TEXT NOT NULL,
    cookie_mode TEXT NOT NULL DEFAULT 'fallback',
    created TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    folder TEXT NOT NULL,
    url TEXT NOT NULL,
    shanling INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (profile_id, folder)
);
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|error
    progress INTEGER,                        -- procent för aktuell låt
    new INTEGER, skipped INTEGER, failed INTEGER,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    finished TEXT
);
CREATE TABLE IF NOT EXISTS job_log (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'info',
    msg TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_log ON job_log(job_id, id);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init() -> None:
    with connect() as c:
        c.executescript(SCHEMA)
        cols = [r["name"] for r in c.execute("PRAGMA table_info(profiles)")]
        if "cookie_mode" not in cols:
            c.execute("ALTER TABLE profiles ADD COLUMN cookie_mode TEXT "
                      "NOT NULL DEFAULT 'fallback'")
        # Jobb som var igång vid en omstart kan inte återupptas — men
        # förklara varför i loggen, annars ser det ut som ett gåtfullt fel.
        orphans = c.execute("SELECT id FROM jobs "
                            "WHERE status IN ('queued','running')").fetchall()
        for o in orphans:
            c.execute("UPDATE jobs SET status='error', "
                      "finished=datetime('now') WHERE id=?", (o["id"],))
            c.execute(
                "INSERT INTO job_log (job_id, level, msg) VALUES (?,?,?)",
                (o["id"], "warn",
                 "Hämtningen avbröts av att tjänsten startades om. Klicka "
                 "'Hämta nya låtar' så fortsätter den där den slutade — "
                 "det som redan hämtats hämtas inte om."))
