"""Sekventiell jobbkö — en arbetare (DS620slims J3355 ska inte köra
parallella ffmpeg-jobb). Varje jobb körs som subprocess setuid:ad till
profilägarens uid/gid så filerna blir rättägda från början."""
import collections
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

from . import db

HOMES_DIR = Path(os.environ.get("HOMES_DIR", "/homes"))


class Runner:
    def __init__(self):
        self.q: queue.Queue[int] = queue.Queue()
        self.lock = threading.Lock()
        self.current: tuple[int, subprocess.Popen] | None = None
        self.cancelled: set[int] = set()
        threading.Thread(target=self._loop, daemon=True).start()

    def enqueue(self, job_id: int):
        self.q.put(job_id)

    def cancel(self, job_id: int) -> bool:
        """Avbryt ett köat eller pågående jobb."""
        with self.lock:
            self.cancelled.add(job_id)
            if self.current and self.current[0] == job_id:
                try:
                    self.current[1].terminate()
                except OSError:
                    pass
                return True
        with db.connect() as c:
            row = c.execute("SELECT status FROM jobs WHERE id=?",
                            (job_id,)).fetchone()
            if row and row["status"] == "queued":
                c.execute("UPDATE jobs SET status='cancelled', "
                          "finished=datetime('now') WHERE id=?", (job_id,))
                c.execute("INSERT INTO job_log (job_id, level, msg) "
                          "VALUES (?,?,?)",
                          (job_id, "warn", "Hämtningen avbröts innan den "
                                           "hann starta."))
                return True
        return False

    def _loop(self):
        while True:
            job_id = self.q.get()
            try:
                self._exec(job_id)
            except Exception as exc:
                self._log(job_id, f"Internt fel i jobbköraren: {exc}", "error")
                self._finish(job_id, "error")

    def _log(self, job_id, msg, level="info"):
        with db.connect() as c:
            c.execute("INSERT INTO job_log (job_id, level, msg) VALUES (?,?,?)",
                      (job_id, level, msg))

    def _finish(self, job_id, status, new=None, skipped=None, failed=None):
        with db.connect() as c:
            c.execute(
                "UPDATE jobs SET status=?, new=?, skipped=?, failed=?, "
                "progress=NULL, finished=datetime('now') WHERE id=?",
                (status, new, skipped, failed, job_id))

    def _exec(self, job_id: int):
        with db.connect() as c:
            row = c.execute(
                "SELECT j.id, j.profile_id, p.url, p.folder, p.shanling, "
                "pr.home, pr.cookie_mode "
                "FROM jobs j JOIN playlists p ON p.id = j.playlist_id "
                "JOIN profiles pr ON pr.id = j.profile_id WHERE j.id=?",
                (job_id,)).fetchone()
            if not row:
                return
            status = c.execute("SELECT status FROM jobs WHERE id=?",
                               (job_id,)).fetchone()["status"]
            if status != "queued":
                return  # avbrutet innan det hann starta
            c.execute("UPDATE jobs SET status='running' WHERE id=?", (job_id,))

        home = HOMES_DIR / row["home"]
        if not home.is_dir():
            self._log(job_id, f"Hemkatalogen {row['home']} hittas inte.", "error")
            self._finish(job_id, "error")
            return
        st = home.stat()

        cookiefile = db.DATA_DIR / "cookies" / f"{row['profile_id']}.txt"
        payload = json.dumps({
            "home": str(home), "folder": row["folder"],
            "url": row["url"], "shanling": row["shanling"],
            "cookiefile": str(cookiefile) if cookiefile.exists() else None,
            "cookie_mode": row["cookie_mode"],
        })
        cmd = [sys.executable, "-m", "app.worker", "--job", payload]

        preexec = None
        if os.geteuid() == 0:
            uid, gid = st.st_uid, st.st_gid

            def preexec():
                os.setgid(gid)
                try:
                    os.setgroups([gid])
                except PermissionError:
                    pass
                os.setuid(uid)
                os.umask(0o022)
        else:
            self._log(job_id, "Utvecklingsläge: kör utan uid-byte.", "warn")

        env = {**os.environ,
               "HOME": "/tmp",
               "XDG_CACHE_HOME": f"/tmp/ymdl-cache-{st.st_uid}"}

        proc = subprocess.Popen(
            cmd, cwd="/srv" if Path("/srv/app").is_dir() else None,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env, preexec_fn=preexec)
        with self.lock:
            self.current = (job_id, proc)

        stderr_tail = collections.deque(maxlen=40)
        t = threading.Thread(
            target=lambda: stderr_tail.extend(iter(proc.stderr.readline, "")),
            daemon=True)
        t.start()

        done = None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                self._log(job_id, line)
                continue
            if ev.get("t") == "log":
                self._log(job_id, ev["msg"], ev.get("level", "info"))
            elif ev.get("t") == "pct":
                with db.connect() as c:
                    c.execute("UPDATE jobs SET progress=? WHERE id=?",
                              (ev["v"], job_id))
            elif ev.get("t") == "done":
                done = ev

        proc.wait()
        t.join(timeout=5)
        with self.lock:
            self.current = None
            was_cancelled = job_id in self.cancelled
            self.cancelled.discard(job_id)

        if was_cancelled:
            # Städa halvfärdiga filer — arkivet skrivs bara för kompletta
            # låtar, så en omkörning fortsätter exakt där den slutade.
            pdir = home / "Musik" / "Spelaren" / row["folder"]
            if pdir.is_dir():
                for leftover in list(pdir.glob(".part-*")) + \
                        list(pdir.glob(".ren-*")):
                    try:
                        leftover.unlink()
                    except OSError:
                        pass
            self._log(job_id, "Hämtningen avbröts på din begäran. Redan "
                              "hämtade låtar ligger kvar — 'Hämta nya "
                              "låtar' fortsätter där den slutade.", "warn")
            self._finish(job_id, "cancelled")
            return

        if done is not None and proc.returncode == 0:
            status = "done" if not done.get("failed") else \
                     ("done" if done.get("new") or done.get("skipped") else "error")
            self._finish(job_id, status, done.get("new", 0),
                         done.get("skipped", 0), done.get("failed", 0))
        else:
            tail = "".join(list(stderr_tail)[-8:]).strip()
            if tail:
                self._log(job_id, f"Arbetaren avbröts: {tail[-500:]}", "error")
            else:
                self._log(job_id, "Arbetaren avbröts oväntat.", "error")
            self._finish(job_id, "error")


runner = Runner()
