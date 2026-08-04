"""Nedladdningsarbetare.

Körs alltid som separat subprocess — i produktion setuid:ad till profilägaren
av jobbköraren, så att alla filer blir rättägda från början. Kommunicerar med
föräldern via JSON-rader på stdout:

    {"t": "log", "level": "info|warn|error", "msg": "..."}
    {"t": "pct", "v": 42}
    {"t": "probe", "title": "...", "count": 12}
    {"t": "done", "new": 2, "skipped": 20, "failed": 0}

yt-dlp importeras här (inte i huvudprocessen) så att en pip-uppgradering av
yt-dlp gäller från och med nästa jobb utan omstart av containern.
"""
import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

from .naming import sanitize

NUMBERED = re.compile(r"^(\d{3}) - .*\.mp3$")


def emit(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def log(msg, level="info"):
    emit(t="log", level=level, msg=msg)


def short_error(exc) -> str:
    msg = str(exc)
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)          # färgkoder
    msg = msg.replace("ERROR: ", "").strip()
    if "Sign in to confirm" in msg:
        return ("YouTube kräver inloggning från den här adressen "
                "(bot-kontroll). Prova igen senare — händer det ofta, "
                "se README om cookie-import.")
    if "403" in msg and "Forbidden" in msg:
        return ("YouTube nekar åtkomst till spellistan (403). Är det din egen "
                "lista är den troligen Privat — öppna den i YouTube Music, "
                "välj ⋮ → Redigera spellista och ändra sekretess till "
                "Olistad. Lugn, Olistad är nästan lika privat: listan syns "
                "inte offentligt och kan bara ses av den som har länken. "
                "Prova sedan igen.")
    return msg[:300]


def flat_entries(url, cookiefile=None):
    import yt_dlp
    opts = {"quiet": True, "no_warnings": True, "extract_flat": "in_playlist",
            "skip_download": True}
    if cookiefile:
        opts["cookiefile"] = cookiefile
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    entries = info.get("entries")
    if entries is None:
        entries = [info]  # enstaka video → spellista med 1 låt
    else:
        entries = [e for e in entries if e]
    return info.get("title") or "Spellista", entries


def probe(url, cookiefile=None):
    try:
        title, entries = flat_entries(url)
    except Exception as exc:
        if not cookiefile:
            log(short_error(exc), "error")
            sys.exit(1)
        try:
            title, entries = flat_entries(url, cookiefile)
        except Exception as exc2:
            log(short_error(exc2), "error")
            sys.exit(1)
    emit(t="probe", title=title, count=len(entries))


def read_archive(path: Path):
    ids = set()
    if path.exists():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = line.split()
            if parts:
                ids.add(parts[-1])
    return ids


def next_number(pdir: Path) -> int:
    highest = 0
    for f in pdir.iterdir():
        m = NUMBERED.match(f.name)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest + 1


def pick_artist(info) -> str:
    artist = info.get("artist") or ", ".join(info.get("artists") or [])
    if not artist:
        uploader = info.get("uploader") or info.get("channel") or ""
        artist = re.sub(r"\s*-\s*Topic$", "", uploader)
    return artist or "Okänd artist"


BAD_WORDS = ("live", "cover", "reaction", "remix", "sped", "slowed", "8d",
             "karaoke", "instrumental", "concert", "session", "acoustic")


def is_unavailable(exc) -> bool:
    """Sant endast för borttagna/otillgängliga videor — INTE för formatfel
    ("Requested format is not available"), som annars falsktriggar
    ersättningssökningen."""
    msg = str(exc).lower()
    if "format is not available" in msg:
        return False
    return ("video unavailable" in msg or "not available" in msg
            or "no longer available" in msg or "has been removed" in msg
            or "private video" in msg)


def rescue_search(artist, title, expected_dur):
    """Originalet är borttaget — leta upp en annan utgåva av samma låt.
    Samma sak som YouTube Music-appen gör tyst när den spelar upp."""
    query = f"{artist} {title}".strip()
    if not query:
        return None
    try:
        _, results = flat_entries(f"ytsearch6:{query}")
    except Exception:
        return None
    orig_title = (title or "").lower()
    best, best_score = None, 0
    for r in results:
        if not r.get("id"):
            continue
        t = (r.get("title") or "").lower()
        ch = (r.get("channel") or r.get("uploader") or "").lower()
        dur = r.get("duration")
        score = 10.0
        if expected_dur and dur:
            diff = abs(dur - expected_dur)
            if diff > max(25, expected_dur * 0.25):
                continue  # fel längd → annan version (live/förlängd etc.)
            score -= diff / 3
        if "official audio" in t:
            score += 30
        elif "audio" in t:
            score += 12
        if "lyric" in t:
            score += 8
        if artist and artist.lower() in ch:
            score += 20
        if ch.endswith("- topic"):
            score += 15
        if any(w in t and w not in orig_title for w in BAD_WORDS):
            score -= 40
        if score > best_score:
            best, best_score = r, score
    return best


def fetch_original_cover(entry, dest_dir: Path):
    """Originalpostens omslag (kvadratisk albumkonst hos YT Music) — finns
    ofta kvar på bildservern även när själva videon är borttagen."""
    import urllib.request
    urls = []
    thumbs = sorted(entry.get("thumbnails") or [],
                    key=lambda t: t.get("width") or 0, reverse=True)
    for t in thumbs:
        u = t.get("url")
        if not u:
            continue
        if "googleusercontent" in u:
            # YT Musics albumkonst-URL:er bär storleken som suffix —
            # skriv upp till spelarvänlig storlek.
            u = re.sub(r"=w\d+-h\d+.*$", "=w544-h544-l90-rj", u)
        urls.append(u)
    vid = entry.get("id")
    if vid:
        urls += [f"https://i.ytimg.com/vi/{vid}/maxresdefault.jpg",
                 f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"]
    fallback = None
    for url in urls[:6]:
        try:
            req = urllib.request.Request(url,
                                         headers={"User-Agent": "Mozilla/5.0"})
            data = urllib.request.urlopen(req, timeout=15).read()
        except Exception:
            continue
        if len(data) >= 10000:  # småbilder (60 px) är bara ett par KB
            raw = dest_dir / ".cover-raw"
            raw.write_bytes(data)
            return raw
        if len(data) > 2000 and fallback is None:
            fallback = data
    if fallback:
        raw = dest_dir / ".cover-raw"
        raw.write_bytes(fallback)
        return raw
    return None


def replace_cover(mp3_path: Path, raw_path: Path) -> bool:
    import subprocess
    jpg = raw_path.with_suffix(".jpg")
    result = subprocess.run(
        ["ffmpeg", "-y", "-v", "quiet", "-i", str(raw_path),
         "-vf", "crop='min(iw,ih)':'min(iw,ih)'", "-frames:v", "1", str(jpg)])
    raw_path.unlink(missing_ok=True)
    if result.returncode != 0 or not jpg.exists():
        return False
    try:
        from mutagen.id3 import APIC, ID3
        id3 = ID3(mp3_path)
        id3.delall("APIC")
        id3.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover",
                     data=jpg.read_bytes()))
        id3.save(mp3_path)
        return True
    except Exception:
        return False
    finally:
        jpg.unlink(missing_ok=True)


def cleanup_parts(pdir: Path, vid: str):
    for p in pdir.glob(f".part-{vid}*"):
        try:
            p.unlink()
        except OSError:
            pass


def download_one(vid: str, pdir: Path, cookiefile=None,
                 host="www.youtube.com"):
    import yt_dlp

    last_emit = 0.0

    def hook(d):
        nonlocal last_emit
        if d.get("status") == "downloading":
            now = time.monotonic()
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total and now - last_emit > 1.5:
                last_emit = now
                emit(t="pct", v=int(d.get("downloaded_bytes", 0) * 100 / total))
        elif d.get("status") == "finished":
            emit(t="pct", v=100)

    # Kvadratisk beskärning av omslaget (YouTube levererar 16:9) vid
    # konvertering till JPEG — MTouch visar inbäddad kvadratisk JPEG bäst.
    crop = "crop='if(gt(ih,iw),iw,ih)':'if(gt(ih,iw),iw,ih)'"
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(pdir / f".part-{vid}.%(ext)s"),
        "writethumbnail": True,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 5,
        # Mildra bot-detektering: kort paus mellan interna API-anrop.
        "sleep_interval_requests": 0.5,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3",
             "preferredquality": "0"},
            {"key": "FFmpegMetadata"},
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg",
             "when": "before_dl"},
            {"key": "EmbedThumbnail"},
        ],
        "postprocessor_args": {
            "thumbnailsconvertor+ffmpeg_o": ["-c:v", "mjpeg", "-vf", crop],
        },
        "progress_hooks": [hook],
    }
    if cookiefile:
        # Inloggat läge går via music.youtube.com — det är där kontolåsta
        # spår och Premium-formaten (256 kbit/s) serveras.
        opts["cookiefile"] = cookiefile
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(f"https://{host}/watch?v={vid}",
                                download=True)


def unique_path(pdir: Path, base: str) -> Path:
    """Namnkollision i oformaterat läge → ' (2)'-suffix."""
    p = pdir / f"{base}.mp3"
    n = 2
    while p.exists():
        p = pdir / f"{base} ({n}).mp3"
        n += 1
    return p


def write_m3u(base: Path, folder: str):
    pdir = base / folder
    m3u_dir = base / "_explaylist_data"
    m3u_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(f.name for f in pdir.iterdir() if NUMBERED.match(f.name))
    lines = ["#EXTM3U"] + [f"../{folder}/{name}" for name in files]
    # Shanlings krav: sökvägar relativa från _explaylist_data-mappens position.
    (m3u_dir / f"{folder}.m3u").write_text("\n".join(lines) + "\n",
                                           encoding="utf-8")
    return len(files)


def run(job):
    home = Path(job["home"])
    folder = sanitize(job["folder"])
    shanling = bool(job["shanling"])
    base = home / "Musik" / "Spelaren"
    pdir = base / folder
    pdir.mkdir(parents=True, exist_ok=True)

    ck = job.get("cookiefile")
    mode = job.get("cookie_mode") or "fallback"
    always = bool(ck) and mode == "always"
    if always:
        log("Använder ditt YouTube-konto för hämtningarna.")

    log("Läser spellistan …")
    try:
        title, entries = flat_entries(job["url"], ck if always else None)
    except Exception as exc:
        if ck and not always:
            log("Kunde inte läsa spellistan anonymt — provar med ditt "
                "YouTube-konto …")
            try:
                title, entries = flat_entries(job["url"], ck)
            except Exception as exc2:
                log(f"Kunde inte läsa spellistan: {short_error(exc2)}", "error")
                emit(t="done", new=0, skipped=0, failed=1)
                return
        else:
            log(f"Kunde inte läsa spellistan: {short_error(exc)}", "error")
            emit(t="done", new=0, skipped=0, failed=1)
            return

    if not entries:
        log("Spellistan verkar vara tom.", "warn")
        emit(t="done", new=0, skipped=0, failed=0)
        return

    archive_path = pdir / "_archive.txt"
    archived = read_archive(archive_path)

    todo = [e for e in entries if e.get("id") and e["id"] not in archived]
    missing_id = sum(1 for e in entries if not e.get("id"))
    skipped = len(entries) - len(todo) - missing_id
    log(f"{len(entries)} låtar i listan — {skipped} finns redan, "
        f"{len(todo)} nya att hämta.")
    if missing_id:
        log(f"{missing_id} poster gick inte att identifiera (borttagna?) "
            f"— hoppar över.", "warn")

    new = failed = 0
    number = next_number(pdir) if shanling else 0

    if always:
        # Sista anonyma försöket är ett skyddsnät: en trasig cookie-session
        # ska inte stoppa hämtningar som fungerar utan inloggning.
        attempts = [(ck, "music.youtube.com"), (ck, "www.youtube.com"),
                    (None, "www.youtube.com")]
    else:
        attempts = [(None, "www.youtube.com")]
        if ck:
            attempts += [(ck, "music.youtube.com"), (ck, "www.youtube.com")]

    for k, entry in enumerate(todo, 1):
        if k > 1:
            # Slumpad paus mellan låtarna (max 5 s) — undviker det
            # maskinjämna hämtmönster som triggar YouTubes bot-kontroll.
            time.sleep(random.uniform(1.0, 5.0))
        vid = entry["id"]
        dl_id = vid
        substituted = False
        shown = entry.get("title") or vid
        log(f"Hämtar ({k}/{len(todo)}): {shown}")
        info = None
        last_exc = None
        for i, (ckf, host) in enumerate(attempts):
            try:
                info = download_one(vid, pdir, ckf, host)
                break
            except Exception as exc:
                last_exc = exc
                cleanup_parts(pdir, vid)
                if i == 0 and ckf is None and len(attempts) > 1:
                    log("Gick inte anonymt — provar med ditt YouTube-konto …")

        if info is None and is_unavailable(last_exc):
            sub_artist = re.sub(r"\s*-\s*Topic$", "",
                                entry.get("uploader")
                                or entry.get("channel") or "")
            sub = rescue_search(sub_artist, entry.get("title") or "",
                                entry.get("duration"))
            if sub:
                log("Originalet verkar borttaget från YouTube — provar en "
                    f"annan utgåva: {sub.get('title')} "
                    f"({sub.get('channel') or sub.get('uploader')})")
                for ckf, host in attempts:
                    try:
                        info = download_one(sub["id"], pdir, ckf, host)
                        dl_id = sub["id"]
                        substituted = True
                        break
                    except Exception as exc:
                        last_exc = exc
                        cleanup_parts(pdir, sub["id"])

        if info is None:
            log(f"Kunde inte hämta: {shown} — {short_error(last_exc)}", "warn")
            failed += 1
            continue

        tmp = pdir / f".part-{dl_id}.mp3"
        if not tmp.exists():
            log(f"Kunde inte hämta: {shown} — ingen MP3 skapades.", "warn")
            failed += 1
            cleanup_parts(pdir, dl_id)
            continue

        if substituted:
            # Ersättningsutgåva: originalpostens rena namn, inte
            # YouTube-titeln med "(Official Audio)"-svansar.
            raw_artist = sub_artist or pick_artist(info)
            track_name = entry.get("title") or info.get("title") or dl_id
            retag = True
        else:
            raw_artist = pick_artist(info)
            track_name = info.get("track")
            retag = track_name is None
            if not track_name:
                track_name = info.get("title") or vid
                # Vanliga YouTube-titlar är "Artist - Titel" — undvik dubblering.
                prefix = f"{raw_artist} - ".lower()
                if raw_artist and track_name.lower().startswith(prefix):
                    track_name = track_name[len(prefix):]
        artist = sanitize(raw_artist, 60)
        track = sanitize(track_name, 80)
        if shanling:
            final = pdir / sanitize(f"{number:03d} - {artist} - {track}", 120)
            final = final.with_name(final.name + ".mp3")
            number += 1
        else:
            final = unique_path(pdir, sanitize(f"{artist} - {track}", 120))
        tmp.rename(final)
        cleanup_parts(pdir, dl_id)
        if retag:
            # Videon saknade riktiga låt-taggar — sätt samma artist/titel
            # i ID3 som i filnamnet (annars visar spelaren råtiteln).
            try:
                from mutagen.id3 import ID3, TIT2, TPE1
                id3 = ID3(final)
                id3.setall("TIT2", [TIT2(encoding=3, text=[track_name])])
                id3.setall("TPE1", [TPE1(encoding=3, text=[raw_artist])])
                id3.save(final)
            except Exception:
                pass
        if substituted:
            # Ersättarens omslag är ofta en videoruta — byt till
            # originalspårets albumkonst om den går att hämta.
            raw = fetch_original_cover(entry, pdir)
            if raw and replace_cover(final, raw):
                log("Omslag hämtat från originalspåret.")
        # Arkivet uppdateras endast för fullständigt klara låtar.
        with archive_path.open("a", encoding="utf-8") as fh:
            fh.write(f"youtube {vid}\n")
        new += 1
        log(f"Klar: {final.name}")

    if shanling:
        total = write_m3u(base, folder)
        log(f"Spellistfil uppdaterad: _explaylist_data/{folder}.m3u "
            f"({total} låtar).")
        log("Påminnelse: kopiera hela mappen Musik/Spelaren till minneskortets "
            "rot och importera på spelaren via My Music → Playlists → ⋮ → Import.")

    emit(t="done", new=new, skipped=skipped, failed=failed + missing_id)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job")
    ap.add_argument("--probe")
    ap.add_argument("--cookies")
    args = ap.parse_args()
    if args.probe:
        probe(args.probe, args.cookies)
    elif args.job:
        run(json.loads(args.job))
    else:
        ap.error("ange --job eller --probe")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # sista skyddsnät — rapportera begripligt
        log(f"Oväntat fel: {short_error(exc)}", "error")
        sys.exit(1)
