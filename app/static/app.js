/* Musik till spelaren — frontend. Vanilla JS, ingen byggkedja. */
"use strict";

const $ = (id) => document.getElementById(id);

const HINT_ON = "Låtarna numreras i spellistans ordning (001, 002 …) och en " +
  "spellistfil skapas som kan importeras på spelaren. Välj detta för musik " +
  "som ska till mp3-spelaren.";
const HINT_OFF = "Filerna får bara namnet Artist – Titel. Ingen numrering och " +
  "ingen spellistfil — mp3-spelaren kan då inte spela låtarna i spellistans " +
  "ordning.";
const SMB_HINT = "Du hittar musiken via Utforskaren/Finder: \\\\SERVERN\\home\\" +
  "Musik\\Spelaren — kopiera hela mappen till minneskortets rot.";

let state = { profile: null, playlists: [], pollTimer: null,
  watchTimer: null, currentJobId: null, lastLogId: 0 };

async function api(path, opts = {}) {
  if (opts.body !== undefined) {
    opts.headers = { "Content-Type": "application/json", ...opts.headers };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `Fel (${res.status})`;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function show(view) {
  for (const v of ["view-loading", "view-profiles", "view-create", "view-main"])
    $(v).hidden = v !== view;
  $("who").hidden = view !== "view-main";
  $("foot").hidden = view !== "view-main";
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/* Varje namn får sin egen färgvridning av kassettränderna */
function stripeRot(name) {
  const sum = Array.from(name || "").reduce((a, c) => a + c.charCodeAt(0), 0);
  return ((sum * 47) % 360) + "deg";
}

function avatar(name, color, small = false) {
  const a = el("span", { class: "avatar" + (small ? " avatar-s" : "") },
    (name || "?")[0].toUpperCase());
  a.style.background = color || "#6E6A5E";
  return a;
}

function modal(title, ...bodyNodes) {
  $("modal-title").textContent = title;
  const body = $("modal-body");
  body.replaceChildren(...bodyNodes);
  $("modal").showModal();
}

/* ---------- profiler ---------- */

async function showProfiles() {
  const profiles = await api("/api/profiles");
  const wrap = $("profile-cards");
  wrap.replaceChildren();
  if (!profiles.length) { showCreate(); return; }
  for (const p of profiles) {
    const card = el("button", { class: "card",
      style: `--stripe-rot:${stripeRot(p.name)}`,
      onclick: () => openProfile(p, card) },
      avatar(p.name, p.color),
      el("div", { class: "card-name" }, p.name),
      el("div", { class: "card-note" }, p.has_password ? "har lösenord" : " "));
    wrap.append(card);
  }
  show("view-profiles");
}

async function openProfile(p, card) {
  if (!p.has_password) {
    await login(p.id, "");
    return;
  }
  if (card.querySelector(".pwrow")) return;
  const input = el("input", { type: "password", placeholder: "Lösenord",
    autocomplete: "current-password" });
  const err = el("p", { class: "error", hidden: "" });
  const row = el("div", { class: "pwrow" }, input, err,
    el("button", { class: "btn btn-dark btn-s", onclick: async (e) => {
      e.stopPropagation();
      try { await login(p.id, input.value); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; }
    } }, "Öppna"));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") row.querySelector("button").click();
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  card.append(row);
  input.focus();
}

async function login(profileId, password) {
  await api("/api/login", { method: "POST",
    body: { profile_id: profileId, password } });
  await boot();
}

/* ---------- skapa profil ---------- */

let selectedHome = null;

async function showCreate() {
  selectedHome = null;
  $("new-pw").value = "";
  $("create-error").hidden = true;
  const homes = await api("/api/homes");
  const wrap = $("home-cards");
  wrap.replaceChildren();
  for (const h of homes) {
    const card = el("button", { class: "card",
      style: `--stripe-rot:${stripeRot(h.name)}`,
      ...(h.taken ? { disabled: "" } : {}),
      onclick: () => {
        selectedHome = h.name;
        wrap.querySelectorAll(".card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
      } },
      avatar(h.name, "#3F5FB7"),
      el("div", { class: "card-name" }, h.name),
      el("div", { class: "card-note" }, h.taken ? "har redan en profil" : " "));
    wrap.append(card);
  }
  if (!homes.some(h => !h.taken)) {
    wrap.append(el("p", { class: "hint" },
      "Alla konton har redan profiler. Nytt konto skapas i DSM av Christian."));
  }
  show("view-create");
}

$("btn-create").addEventListener("click", async () => {
  const err = $("create-error");
  err.hidden = true;
  if (!selectedHome) {
    err.textContent = "Välj ditt konto först.";
    err.hidden = false;
    return;
  }
  try {
    await api("/api/profiles", { method: "POST",
      body: { home: selectedHome, password: $("new-pw").value } });
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});
$("btn-create-cancel").addEventListener("click", showProfiles);
$("btn-new-profile").addEventListener("click", showCreate);

/* ---------- huvudvy ---------- */

async function showMain() {
  $("who-name").textContent = state.profile.name;
  $("who-avatar").replaceWith(Object.assign(
    avatar(state.profile.name, state.profile.color, true), { id: "who-avatar" }));
  $("shanling-hint").textContent = $("shanling").checked ? HINT_ON : HINT_OFF;
  show("view-main");
  $("job-panel").hidden = true;  // visa aldrig en gammal körnings logg
  await refreshPlaylists();
  const active = await api("/api/jobs/active");
  if (active.job_id) pollJob(active.job_id);
  startJobWatcher();
  refreshMeta();
}

/* Håller loggpanelen synkad med det jobb som faktiskt kör — även om det
   startats i en annan flik eller innan sidan laddades om. */
function startJobWatcher() {
  clearInterval(state.watchTimer);
  state.watchTimer = setInterval(async () => {
    try {
      const active = await api("/api/jobs/active");
      if (active.job_id && active.job_id !== state.currentJobId) {
        pollJob(active.job_id);
        refreshPlaylists();
      }
    } catch {}
  }, 5000);
}

$("shanling").addEventListener("change", () => {
  $("shanling-hint").textContent = $("shanling").checked ? HINT_ON : HINT_OFF;
});

function setProbe(status, text) {
  const el = $("url-info");
  if (!status) { el.hidden = true; return; }
  el.hidden = false;
  el.className = "probe " + status;
  el.replaceChildren(el2("span", "led"), text);
}

function el2(tag, cls) {
  const n = document.createElement(tag);
  n.className = cls;
  return n;
}

let probeTimer = null;
$("url").addEventListener("input", () => {
  clearTimeout(probeTimer);
  const url = $("url").value.trim();
  setProbe(null);
  if (!/^https?:\/\//i.test(url)) return;
  setProbe("loading", "Läser spellistan …");
  probeTimer = setTimeout(async () => {
    try {
      const info = await api("/api/playlist-info?url=" + encodeURIComponent(url));
      setProbe("ok", `Hittade: ${info.title} (${info.count} låtar)`);
      if (!$("plname").value.trim()) $("plname").value = info.title;
    } catch (ex) {
      setProbe("error", ex.message);
    }
  }, 600);
});

$("btn-fetch").addEventListener("click", async () => {
  const err = $("form-error");
  err.hidden = true;
  const url = $("url").value.trim();
  const name = $("plname").value.trim();
  if (!url) { err.textContent = "Klistra in en länk först."; err.hidden = false; return; }
  if (!name) { err.textContent = "Ge spellistan ett namn."; err.hidden = false; return; }
  $("btn-fetch").disabled = true;
  try {
    const res = await api("/api/playlists", { method: "POST",
      body: { url, name, shanling: $("shanling").checked } });
    $("url").value = ""; $("plname").value = ""; setProbe(null);
    await refreshPlaylists();
    pollJob(res.job_id);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $("btn-fetch").disabled = false;
  }
});

async function refreshPlaylists() {
  state.playlists = await api("/api/playlists");
  const wrap = $("playlist-list");
  wrap.replaceChildren();
  $("playlist-empty").hidden = state.playlists.length > 0;
  for (const p of state.playlists) {
    let meta = "Inget hämtat än";
    if (p.active_job) meta = "Hämtning pågår …";
    else if (p.last_job) {
      const j = p.last_job;
      meta = j.status === "error"
        ? "Senaste hämtningen misslyckades"
        : `Senast: ${j.new ?? 0} nya · ${j.skipped ?? 0} fanns redan` +
          (j.failed ? ` · ${j.failed} fel` : "");
    }
    const actions = [
      el("button", { class: "btn btn-dark btn-s",
        ...(p.active_job ? { disabled: "" } : {}),
        onclick: async () => {
          try {
            const res = await api(`/api/playlists/${p.id}/fetch`, { method: "POST" });
            await refreshPlaylists();
            pollJob(res.job_id);
          } catch (ex) { modal("Hoppsan", el("p", {}, ex.message)); }
        } }, "Hämta nya låtar"),
    ];
    if (p.shanling) {
      actions.push(el("button", { class: "btn btn-ghost btn-s",
        onclick: () => syncToPlayer(p) }, "Kopiera till mp3-spelare"));
    }
    actions.push(el("button", { class: "linkish", onclick: () => {
      modal("Ta bort ur listan?",
        el("p", {}, `"${p.name}" försvinner bara ur listan här — de hämtade ` +
          "låtarna ligger kvar i din mapp."),
        el("div", { class: "row" },
          el("button", { class: "btn btn-rec", onclick: async () => {
            await api(`/api/playlists/${p.id}`, { method: "DELETE" });
            $("modal").close();
            refreshPlaylists();
          } }, "Ta bort")));
    } }, "Ta bort ur listan"));

    wrap.append(el("div", { class: "pl-card",
      style: `--stripe-rot:${stripeRot(p.name)}` },
      el("div", { class: "pl-body" },
        el("div", { class: "pl-name" }, p.name,
          ...(p.shanling ? [el("span", { class: "tag" }, "MP3-SPELARE")] : [])),
        el("div", { class: "pl-meta" }, meta),
        el("div", { class: "pl-actions" }, ...actions))));
  }
}

/* ---------- jobb & logg ---------- */

function pollJob(jobId) {
  clearInterval(state.pollTimer);
  state.currentJobId = jobId;
  state.lastLogId = 0;
  $("job-panel").hidden = false;
  $("job-summary").hidden = true;
  $("job-log").replaceChildren();
  $("job-bar").style.width = "0";
  $("job-title").textContent = "Hämtar …";
  $("job-cassette").classList.add("spinning");

  const tick = async () => {
    let job;
    try { job = await api(`/api/jobs/${jobId}?after=${state.lastLogId}`); }
    catch { return; }
    if (job.playlist) $("job-title").textContent = "Hämtar: " + job.playlist.name;
    const logEl = $("job-log");
    // Autoscrolla bara om användaren redan är vid slutet — den som
    // scrollat upp för att läsa ska inte ryckas ner igen.
    const nearBottom =
      logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
    for (const line of job.log) {
      state.lastLogId = line.id;
      const cls = line.level === "info" && /^Klar:/.test(line.msg) ? "ok" : line.level;
      logEl.append(el("li", { class: cls },
        el("span", { class: "led" }), el("span", {}, line.msg)));
    }
    if (job.log.length && nearBottom) logEl.scrollTop = logEl.scrollHeight;
    $("job-bar").style.width = (job.progress ?? 0) + "%";

    if (job.status === "done" || job.status === "error") {
      clearInterval(state.pollTimer);
      $("job-cassette").classList.remove("spinning");
      $("job-bar").style.width = "100%";
      const s = $("job-summary");
      if (job.status === "done") {
        s.textContent = `Klart! ${job.new ?? 0} nya låtar hämtade, ` +
          `${job.skipped ?? 0} fanns redan` +
          (job.failed ? ` — ${job.failed} gick inte att hämta.` : ".");
        s.className = "summary ok";
      } else {
        s.textContent = "Hämtningen misslyckades — se loggen ovanför.";
        s.className = "summary error";
      }
      s.hidden = false;
      refreshPlaylists();
    }
  };
  tick();
  state.pollTimer = setInterval(tick, 1200);
}

/* ---------- "Kopiera till mp3-spelare" (File System Access API) ----------
   OBS: otestad mot fysisk spelare — M0s har inte levererats än. */

async function syncToPlayer(playlist) {
  if (!window.showDirectoryPicker || !window.isSecureContext) {
    modal("Kopiera till mp3-spelare",
      el("p", {}, "Den här knappen kan kopiera musiken direkt till " +
        "minneskortet när mp3-spelaren är ansluten till din dator med USB."),
      el("p", {}, window.showDirectoryPicker
        ? "Men den kräver en säker anslutning (https), och tjänsten körs på " +
          "vanlig http just nu."
        : "Den fungerar bara i Chrome eller Edge."),
      el("p", {}, "Så länge: " + SMB_HINT));
    return;
  }
  let root;
  try {
    root = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch { return; /* avbrutet */ }

  const status = el("p", {}, "Jämför med kortet …");
  modal("Kopierar till mp3-spelare", status);
  try {
    const manifest = await api(`/api/playlists/${playlist.id}/files`);
    const dir = await root.getDirectoryHandle(manifest.folder, { create: true });
    const existing = new Set();
    for await (const entry of dir.keys()) existing.add(entry);

    let copied = 0;
    const todo = manifest.files.filter(f => !existing.has(f));
    for (const [i, name] of todo.entries()) {
      status.textContent = `Kopierar (${i + 1}/${todo.length}): ${name}`;
      const res = await fetch(
        `/api/playlists/${playlist.id}/file/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error("Kunde inte läsa " + name);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await res.body.pipeTo(w);
      copied++;
    }
    if (manifest.m3u) {
      const m3uDir = await root.getDirectoryHandle("_explaylist_data",
        { create: true });
      const fh = await m3uDir.getFileHandle(manifest.m3u.name, { create: true });
      const w = await fh.createWritable();
      await w.write(manifest.m3u.content);
      await w.close();
    }
    status.textContent = copied
      ? `Klart! ${copied} nya låtar kopierade till kortet. Importera ` +
        "spellistan på spelaren: My Music → Playlists → ⋮ → Import."
      : "Kortet var redan uppdaterat — inga nya låtar att kopiera.";
  } catch (ex) {
    status.textContent = "Kopieringen misslyckades: " + ex.message;
  }
}

/* ---------- YouTube-konto (cookies) ---------- */

function renderCookies(st) {
  st = st || { uploaded: false, mode: "fallback" };
  $("cookie-status").textContent = st.uploaded
    ? "Konto kopplat ✓" : "Inget konto kopplat.";
  $("cookie-remove").hidden = !st.uploaded;
  $("cookie-mode-row").hidden = !st.uploaded;
  $("cookie-always").checked = st.mode === "always";
  // Status även i den stängda sektionsrubriken
  const note = $("acct-summary-note");
  if (st.uploaded) {
    note.textContent = st.mode === "always"
      ? "✓ YouTube-konto kopplat — används för alla hämtningar"
      : "✓ YouTube-konto kopplat — används som reserv";
    note.classList.add("linked");
  } else {
    note.textContent = "(valfritt)";
    note.classList.remove("linked");
  }
}

$("cookie-file").addEventListener("change", async () => {
  const file = $("cookie-file").files[0];
  $("cookie-error").hidden = true;
  if (!file) return;
  try {
    const content = await file.text();
    renderCookies(await api("/api/cookies", { method: "POST",
      body: { content } }));
  } catch (ex) {
    $("cookie-error").textContent = ex.message;
    $("cookie-error").hidden = false;
  }
  $("cookie-file").value = "";
});

$("cookie-remove").addEventListener("click", async () => {
  renderCookies(await api("/api/cookies", { method: "DELETE" }));
});

$("cookie-always").addEventListener("change", async () => {
  renderCookies(await api("/api/cookies", { method: "POST",
    body: { mode: $("cookie-always").checked ? "always" : "fallback" } }));
});

/* ---------- kopiera text-knappar ---------- */

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      // Clipboard-API:t kräver https — fallback för vanlig LAN-http.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    return true;
  } catch {
    return false;
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copybtn");
  if (!btn) return;
  if (await copyText(btn.dataset.copy)) {
    const original = btn.innerHTML;
    btn.classList.add("copied");
    btn.textContent = "✓";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = original;
    }, 1500);
  }
});

/* ---------- sidfot ---------- */

async function refreshMeta() {
  const s = await api("/api/state");
  $("meta-line").textContent =
    `yt-dlp ${s.ytdlp_version ?? "?"} · ffmpeg ${s.ffmpeg_ok ? "OK" : "SAKNAS"}`;
  renderCookies(s.cookies);
}

$("btn-update-ytdlp").addEventListener("click", async () => {
  const btn = $("btn-update-ytdlp");
  btn.disabled = true;
  btn.textContent = "Uppdaterar …";
  try {
    const res = await api("/api/update-ytdlp", { method: "POST" });
    btn.textContent = "Uppdaterad ✓";
    $("meta-line").textContent = `yt-dlp ${res.ytdlp_version} · ffmpeg OK`;
  } catch (ex) {
    btn.textContent = "Uppdatera yt-dlp";
    modal("Hoppsan", el("p", {}, ex.message));
    btn.disabled = false;
  }
});

$("btn-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  clearInterval(state.pollTimer);
  clearInterval(state.watchTimer);
  state.currentJobId = null;
  boot();
});

$("modal-close").addEventListener("click", () => $("modal").close());

/* ---------- start ---------- */

async function boot() {
  $("brand-sub").textContent = location.host;
  try {
    const s = await api("/api/state");
    state.profile = s.profile;
    if (state.profile) await showMain();
    else await showProfiles();
  } catch (ex) {
    $("view-loading").innerHTML = "";
    $("view-loading").append(
      el("p", { class: "error center" }, "Kunde inte nå tjänsten: " + ex.message));
    show("view-loading");
  }
}

boot();
