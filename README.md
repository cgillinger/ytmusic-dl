# 📼 Musik till spelaren (ytmusic-dl)

A family-friendly, self-hosted web app for downloading YouTube Music playlists
as MP3s — built to run on a Synology NAS, with each family member's music
landing in their **own home folder**, formatted for a classic MP3 player
(Shanling M0s). Swedish UI, designed so a kid can use it without instructions.

![Huvudvyn — pågående hämtning med snurrande kassettrullar](docs/screenshots/huvudvyn.png)

## Features

- **Paste a link → get MP3s.** Best-quality audio, clean ID3 tags and a
  square-cropped embedded cover (players show square art best).
- **Multi-user without accounts to manage.** Profiles map 1:1 to the NAS
  user home directories (`/volume2/homes/<user>`). New NAS users appear
  automatically. Passwords are optional per profile — leave the field empty
  for a one-click profile.
- **Correct file ownership.** Each download job runs as the profile owner's
  uid/gid, so files are immediately editable over SMB. No root-owned
  surprises.
- **Incremental by design.** A per-playlist download archive means re-running
  a growing playlist only fetches the new tracks, numbered right after the
  existing ones.
- **MP3-player mode** (per playlist, on by default): tracks are numbered in
  playlist order (`001 - Artist - Title.mp3`) and a relative-path `.m3u` is
  generated the way the Shanling M0s wants it. Toggle it off for plain
  `Artist - Title.mp3` files.
- **Gentle on YouTube.** One sequential download worker, randomized 1–5 s
  pauses between tracks, paced API requests — no burst patterns.
- **Self-updating yt-dlp** on container start plus a one-click update button;
  the worker imports yt-dlp fresh per job, so updates apply without restarts.
- **Kid-proof error messages.** Private playlist? Bot check? The UI explains
  what happened and what to do, in plain language, right where you pasted
  the link.
- **Copy straight to the player.** In Chrome/Edge over HTTPS, a sync button
  copies only new tracks directly to the player's memory card via the File
  System Access API.
- **Cassette-deck UI.** Label-stripe colors per playlist, an amber VFD-style
  log, and a cassette whose reels spin while a download runs.

![Profilvalet](docs/screenshots/profilvalet.png)

## How it works

FastAPI backend + vanilla JS frontend in a single container. Downloads use
[yt-dlp](https://github.com/yt-dlp/yt-dlp) as a library with ffmpeg for MP3
conversion and cover embedding. Jobs are queued and executed one at a time by
a worker subprocess that drops privileges to the profile owner before writing
anything. Profiles and job history live in a small SQLite database.

Output structure per user:

```
<home>/Musik/Spelaren/
  <Playlist name>/
    001 - Artist - Title.mp3
    _archive.txt              ← dedup archive (yt-dlp format)
  _explaylist_data/
    <Playlist name>.m3u       ← relative paths, regenerated every run
```

Copy `Musik/Spelaren/` to the player's memory card as-is — the folder layout
mirrors the card.

## Quick start

Requires a Docker host with the user home directories you want to serve.

```bash
git clone https://github.com/cgillinger/ytmusic-dl.git
cd ytmusic-dl
mkdir data          # must exist before first start (Synology won't create it)
docker compose up -d --build
```

Open `http://<host>:8201`, create a profile, paste a playlist link.

### Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOMES_DIR` | `/homes` | Where user home directories are mounted |
| `DATA_DIR` | `/data` | SQLite database + session secret |
| `PORT` | `8201` | HTTP port |
| `HOMES_EXCLUDE` | *(empty)* | Comma-separated accounts to hide from the profile picker (`admin`/`guest` are always hidden) |

Put site-specific values in a `docker-compose.override.yml` (gitignored).

### Synology notes

- The compose file mounts `/volume2/homes` — adjust to your volume.
- The container must run as **root** (it drops privileges per job); don't add
  a `user:` directive.
- For the "copy to MP3 player" button you need HTTPS: add a reverse-proxy
  rule in DSM (Control Panel → Login Portal → Advanced → Reverse Proxy)
  from an HTTPS port to `http://localhost:8201`.

## Notes on private playlists

YouTube Music playlists are **private by default**, which the anonymous
downloader can't read. Set the playlist to **Unlisted** (⋮ → Edit playlist →
Privacy) — still hidden from search and public profiles, but readable via
the link. The UI explains this too when it happens.

## Legal

This tool is intended for **personal, private use** (in Sweden: private
copying under 12 § upphovsrättslagen). Downloading from YouTube may violate
YouTube's Terms of Service and the legal situation differs between
jurisdictions — you are responsible for how you use this software. Not
affiliated with YouTube or Shanling.
