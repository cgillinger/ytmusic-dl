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
  setTab("fetch");
  $("job-panel").hidden = true;  // visa aldrig en gammal körnings logg
  await refreshPlaylists();
  const active = await api("/api/jobs/active");
  if (active.job_id) pollJob(active.job_id);
  startJobWatcher();
  refreshMeta();
  restoreNowPlaying();
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
      body: { url, name, shanling: $("shanling").checked,
        prune: $("prune").checked } });
    $("url").value = ""; $("plname").value = ""; setProbe(null);
    await afterJobStart(res.job_id);
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
  const runningName = state.playlists
    .find(p => p.active_job?.status === "running")?.name;
  for (const p of state.playlists) {
    let meta = "Inget hämtat än";
    let metaClass = "pl-meta";
    if (p.active_job?.status === "running") {
      meta = "● Hämtar nu — följ loggen här ovanför";
      metaClass = "pl-meta running";
    } else if (p.active_job?.status === "queued") {
      meta = runningName
        ? `I kö — startar när "${runningName}" är klar`
        : "I kö — startar strax";
      metaClass = "pl-meta queued";
    } else if (p.last_job) {
      const j = p.last_job;
      meta = j.status === "error"
        ? "Senaste hämtningen misslyckades"
        : j.status === "cancelled"
          ? "Senaste hämtningen avbröts"
          : `Senast: ${j.new ?? 0} nya · ${j.skipped ?? 0} fanns redan` +
            (j.failed ? ` · ${j.failed} fel` : "");
    }
    const actions = [
      el("button", { class: "btn btn-dark btn-s",
        ...(p.active_job ? { disabled: "" } : {}),
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = "Startar …";
          try {
            const res = await api(`/api/playlists/${p.id}/fetch`,
              { method: "POST" });
            await afterJobStart(res.job_id);
          } catch (ex) {
            modal("Hoppsan", el("p", {}, ex.message));
            refreshPlaylists();
          }
        } }, "Hämta nya låtar"),
    ];
    if (p.shanling) {
      actions.push(el("button", { class: "btn btn-ghost btn-s",
        onclick: () => syncToPlayer(p) }, "Kopiera till mp3-spelare"));
    }
    // "Spellistan är sanningen" — raderar strukna låtar vid hämtning.
    // Påslag kräver en bekräftelse eftersom filer faktiskt tas bort.
    const pruneBox = el("input", { type: "checkbox",
      ...(p.prune ? { checked: "" } : {}) });
    pruneBox.addEventListener("change", async () => {
      if (pruneBox.checked) {
        pruneBox.checked = false;
        modal("Spellistan är sanningen?",
          el("p", {}, `Låtar som du stryker ur "${p.name}" raderas då från ` +
            "hårddisken vid nästa hämtning — och försvinner från " +
            "mp3-spelaren nästa gång du kopierar dit spellistan."),
          el("p", {}, "Lägger du tillbaka en låt i spellistan hämtas den " +
            "om igen."),
          el("div", { class: "row" },
            el("button", { class: "btn btn-rec", onclick: async () => {
              try {
                await api(`/api/playlists/${p.id}`, { method: "PATCH",
                  body: { prune: true } });
              } catch (ex) { modal("Hoppsan", el("p", {}, ex.message)); return; }
              $("modal").close();
              refreshPlaylists();
            } }, "Slå på")));
      } else {
        try {
          await api(`/api/playlists/${p.id}`, { method: "PATCH",
            body: { prune: false } });
        } catch (ex) { modal("Hoppsan", el("p", {}, ex.message)); }
        refreshPlaylists();
      }
    });
    const pruneRow = el("label", { class: "pl-prune",
      title: "Struket ur spellistan raderas från hårddisken vid nästa " +
        "hämtning och från mp3-spelaren vid nästa kopiering." },
      pruneBox, el("span", {}, "Spellistan är sanningen — struket raderas " +
        "vid hämtning"));

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
        el("div", { class: metaClass }, meta),
        el("div", { class: "pl-actions" }, ...actions),
        pruneRow)));
  }
}

/* ---------- jobb & logg ---------- */

/* Efter jobbstart: scrolla ner till loggen om jobbet kör direkt, eller
   förklara kön om en annan hämtning är igång. */
async function afterJobStart(jobId) {
  await refreshPlaylists();
  let job = null;
  try { job = await api(`/api/jobs/${jobId}`); } catch {}
  // "queued" direkt efter start kan vara en övergångsstatus: jobbet är
  // inlagt i kön men jobbkörartråden har inte hunnit plocka det än.
  // Köförklaringen visas därför bara om en ANNAN spellista faktiskt har
  // ett aktivt jobb — annars är kön tom och hämtningen startar strax.
  if (job && job.status === "queued") {
    const others = state.playlists.filter(p =>
      p.id !== job.playlist?.id && p.active_job);
    if (others.length) {
      const runningName = others
        .find(p => p.active_job.status === "running")?.name;
      modal("Ställd i kö",
        el("p", {}, "Bara en spellista hämtas åt gången (snällt mot både " +
          "NAS:en och YouTube)."),
        el("p", {}, runningName
          ? `Just nu hämtas "${runningName}". Den här spellistan startar ` +
            "automatiskt direkt efteråt — du behöver inte göra något."
          : "En annan hämtning pågår. Den här spellistan startar " +
            "automatiskt direkt efteråt."));
      return;
    }
  }
  pollJob(jobId);
  $("job-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

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
  $("job-actions").hidden = false;
  $("btn-cancel").disabled = false;
  $("btn-cancel").onclick = async () => {
    $("btn-cancel").disabled = true;
    try { await api(`/api/jobs/${jobId}/cancel`, { method: "POST" }); }
    catch (ex) { modal("Hoppsan", el("p", {}, ex.message)); }
  };

  const tick = async () => {
    let job;
    try { job = await api(`/api/jobs/${jobId}?after=${state.lastLogId}`); }
    catch { return; }
    if (job.playlist) {
      $("job-title").textContent =
        (job.status === "queued" ? "I kö: " : "Hämtar: ") + job.playlist.name;
    }
    $("job-cassette").classList.toggle("spinning", job.status === "running");
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

    if (["done", "error", "cancelled"].includes(job.status)) {
      clearInterval(state.pollTimer);
      $("job-cassette").classList.remove("spinning");
      $("job-actions").hidden = true;
      $("job-bar").style.width = "100%";
      const s = $("job-summary");
      if (job.status === "done") {
        s.textContent = `Klart! ${job.new ?? 0} nya låtar hämtade, ` +
          `${job.skipped ?? 0} fanns redan` +
          (job.failed ? ` — ${job.failed} gick inte att hämta.` : ".");
        s.className = "summary ok";
      } else if (job.status === "cancelled") {
        s.textContent = "Hämtningen avbröts. Redan hämtade låtar ligger kvar.";
        s.className = "summary warn";
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
   Verifierad mot fysisk M0s 2026-08-07: relativa sökvägar i m3u:n fungerar.
   Spelaren kräver dock att biblioteket är skannat (System → Update Library)
   innan importen hittar något — därav påminnelsen i klart-meddelandet.

   Mappvalet görs bara första gången: handtaget sparas i IndexedDB och en
   markörfil på kortet intygar att det är rätt kort. Webbläsare kan inte
   läsa USB-id:n för lagringsenheter, så markörfilen ÄR kortets id.

   Markörfilen bär också kortets status som JSON ({instruerad, importerade})
   — på kortet, inte i webbläsaren, så att instruktionerna blir rätt även
   när ett annat konto eller en annan dator (Linux/Windows) synkar. */

const MARKER = ".ytmusic-dl-spelare";

async function readMarker(root) {
  try {
    const f = await (await root.getFileHandle(MARKER)).getFile();
    return JSON.parse(await f.text() || "{}");
  } catch { return {}; }
}

async function writeMarker(root, marker) {
  const fh = await root.getFileHandle(MARKER, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(marker));
  await w.close();
}

function kvStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("ymdl", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction("kv", mode).objectStore("kv"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}
const kvGet = k => kvStore("readonly", s => s.get(k));
const kvSet = (k, v) => kvStore("readwrite", s => s.put(v, k));

/* Sparat kort: giltigt om handtaget svarar, vi får skrivlov (ett klick i
   webbläsarens fråga — eller inget alls om "Tillåt varje gång" valts) och
   markörfilen finns kvar. Annars: tillbaka till mappväljaren. */
async function rememberedRoot() {
  try {
    const root = await kvGet("playerRoot");
    if (!root) return null;
    if (await root.queryPermission({ mode: "readwrite" }) !== "granted" &&
        await root.requestPermission({ mode: "readwrite" }) !== "granted")
      return null;
    await root.getFileHandle(MARKER);
    return root;
  } catch { return null; /* urkopplat, omdöpt eller främmande kort */ }
}

function confirmPlayerRoot(root, names) {
  return new Promise(resolve => {
    const done = ok => { resolve(ok); $("modal").close(); };
    $("modal").addEventListener("close", () => resolve(false), { once: true });
    modal("Är detta mp3-spelarens minneskort?",
      el("p", {}, `Vald mapp: ”${root.name}”` + (names.length
        ? ` — innehåller: ${names.slice(0, 5).join(", ")}` +
          (names.length > 5 ? " …" : "")
        : " (tom)")),
      el("p", {}, "Valet sparas — nästa gång kopierar appen hit direkt, " +
        "utan att du behöver leta rätt på kortet igen."),
      el("div", { class: "row" },
        el("button", { class: "btn btn-rec",
          onclick: () => done(true) }, "Ja, kopiera hit")));
  });
}

async function getPlayerRoot() {
  let root = await rememberedRoot();
  if (root) return root;
  try {
    root = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch { return null; /* avbrutet */ }
  const names = [];
  for await (const name of root.keys())
    if (!name.startsWith(".")) names.push(name);
  if (!(await confirmPlayerRoot(root, names.sort()))) return null;
  await writeMarker(root, { spelare: "Shanling M0s", ...await readMarker(root) });
  await kvSet("playerRoot", root);
  return root;
}

/* Hela receptet, alltid nåbart via länk i klart-rutan — ifall en flagga i
   markörfilen säger "klart" fast steget aldrig utfördes på spelaren. */
function shanlingGuide(folder) {
  modal("Shanling M0s — så funkar det",
    el("ol", {},
      el("li", {}, "Mata ut kortet i datorn (Säker borttagning i Windows) " +
        "och dra ur USB-kabeln — spelaren ser inte kortet medan kabeln " +
        "sitter i."),
      el("li", {}, "En gång per spelare: System → Update Library — slå på " +
        "Automatic (då skannar spelaren om musiken varje gång kabeln dras " +
        "ur) och kör Update Music en första gång. Utan skanningen visar " +
        "spelaren ”No music” och artister som ”unknown”."),
      el("li", {}, "Varje ny spellista importeras en gång: My Music → " +
        "Playlists → ⋮ → Import playlist" +
        (folder ? ` → ”${folder}”.` : ".")),
      el("li", {}, "När en spellista har ändrats: ta bort den i Playlists " +
        "på spelaren och importera om den — den uppdateras inte av sig " +
        "själv.")));
}

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
  const root = await getPlayerRoot();
  if (!root) return;

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
    // Ta bort mp3:or på kortet som inte längre finns i spellistmappen —
    // omnumreringen byter filnamn när spellistans ordning ändras.
    let removed = 0;
    for (const name of existing) {
      if (name.toLowerCase().endsWith(".mp3") &&
          !manifest.files.includes(name)) {
        await dir.removeEntry(name);
        removed++;
      }
    }
    if (manifest.m3u) {
      const m3uDir = await root.getDirectoryHandle("_explaylist_data",
        { create: true });
      const fh = await m3uDir.getFileHandle(manifest.m3u.name, { create: true });
      const w = await fh.createWritable();
      await w.write(manifest.m3u.content);
      await w.close();
    }
    // Instruktionen anpassas efter kortets status i markörfilen: bara de
    // steg som återstår för just den här spelaren och spellistan visas.
    const changed = copied > 0 || removed > 0;
    const marker = await readMarker(root);
    const imported = (marker.importerade || []).includes(manifest.folder);
    const steps = [];
    if (!marker.instruerad)
      steps.push(el("li", {}, "En gång per spelare: System → " +
        "Update Library — slå på Automatic och kör Update Music. " +
        "Annars visar spelaren ”No music” och artister som ”unknown”."));
    if (!imported)
      steps.push(el("li", {}, "Importera spellistan: My Music → Playlists " +
        `→ ⋮ → Import playlist → ”${manifest.folder}”.`));
    else if (changed)
      steps.push(el("li", {}, `Spellistan har ändrats: ta bort ` +
        `”${manifest.folder}” i Playlists på spelaren och importera om den ` +
        "(⋮ → Import playlist) — den uppdateras inte av sig själv."));
    const summary = changed
      ? `Klart! ${copied} nya låtar kopierade` +
        (removed ? `, ${removed} inaktuella borttagna` : "") + "."
      : "Kortet var redan uppdaterat — inga nya låtar att kopiera.";
    if (steps.length) {
      steps.unshift(el("li", {}, "Mata ut kortet i datorn (Säker " +
        "borttagning i Windows) och dra ur USB-kabeln."));
      modal("Kopierat till mp3-spelaren",
        el("p", {}, summary),
        el("p", {}, el("strong", {}, "Gör klart på spelaren (Shanling M0s):")),
        el("ol", {}, ...steps),
        el("p", {}, el("button", { class: "linkish",
          onclick: () => shanlingGuide(manifest.folder) },
          "Visa fullständiga instruktioner")));
      marker.spelare = marker.spelare || "Shanling M0s";
      marker.instruerad = true;
      marker.importerade =
        [...new Set([...(marker.importerade || []), manifest.folder])];
      await writeMarker(root, marker);
    } else {
      status.textContent = summary + " Spelaren uppdaterar sig själv när " +
        "kabeln dras ur.";
    }
  } catch (ex) {
    status.textContent = "Kopieringen misslyckades: " + ex.message;
  }
}

/* ---------- bibliotek & spelare ---------- */

const lib = { tracks: [], plId: null, plName: "", idx: -1 };
const audio = $("audio");
let seekDragging = false;

function setTab(which) {
  $("tab-fetch").classList.toggle("active", which === "fetch");
  $("tab-library").classList.toggle("active", which === "library");
  $("fetch-view").hidden = which !== "fetch";
  $("library-view").hidden = which !== "library";
  if (which === "library") loadShelf();
}
$("tab-fetch").addEventListener("click", () => setTab("fetch"));
$("tab-library").addEventListener("click", () => setTab("library"));

function coverUrl(plId, t) {
  return `/api/playlists/${plId}/cover/${encodeURIComponent(t.file)}`;
}

async function loadShelf() {
  $("lib-detail").hidden = true;
  $("lib-shelf").hidden = false;
  const shelf = $("lib-shelf");
  shelf.replaceChildren();
  let any = false;
  for (const p of await api("/api/playlists")) {
    const data = await api(`/api/playlists/${p.id}/tracks`);
    if (!data.tracks.length) continue;
    any = true;
    const covers = data.tracks.filter(t => t.has_cover).slice(0, 4);
    const collage = el("div",
      { class: "collage" + (covers.length < 4 ? " single" : "") });
    if (!covers.length) {
      collage.append(el("div", { class: "noart" }, "📼"));
    } else {
      const use = covers.length >= 4 ? covers : covers.slice(0, 1);
      for (const t of use) {
        collage.append(el("img", { loading: "lazy", alt: "",
          src: coverUrl(p.id, t) }));
      }
    }
    shelf.append(el("button", { class: "shelf-card",
      onclick: () => openLibPlaylist(p.id) },
      collage,
      el("div", { class: "shelf-name" }, p.name),
      el("div", { class: "shelf-count" }, `${data.tracks.length} låtar`)));
  }
  $("lib-empty").hidden = any;
}

async function openLibPlaylist(plId) {
  const data = await api(`/api/playlists/${plId}/tracks`);
  if (lib.plId !== plId) lib.idx = -1;
  lib.plId = plId;
  lib.plName = data.name;
  lib.tracks = data.tracks;
  $("lib-title").textContent = data.name;
  $("lib-shelf").hidden = true;
  $("lib-detail").hidden = false;
  renderTracks();
}

function fmtTime(s) {
  if (s == null || isNaN(s)) return "–:–";
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderTracks() {
  const wrap = $("lib-tracks");
  wrap.replaceChildren();
  lib.tracks.forEach((t, i) => {
    wrap.append(el("div",
      { class: "trackrow" + (i === lib.idx ? " playing" : ""),
        role: "button", tabindex: "0",
        onclick: () => playTrack(i),
        onkeydown: (e) => { if (e.key === "Enter") playTrack(i); } },
      el("span", { class: "t-no" }, i === lib.idx ? "▶" : String(i + 1)),
      t.has_cover
        ? el("img", { class: "t-cover", loading: "lazy", alt: "",
            src: coverUrl(lib.plId, t) })
        : el("span", { class: "t-cover" }),
      el("span", { class: "t-meta" },
        el("div", { class: "t-title" },
          t.title || t.file.replace(/\.mp3$/, ""),
          ...(t.note && t.note.startsWith("Alternativ")
            ? [el("span", { class: "t-alt", title: t.note }, "annan utgåva")]
            : [])),
        el("div", { class: "t-artist" }, t.artist || "")),
      el("span", { class: "t-len" }, fmtTime(t.duration)),
      el("button", { class: "t-info", "aria-label": "Fakta om låten",
        onclick: (e) => { e.stopPropagation(); showFacts(t); } }, "i")));
  });
}

function showFacts(t) {
  const dl = el("dl", {});
  const add = (k, v) => dl.append(el("dt", {}, k), el("dd", {}, v));
  add("Artist", t.artist || "Okänd");
  add("Titel", t.title || t.file.replace(/\.mp3$/, ""));
  add("Längd", fmtTime(t.duration));
  if (t.bitrate) add("Ljudkvalitet", `${t.bitrate} kbit/s`);
  add("Filstorlek", `${(t.size / 1048576).toFixed(1)} MB`);
  add("Hämtad", new Date(t.mtime * 1000).toLocaleDateString("sv-SE"));
  if (t.note) add("Källa", t.note);
  add("Fil", t.file);
  const box = el("div", { class: "factbox" });
  if (t.has_cover) box.append(el("img", { alt: "", src: coverUrl(lib.plId, t) }));
  box.append(dl);
  modal("Om låten", box);
}

function setPlayerBar(t) {
  $("player").hidden = false;
  document.body.classList.add("has-player");
  $("player-title").textContent = t.title || t.file.replace(/\.mp3$/, "");
  $("player-artist").textContent = t.artist || lib.plName;
  const cov = $("player-cover");
  if (t.has_cover) { cov.src = coverUrl(lib.plId, t); cov.hidden = false; }
  else { cov.hidden = true; }
}

function playTrack(i) {
  if (i < 0 || i >= lib.tracks.length) return;
  lib.idx = i;
  const t = lib.tracks[i];
  audio.src = `/api/playlists/${lib.plId}/stream/${encodeURIComponent(t.file)}`;
  audio.play();
  setPlayerBar(t);
  renderTracks();
}

function npKey() { return `ymdl-np-${state.profile?.id}`; }

function saveNowPlaying() {
  if (lib.plId == null || lib.idx < 0 || !state.profile) return;
  localStorage.setItem(npKey(), JSON.stringify({
    plId: lib.plId, file: lib.tracks[lib.idx].file,
    pos: audio.currentTime }));
}

/* Efter sidladdning: ladda senaste låten pausad i spelarraden,
   så kontrollerna finns kvar utan att leta i biblioteket. */
async function restoreNowPlaying() {
  const raw = localStorage.getItem(npKey());
  if (!raw) return;
  try {
    const np = JSON.parse(raw);
    const data = await api(`/api/playlists/${np.plId}/tracks`);
    const idx = data.tracks.findIndex(t => t.file === np.file);
    if (idx < 0) return;
    lib.plId = np.plId;
    lib.plName = data.name;
    lib.tracks = data.tracks;
    lib.idx = idx;
    const t = data.tracks[idx];
    audio.src = `/api/playlists/${lib.plId}/stream/` +
      encodeURIComponent(t.file);
    audio.addEventListener("loadedmetadata", () => {
      if (np.pos && np.pos < (audio.duration || 0) - 2) {
        audio.currentTime = np.pos;
      }
    }, { once: true });
    setPlayerBar(t);
    $("player-time").textContent =
      `${fmtTime(np.pos || 0)} / ${fmtTime(t.duration)}`;
  } catch {
    localStorage.removeItem(npKey());
  }
}

/* Klick på låten i spelarraden → hoppa till rätt spellista i biblioteket */
async function jumpToPlaying() {
  if (lib.plId == null) return;
  setTab("library");
  await openLibPlaylist(lib.plId);
  const row = document.querySelector(".trackrow.playing");
  if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
}
$("player-cover").addEventListener("click", jumpToPlaying);
document.querySelector(".player-meta").addEventListener("click", jumpToPlaying);

function stopPlayer() {
  audio.pause();
  audio.removeAttribute("src");
  $("player").hidden = true;
  document.body.classList.remove("has-player");
  lib.idx = -1;
}

$("player-play").addEventListener("click",
  () => audio.paused ? audio.play() : audio.pause());
$("player-prev").addEventListener("click", () => playTrack(lib.idx - 1));
$("player-next").addEventListener("click", () => playTrack(lib.idx + 1));
audio.addEventListener("play", () => {
  $("player-cassette").classList.add("spinning");
  $("player-play").textContent = "⏸";
  document.body.classList.remove("audio-paused");
});
audio.addEventListener("pause", () => {
  $("player-cassette").classList.remove("spinning");
  $("player-play").textContent = "▶";
  document.body.classList.add("audio-paused");
  saveNowPlaying();
});
audio.addEventListener("ended", () => {
  if (lib.idx + 1 < lib.tracks.length) playTrack(lib.idx + 1);
  else {
    $("player-cassette").classList.remove("spinning");
    $("player-play").textContent = "▶";
  }
});
let lastSave = 0;
audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  if (!seekDragging) {
    $("player-seek").value =
      Math.round(audio.currentTime / audio.duration * 100);
  }
  $("player-time").textContent =
    `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
  if (Date.now() - lastSave > 3000) {
    lastSave = Date.now();
    saveNowPlaying();
  }
});
$("player-seek").addEventListener("input", () => { seekDragging = true; });
$("player-seek").addEventListener("change", () => {
  if (audio.duration) {
    audio.currentTime = audio.duration * $("player-seek").value / 100;
  }
  seekDragging = false;
});
$("lib-back").addEventListener("click", loadShelf);
$("lib-playall").addEventListener("click", () => playTrack(0));

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
  stopPlayer();
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
