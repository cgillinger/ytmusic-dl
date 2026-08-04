import hashlib
import hmac
import json
import os
import subprocess
import sys
from importlib import metadata
from pathlib import Path
from shutil import which

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db
from .jobs import HOMES_DIR, runner
from .naming import sanitize

app = FastAPI(title="ytmusic-dl")

COOKIE = "ymdl_session"
EXCLUDED_HOMES = {"admin", "guest", "anonymous"} | {
    n.strip().lower()
    for n in os.environ.get("HOMES_EXCLUDE", "").split(",") if n.strip()
}
COLORS = ["#D93A2B", "#1E9E63", "#DE9A0C", "#3F5FB7", "#7A4DD8", "#C74E82"]


def _secret() -> bytes:
    path = db.DATA_DIR / "secret.key"
    if not path.exists():
        db.DATA_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(os.urandom(32))
        path.chmod(0o600)
    return path.read_bytes()


@app.on_event("startup")
def startup():
    db.init()
    if not which("ffmpeg"):
        print("VARNING: ffmpeg saknas — MP3-konvertering kommer att misslyckas",
              file=sys.stderr)


# ---------- sessioner ----------

def _sign(profile_id: int) -> str:
    mac = hmac.new(_secret(), str(profile_id).encode(), hashlib.sha256)
    return f"{profile_id}.{mac.hexdigest()}"


def _verify(token: str):
    try:
        pid, mac = token.split(".", 1)
        expect = hmac.new(_secret(), pid.encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(mac, expect):
            return int(pid)
    except (ValueError, AttributeError):
        pass
    return None


def current_profile(request: Request):
    token = request.cookies.get(COOKIE)
    pid = _verify(token) if token else None
    if pid is None:
        return None
    with db.connect() as c:
        return c.execute("SELECT * FROM profiles WHERE id=?", (pid,)).fetchone()


def require_profile(request: Request):
    profile = current_profile(request)
    if profile is None:
        raise HTTPException(401, "Ingen profil vald")
    return profile


def _set_session(response: Response, profile_id: int):
    response.set_cookie(COOKIE, _sign(profile_id), max_age=365 * 86400,
                        httponly=True, samesite="lax")


# ---------- lösenord (scrypt, aldrig klartext) ----------

def hash_pw(pw: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(pw.encode(), salt=salt, n=16384, r=8, p=1)
    return f"s${salt.hex()}${digest.hex()}"


def check_pw(pw: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt_hex),
                                n=16384, r=8, p=1)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, AttributeError):
        return False


# ---------- hemkataloger ----------

def list_home_names() -> list[str]:
    names = []
    try:
        entries = sorted(os.scandir(HOMES_DIR), key=lambda e: e.name.lower())
    except FileNotFoundError:
        return []
    for e in entries:
        if not e.is_dir(follow_symlinks=False):
            continue
        if e.name.startswith(("@", ".")) or e.name.lower() in EXCLUDED_HOMES:
            continue
        names.append(e.name)
    return names


# ---------- API-modeller ----------

class ProfileIn(BaseModel):
    home: str
    password: str = ""


class LoginIn(BaseModel):
    profile_id: int
    password: str = ""


class PlaylistIn(BaseModel):
    url: str
    name: str
    shanling: bool = True


class CookiesIn(BaseModel):
    content: str | None = None
    mode: str | None = None


# ---------- meta / state ----------

@app.get("/api/state")
def state(request: Request):
    profile = current_profile(request)
    try:
        ytdlp = metadata.version("yt-dlp")
    except metadata.PackageNotFoundError:
        ytdlp = None
    public = None
    cookies = None
    if profile:
        public = {k: profile[k] for k in ("id", "name", "color", "home")}
        cookies = {"uploaded": _cookie_path(profile["id"]).exists(),
                   "mode": profile["cookie_mode"]}
    return {
        "profile": public,
        "cookies": cookies,
        "ytdlp_version": ytdlp,
        "ffmpeg_ok": which("ffmpeg") is not None,
    }


@app.post("/api/update-ytdlp")
def update_ytdlp(profile=Depends(require_profile)):
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "--upgrade",
         "yt-dlp[default]"],
        capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise HTTPException(502, "Uppdateringen misslyckades — är NAS:en online?")
    return {"ytdlp_version": metadata.version("yt-dlp")}


# ---------- profiler ----------

@app.get("/api/homes")
def homes():
    with db.connect() as c:
        taken = {r["home"] for r in c.execute("SELECT home FROM profiles")}
    return [{"name": n, "taken": n in taken} for n in list_home_names()]


@app.get("/api/profiles")
def profiles():
    with db.connect() as c:
        rows = c.execute("SELECT id, name, color, pw_hash FROM profiles "
                         "ORDER BY name COLLATE NOCASE").fetchall()
    return [{"id": r["id"], "name": r["name"], "color": r["color"],
             "has_password": r["pw_hash"] is not None} for r in rows]


@app.post("/api/profiles")
def create_profile(body: ProfileIn, response: Response):
    if body.home not in list_home_names():
        raise HTTPException(400, "Det kontot finns inte på Synologyn.")
    if len(body.password) > 200:
        raise HTTPException(400, "För långt lösenord.")
    pw_hash = hash_pw(body.password) if body.password else None
    with db.connect() as c:
        exists = c.execute("SELECT 1 FROM profiles WHERE home=?",
                           (body.home,)).fetchone()
        if exists:
            raise HTTPException(409, f"{body.home} har redan en profil.")
        color = COLORS[sum(map(ord, body.home)) % len(COLORS)]
        cur = c.execute(
            "INSERT INTO profiles (home, name, pw_hash, color) VALUES (?,?,?,?)",
            (body.home, body.home, pw_hash, color))
        pid = cur.lastrowid
    _set_session(response, pid)
    return {"id": pid, "name": body.home}


@app.post("/api/login")
def login(body: LoginIn, response: Response):
    with db.connect() as c:
        row = c.execute("SELECT * FROM profiles WHERE id=?",
                        (body.profile_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Profilen finns inte.")
    if row["pw_hash"] is not None and not check_pw(body.password, row["pw_hash"]):
        raise HTTPException(403, "Fel lösenord.")
    _set_session(response, row["id"])
    return {"id": row["id"], "name": row["name"]}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


# ---------- YouTube-konto (cookies) ----------

def _cookie_path(profile_id: int) -> Path:
    return db.DATA_DIR / "cookies" / f"{profile_id}.txt"


@app.post("/api/cookies")
def set_cookies(body: CookiesIn, profile=Depends(require_profile)):
    if body.content is not None:
        content = body.content.strip()
        data_lines = [l for l in content.splitlines()
                      if l.strip() and not l.startswith("#")]
        if not any("youtube.com" in l and "\t" in l for l in data_lines):
            raise HTTPException(
                400, "Det där ser inte ut som en cookies.txt-fil från "
                     "youtube.com — exportera med tillägget "
                     "\"Get cookies.txt LOCALLY\" och försök igen.")
        path = _cookie_path(profile["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content + "\n", encoding="utf-8")
        path.chmod(0o600)
        try:
            # Ägs av profilägaren — arbetarprocessen (setuid) måste kunna
            # läsa filen och skriva tillbaka roterade cookies.
            st = os.stat(HOMES_DIR / profile["home"])
            os.chown(path, st.st_uid, st.st_gid)
        except (PermissionError, FileNotFoundError):
            pass  # utvecklingsläge utan root
    if body.mode is not None:
        if body.mode not in ("fallback", "always"):
            raise HTTPException(400, "Ogiltigt läge.")
        with db.connect() as c:
            c.execute("UPDATE profiles SET cookie_mode=? WHERE id=?",
                      (body.mode, profile["id"]))
    with db.connect() as c:
        mode = c.execute("SELECT cookie_mode FROM profiles WHERE id=?",
                         (profile["id"],)).fetchone()["cookie_mode"]
    return {"uploaded": _cookie_path(profile["id"]).exists(), "mode": mode}


@app.delete("/api/cookies")
def delete_cookies(profile=Depends(require_profile)):
    _cookie_path(profile["id"]).unlink(missing_ok=True)
    return {"uploaded": False, "mode": profile["cookie_mode"]}


# ---------- spellistor ----------

def _playlist_or_404(c, playlist_id: int, profile_id: int):
    row = c.execute("SELECT * FROM playlists WHERE id=? AND profile_id=?",
                    (playlist_id, profile_id)).fetchone()
    if not row:
        raise HTTPException(404, "Spellistan finns inte.")
    return row


def _start_job(playlist_id: int, profile_id: int) -> int:
    with db.connect() as c:
        busy = c.execute(
            "SELECT 1 FROM jobs WHERE playlist_id=? AND status IN "
            "('queued','running')", (playlist_id,)).fetchone()
        if busy:
            raise HTTPException(409, "En hämtning pågår redan för spellistan.")
        cur = c.execute(
            "INSERT INTO jobs (playlist_id, profile_id) VALUES (?,?)",
            (playlist_id, profile_id))
        job_id = cur.lastrowid
    runner.enqueue(job_id)
    return job_id


@app.get("/api/playlists")
def playlists(profile=Depends(require_profile)):
    with db.connect() as c:
        rows = c.execute(
            "SELECT p.*, "
            " (SELECT id FROM jobs j WHERE j.playlist_id=p.id AND j.status IN "
            "  ('queued','running') ORDER BY j.id DESC LIMIT 1) AS active_job, "
            " (SELECT json_object('status', status, 'new', new, 'skipped', "
            "   skipped, 'failed', failed, 'finished', finished) FROM jobs j "
            "  WHERE j.playlist_id=p.id AND j.status IN "
            "  ('done','error','cancelled') "
            "  ORDER BY j.id DESC LIMIT 1) AS last_job "
            "FROM playlists p WHERE p.profile_id=? ORDER BY p.created DESC",
            (profile["id"],)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["last_job"] = json.loads(d["last_job"]) if d["last_job"] else None
        out.append(d)
    return out


@app.post("/api/playlists")
def create_playlist(body: PlaylistIn, profile=Depends(require_profile)):
    url = body.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "Det där ser inte ut som en länk.")
    folder = sanitize(body.name)
    with db.connect() as c:
        exists = c.execute(
            "SELECT 1 FROM playlists WHERE profile_id=? AND folder=?",
            (profile["id"], folder)).fetchone()
        if exists:
            raise HTTPException(
                409, "Du har redan en spellista med det namnet — "
                     "använd 'Hämta nya låtar' på den istället.")
        cur = c.execute(
            "INSERT INTO playlists (profile_id, name, folder, url, shanling) "
            "VALUES (?,?,?,?,?)",
            (profile["id"], body.name.strip() or folder, folder, url,
             int(body.shanling)))
        playlist_id = cur.lastrowid
    job_id = _start_job(playlist_id, profile["id"])
    return {"playlist_id": playlist_id, "job_id": job_id}


@app.post("/api/playlists/{playlist_id}/fetch")
def fetch_playlist(playlist_id: int, profile=Depends(require_profile)):
    with db.connect() as c:
        _playlist_or_404(c, playlist_id, profile["id"])
    return {"job_id": _start_job(playlist_id, profile["id"])}


@app.delete("/api/playlists/{playlist_id}")
def delete_playlist(playlist_id: int, profile=Depends(require_profile)):
    with db.connect() as c:
        _playlist_or_404(c, playlist_id, profile["id"])
        c.execute("DELETE FROM playlists WHERE id=?", (playlist_id,))
    return {"ok": True}  # endast ur listan — filerna i hemkatalogen rörs inte


@app.get("/api/playlist-info")
def playlist_info(url: str, profile=Depends(require_profile)):
    cmd = [sys.executable, "-m", "app.worker", "--probe", url]
    ck = _cookie_path(profile["id"])
    if ck.exists():
        cmd += ["--cookies", str(ck)]
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=120,
        env={**os.environ, "XDG_CACHE_HOME": "/tmp/ymdl-cache-probe"})
    error_msg = None
    for line in result.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("t") == "probe":
            return {"title": ev["title"], "count": ev["count"]}
        if ev.get("t") == "log" and ev.get("level") == "error":
            error_msg = ev["msg"]
    raise HTTPException(
        400, error_msg or "Kunde inte läsa spellistan — kontrollera länken.")


# ---------- jobb ----------

@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: int, profile=Depends(require_profile)):
    with db.connect() as c:
        job = c.execute("SELECT status FROM jobs WHERE id=? AND profile_id=?",
                        (job_id, profile["id"])).fetchone()
    if not job:
        raise HTTPException(404, "Jobbet finns inte.")
    if job["status"] not in ("queued", "running"):
        raise HTTPException(409, "Jobbet är redan klart.")
    runner.cancel(job_id)
    return {"ok": True}


@app.get("/api/jobs/active")
def active_job(profile=Depends(require_profile)):
    with db.connect() as c:
        row = c.execute(
            "SELECT id FROM jobs WHERE profile_id=? AND status IN "
            "('queued','running') ORDER BY id DESC LIMIT 1",
            (profile["id"],)).fetchone()
    return {"job_id": row["id"] if row else None}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: int, after: int = 0, profile=Depends(require_profile)):
    with db.connect() as c:
        job = c.execute("SELECT * FROM jobs WHERE id=? AND profile_id=?",
                        (job_id, profile["id"])).fetchone()
        if not job:
            raise HTTPException(404, "Jobbet finns inte.")
        playlist = c.execute("SELECT name, folder, shanling FROM playlists "
                             "WHERE id=?", (job["playlist_id"],)).fetchone()
        log = c.execute(
            "SELECT id, level, msg FROM job_log WHERE job_id=? AND id>? "
            "ORDER BY id", (job_id, after)).fetchall()
    return {
        "id": job["id"], "status": job["status"], "progress": job["progress"],
        "new": job["new"], "skipped": job["skipped"], "failed": job["failed"],
        "playlist": dict(playlist) if playlist else None,
        "log": [dict(r) for r in log],
    }


# ---------- filer (för "Kopiera till mp3-spelare"-synken) ----------

def _safe_name(name: str) -> str:
    if "/" in name or "\\" in name or name.startswith(".") or ".." in name:
        raise HTTPException(400, "Ogiltigt filnamn.")
    return name


@app.get("/api/playlists/{playlist_id}/files")
def playlist_files(playlist_id: int, profile=Depends(require_profile)):
    with db.connect() as c:
        pl = _playlist_or_404(c, playlist_id, profile["id"])
    base = HOMES_DIR / profile["home"] / "Musik" / "Spelaren"
    pdir = base / pl["folder"]
    if not pdir.is_dir():
        return {"folder": pl["folder"], "files": [], "m3u": None}
    files = sorted(f.name for f in pdir.iterdir()
                   if f.is_file() and f.suffix == ".mp3"
                   and not f.name.startswith("."))
    m3u = None
    m3u_path = base / "_explaylist_data" / f"{pl['folder']}.m3u"
    if pl["shanling"] and m3u_path.exists():
        m3u = {"name": m3u_path.name,
               "content": m3u_path.read_text(encoding="utf-8")}
    return {"folder": pl["folder"], "files": files, "m3u": m3u}


@app.get("/api/playlists/{playlist_id}/file/{name}")
def playlist_file(playlist_id: int, name: str,
                  profile=Depends(require_profile)):
    _safe_name(name)
    with db.connect() as c:
        pl = _playlist_or_404(c, playlist_id, profile["id"])
    path = HOMES_DIR / profile["home"] / "Musik" / "Spelaren" / pl["folder"] / name
    if not path.is_file() or path.suffix != ".mp3":
        raise HTTPException(404, "Filen finns inte.")
    return FileResponse(path, media_type="audio/mpeg", filename=name)


# ---------- statiska filer (frontend) ----------

app.mount("/", StaticFiles(directory=Path(__file__).parent / "static",
                           html=True), name="static")
