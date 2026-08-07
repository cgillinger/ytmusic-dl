# 📼 Musik till spelaren (ytmusic-dl)

> **In English:** Self-hosted web app for a Synology NAS that downloads
> YouTube Music playlists as MP3s into each family member's own home folder,
> formatted for a classic MP3 player (Shanling M0s) — with a built-in library
> view and in-browser player. The app UI is in Swedish, and so is the rest of
> this README.

En självhostad webbapp för familjens NAS: klistra in en YouTube
Music-spellista och få den nedladdad som MP3 rakt in i din egen hemkatalog,
färdigformaterad för en klassisk mp3-spelare. Byggd för att en datorovan
14-åring ska kunna använda den utan instruktioner — och för att en förälder
ska slippa underhålla den.

![Huvudvyn — pågående hämtning med snurrande kassettrullar](docs/screenshots/huvudvyn.png)

## Vad den gör

- **Klistra in en länk → få MP3:or.** Bästa tillgängliga ljudkvalitet, rena
  ID3-taggar och kvadratiskt beskuret inbäddat omslag (som små spelarskärmar
  visar bäst).
- **Flera användare utan kontokrångel.** Profiler mappar 1:1 mot NAS:ens
  hemkataloger (`/volume2/homes/<användare>`). Nya Synology-konton dyker upp
  automatiskt. Lösenord är valfritt per profil — tomt fält ger
  ettklicksprofil.
- **Rätt filägare.** Varje nedladdningsjobb körs som profilägarens uid/gid,
  så filerna är direkt redigerbara över SMB.
- **Inkrementell.** Ett arkiv per spellista gör att omkörningar bara hämtar
  nya låtar. En växande spellista är grundanvändningsfallet.
- **Numret på disk = spårets position i spellistan, alltid.** En id→fil-karta
  per mapp numrerar om filerna när listan ändras. Låtar som strukits ur
  listan behåller sin fil men förlorar numret.
- **"Spellistan är sanningen"** (kryssruta per spellista, av som standard):
  låtar som stryks ur spellistan **raderas** från hårddisken vid nästa
  hämtning — och försvinner från mp3-spelaren nästa gång man kopierar dit.
  Läggs låten tillbaka i listan hämtas den om. En spellista som plötsligt
  läses som tom raderar aldrig något (skydd mot API-hicka). Avstängt gäller
  raden ovanför: strukna låtar ligger kvar, bara utan nummer.
- **Mp3-spelarläge** (per spellista, på som standard): numrerade filnamn
  (`001 - Artist - Titel.mp3`) plus en `.m3u` med relativa sökvägar så som
  Shanling M0s vill ha den. Av ger rena `Artist - Titel.mp3`-filer.
- **Bibliotek med spelare.** Hylla med spellistorna som omslagscollage,
  spårlistor med skivomslag, faktaruta per låt (artist, titel, längd,
  ljudkvalitet, filstorlek, hämtdatum) och en fast mini-spelare — kassettens
  rullar snurrar medan musiken spelar. Senast spelade låten överlever
  sidladdningar.
- **Självläkande nedladdningar.** Borttagna videor ersätts automatiskt med
  en annan utgåva av samma låt (längdmatchning, officiella uppladdningar
  premieras) — och omslaget hämtas då från originalspåret eller iTunes så
  det blir albumkonst, inte en videoruta.
- **YouTube-konto, valfritt per profil** (cookies.txt): låser upp kontolåsta
  spår och privata spellistor, och med Premium-prenumeration blir ljudet
  256 kbit/s. Som standard används kontot bara när anonym hämtning nekas.
- **Snäll mot YouTube och NAS:en.** En sekventiell hämtningskö med slumpade
  pauser mellan låtarna — och tydlig kö-status i UI:t, med avbryt-knapp.
- **Självuppdaterande yt-dlp** vid varje containerstart plus en knapp i UI:t;
  arbetaren läser in yt-dlp färskt per jobb, så uppdateringar gäller utan
  omstart.
- **Kopiera direkt till spelaren.** I Chrome/Edge över HTTPS synkar en knapp
  bara nya låtar rakt till minneskortet (File System Access API) och städar
  bort omdöpta gamla filer. Mappvalet görs bara första gången — kortet får
  en markörfil som id och webbläsaren minns handtaget. Efter synken visas
  bara det som återstår på spelaren: förstagångsstegen (biblioteksskanning)
  tills markörfilen på kortet säger att de är gjorda — sedan bara "spela
  via Folders", som alltid är färsk utan importsteg. Stämmer därmed även
  när en annan dator (Linux eller Windows) senast synkade. Efter synken
  erbjuds kortstädning: mappar som inte längre hör till någon spellista och
  datorns kvarglömda papperskorg (.Trash-1000/$RECYCLE.BIN — där ligger
  "raderade" filer som spelaren annars fortsätter spela) listas med
  kryssrutor och tas bort först efter bekräftelse.
- **Begripliga fel på svenska.** Privat spellista? Bot-kontroll? Avbruten av
  omstart? Appen förklarar vad som hänt och vad man gör åt det, där man
  tittar.

![Biblioteket — spårlista med omslag och spelare](docs/screenshots/biblioteket.png)

![Profilvalet](docs/screenshots/profilvalet.png)

## Hur den funkar

FastAPI-backend + vanilla JS-frontend i en enda container. Nedladdningar via
[yt-dlp](https://github.com/yt-dlp/yt-dlp) som bibliotek med ffmpeg för
MP3-konvertering och omslagsinbäddning; Deno finns i imagen för yt-dlp:s
JavaScript-utmaningslösare (krävs för inloggade sessioner). Jobben köas och
körs ett i taget av en arbetarprocess som byter till profilägarens
uid/gid innan något skrivs. Profiler och jobbhistorik ligger i en liten
SQLite-databas.

Utdatastruktur per användare:

```
<hem>/Musik/Spelaren/
  <Spellistans namn>/
    001 - Artist - Titel.mp3
    _archive.txt              ← dubblettskydd (yt-dlp-format)
    _tracks.json              ← id→fil-karta för omnumrering
  _explaylist_data/
    <Spellistans namn>.m3u    ← relativa sökvägar, regenereras varje körning
```

Kopiera `Musik/Spelaren/` till spelarens minneskort som den är —
mappstrukturen speglar kortet.

## Kom igång

Kräver en Docker-värd med de hemkataloger som ska serveras. Appen är byggd
kring **Synologys användarhantering** (se nedan), men kan köras i andra
miljöer — se [Andra miljöer än Synology](#andra-miljöer-än-synology).

### Enklast: färdig Docker-image

En färdigbyggd image publiceras automatiskt till GitHub Container Registry
vid varje ändring i det här repot:
**`ghcr.io/cgillinger/ytmusic-dl:latest`** (x86_64 och ARM64). Du behöver
alltså inte bygga något själv.

Skapa en mapp för tjänsten (t.ex. `/volume1/docker/ytmusic-dl`) med en
undermapp `data` och den här `docker-compose.yml`:

```yaml
services:
  ytmusic-dl:
    image: ghcr.io/cgillinger/ytmusic-dl:latest
    container_name: ytmusic-dl
    ports:
      - "8201:8201"
    volumes:
      - /volume2/homes:/homes   # anpassa till din homes-volym
      - ./data:/data
    environment:
      - TZ=Europe/Stockholm
    restart: unless-stopped
```

Starta med `docker compose up -d` — eller helt utan terminal i **Synologys
Container Manager**: lägg mappen och filen på plats med File Station, öppna
Container Manager → **Projekt** → **Skapa**, peka på mappen och välj den
befintliga compose-filen. (Undermappen `data` måste finnas innan första
starten — Synology skapar inte bind-monteringskataloger åt dig.)

Öppna sedan `http://<värd>:8201`, skapa en profil, klistra in en
spellistlänk.

**Uppdatera till senaste versionen:**

```bash
docker compose pull && docker compose up -d
```

I Container Manager: fliken **Avbild** visar en uppdateringssymbol när en
nyare image finns — uppdatera den där och starta om projektet.

### Alternativ: bygg själv från källkoden

```bash
git clone https://github.com/cgillinger/ytmusic-dl.git
cd ytmusic-dl
mkdir data          # måste finnas före första starten (Synology skapar den inte)
docker compose up -d --build
```

### Konfiguration (miljövariabler)

| Variabel | Standard | Syfte |
|----------|----------|-------|
| `HOMES_DIR` | `/homes` | Var hemkatalogerna är monterade |
| `DATA_DIR` | `/data` | SQLite-databas + sessionshemlighet + cookies |
| `PORT` | `8201` | HTTP-port |
| `HOMES_EXCLUDE` | *(tom)* | Kommaseparerade konton som döljs i profilväljaren (`admin`/`guest` döljs alltid) |

Lägg platsspecifika värden i en `docker-compose.override.yml` (gitignorad).

### Synology-noter

Appen har ingen egen kontodatabas — den är byggd för att **NAS:ens konton
är kontona**. Profilväljaren är en listning av hemkatalogerna i den
monterade homes-mappen, och varje nedladdningsjobb körs med den uid/gid som
äger katalogen. Skapa ett nytt konto i DSM så dyker profilen upp av sig
själv; ta bort kontot så försvinner den.

- Compose-filen monterar `/volume2/homes` — anpassa till din volym.
- Containern måste köra som **root** (den byter användare per jobb); lägg
  inte till något `user:`-direktiv.
- För "Kopiera till mp3-spelare"-knappen krävs HTTPS: lägg en omvänd
  proxy-regel i DSM (Kontrollpanelen → Inloggningsportal → Avancerat →
  Omvänd proxy) från en HTTPS-port till `http://localhost:8201`.
  Självsignerat certifikat räcker — exponera ingenting mot internet.

### Andra miljöer än Synology

Det Synology-specifika är egentligen bara sökvägen `/volume2/homes` och
HTTPS-tipset ovan. Allt appen kräver av värden är:

1. **En katalog med en undermapp per användare**, monterad på `/homes` i
   containern. Undermappens namn blir profilnamnet.
2. **Att varje undermapp ägs av rätt unix-konto** — jobben körs som mappens
   ägar-uid/gid, så det är ägarskapet på disk som styr vem filerna tillhör.
3. **Att containern får köra som root** (den byter till profilägaren per
   jobb).

Det gör att den fungerar direkt på t.ex. en vanlig Linux-server: montera
`/home:/homes` i `docker-compose.override.yml` så listas maskinens konton
precis som på en Synology. Mappar som börjar med `@` eller `.` hoppas över,
liksom `admin`/`guest` och allt i `HOMES_EXCLUDE`.

**Enanvändarbruk:** peka `HOMES_DIR`-monteringen på valfri katalog som
innehåller en enda mapp ägd av dig — profilväljaren visar då bara den.

**Fungerar sämre:** Docker Desktop på macOS/Windows, där bind-monteringar
inte bevarar unix-ägarskap per användare. Nedladdningarna funkar, men
"rätt filägare"-egenskapen förlorar sin mening och alla profiler får samma
ägare.

## Spotify-spellistor

Klistra in en Spotify-länk (spellista, album eller enskilt spår) så läser
appen **metadata** via Spotifys officiella API och hämtar ljudet **från
YouTube** — samma modell som spotDL. Spotifys strömmar rörs aldrig (de är
DRM-skyddade; att rippa dem vore både olagligt på ett annat sätt och en
risk för kontot). Matchningen sker på artist + titel med längdkontroll,
och omslagen tas från Spotifys albumkonst. Ärlig brasklapp: matchning via
sök kan någon gång välja fel utgåva (radio edit i stället för
albumversion) — biblioteksspelaren gör det lätt att kontrollyssna.

Kräver gratis API-nycklar: skapa en app på
[developer.spotify.com](https://developer.spotify.com/dashboard) och lägg
`SPOTIFY_CLIENT_ID` och `SPOTIFY_CLIENT_SECRET` i
`docker-compose.override.yml`. Utan nycklar förklarar appen vad som saknas
när någon klistrar in en Spotify-länk.

## Om privata spellistor

YouTube Music-spellistor är **privata som standard**, och sådana kan inte
läsas anonymt. Två lösningar: sätt listan till **Olistad** (⋮ → Redigera
spellista → Sekretess — fortfarande dold för alla utan länken), eller koppla
ett YouTube-konto till profilen. Cookie-exporten görs säkrast från ett
inkognitofönster som stängs efteråt (tillägget *Get cookies.txt LOCALLY*
länkas med steg-för-steg-guide direkt i appen).

## Juridik

Verktyget är avsett för **privat bruk** (i Sverige: privatkopiering enligt
12 § upphovsrättslagen). Nedladdning från YouTube kan bryta mot YouTubes
användarvillkor och rättsläget skiljer sig mellan länder — du ansvarar
själv för hur du använder programvaran. Inte anslutet till YouTube eller
Shanling.
