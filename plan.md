# plan.md — designresonemang och verifierade fakta

Det här dokumentet är riktat till framtida utvecklingssessioner (mänskliga
eller AI) som ska röra synk-/spelarflödet. README beskriver *vad* appen gör;
här står *varför* — besluten, faktan de vilar på, och fällorna vi redan
gått i så att ingen går i dem igen. Uppdatera dokumentet när beslut ändras.

## Verifierade fakta om Shanling M0s (fysiskt test 2026-08-07)

Testade mot riktig spelare + 64 GB exFAT-kort. Lita på dessa framför
antaganden:

1. **Relativa m3u-sökvägar fungerar.** `../<mapp>/<fil>.mp3` i
   `_explaylist_data/<mapp>.m3u` importeras felfritt. Manualens
   rekommendation om absoluta sökvägar (`A:\...`) behövdes aldrig — båda
   varianterna testades sida vid sida och båda importerade. Skriv inte om
   `write_m3u()` till A:-format "för säkerhets skull"; det relativa
   formatet är dessutom OS-neutralt.
2. **"No music"/"unknown artist" betyder oskannat bibliotek — inte trasiga
   taggar.** My Music-vyn och artist/albumfälten kommer ur spelarens
   interna databas som fylls först vid System → Update Library →
   Update Music. Folders-vyn läser kortet direkt och spelar ändå. Vi
   ödslade felsökningstid på ID3-versionsteorier (v2.3 vs v2.4) — taggarna
   var korrekta hela tiden. Kontrollera biblioteksskanningen FÖRST.
3. **Inställningen Automatic** (under Update Library) skannar om varje gång
   USB-kabeln dras ur. Den är avgörande för att flödet ska vara nollsteg
   i vardagen — därför tjatar förstagångsinstruktionen om den.
4. **Importerade spellistor fryser.** Import kopierar m3u:n in i spelarens
   databas; ändras m3u-filen sedan händer ingenting på spelaren. Enda
   uppdateringsvägen är radera + importera om, manuellt, varje gång.
   Detta går inte att automatisera från en dator — databasen är intern.
5. **Spelaren struntar i punktprefix och "dolda" mappar.** exFAT har inget
   dolt-attribut som spelaren respekterar; `.Trash-1000` skannas som
   vilken mapp som helst.
6. **Spelaren har inget eget musikminne** — allt den spelar ligger på
   kortet. "Musik kvar fast jag raderat" = papperskorgsfällan (se nedan).

## Arkitekturbeslut, med motivering

### Folders-vyn är huvudvägen — inte spelarens spellistfunktion

Följer av fakta 4: en tjänst som kräver manuell omimport efter varje
ändring är oanvändbar för målgruppen. Numreringen (`001 - Artist -
Titel.mp3`, omnumrering vid ordningsändring) gör mappen på kortet till en
exakt kopia av spellistan — så Folders → mappen ÄR spellistan, alltid
färsk. m3u-filen genereras fortfarande (billigt, och den som vill kan
importera), men UI:t leder till Folders och nämner import enbart i den
fullständiga guiden, med varning.

### Markörfil på kortet som identitet — inte USB-id

Webbläsare kan inte läsa USB-VID/PID för lagringsenheter (WebUSB blockerar
mass storage; File System Access-API:t ser bara filer). Därför: en dold fil
`.ytmusic-dl-spelare` i kortets rot ÄR kortets identitet. Mapphandtaget
sparas i IndexedDB; vid synk krävs att handtaget svarar, att skrivlov ges
och att markörfilen finns — annars fall tillbaka till mappväljaren. Det
ger "välj en gång, sedan bara synka" utan någon möjlighet att i tysthet
skriva till fel enhet.

### Kortstatus lagras PÅ kortet (JSON i markörfilen) — inte i webbläsaren

`{spelare, instruerad}` — flaggan styr om förstagångsinstruktionerna
(Update Library m.m.) visas. Poängen: kortet synkas från flera datorer
(Linux + Windows, olika familjemedlemmar). Låg statusen i webbläsaren
skulle varje ny dator börja om med förstagångstjat. Kortet följer
spelaren; det gör statusen också. Notera ödmjukheten: flaggan betyder
"instruktionen har visats", inte "steget är utfört på spelaren" — därför
finns länken "Visa fullständiga instruktioner" alltid kvar i klart-rutan.

### Kortstädningen: aldrig tyst radering, asymmetriska förval

Synk-knappen speglar bara sin egen spellistmapp; mappar vars spellista
tagits bort i tjänsten blev annars kvar för evigt, och datorns
papperskorg (.Trash-1000/$RECYCLE.BIN) samlar "raderade" filer som
spelaren fortsätter spela. Efter varje synk jämförs kortets rot mot
profilens samtliga spellistmappar (`/api/playlists` → `folder`-fältet).
Undantag: `_explaylist_data`, punktmappar, `System Volume Information`.

Förvalen är medvetet asymmetriska: papperskorgen är FÖRKRYSSAD (alltid
skräp per definition — riktiga raderingar går inte via den), okända mappar
är OKRYSSADE (kan vara användarens ljudböcker/annat — appen kan inte
veta). Radering sker bara på explicit knapptryck. Föräldralösa m3u-filer
tas bort automatiskt efteråt — de är genererade artefakter som
återskapas vid varje synk, aldrig användardata.

Känd begränsning: jämförelsen görs mot inloggad profils spellistor. Synkar
två profiler till samma kort flaggas den enas mappar som okända för den
andra — ofarligt (okryssat förval) men värt att veta. Design­antagande:
ett kort per person.

### Språknivån: datorovan 14-åring med smartphonevana

Alla texter i synk-/städflödet är kalibrerade mot någon som kan appar men
aldrig mött filhanterare, USB-utmatning eller mappträd. Konkret:

- Förklaringsrutan visas INNAN mappväljaren öppnas (flödets mest PC-iga
  moment) — man ska veta vad man letar efter innan OS-fönstret dyker upp.
  Teknisk detalj: `showDirectoryPicker()` kräver user activation, så
  väljaren öppnas i förklaringsrutans klickhanterare.
- Varje instruktion säger vad OCH varför ("annars säger spelaren No
  music och kallar artisterna unknown").
- Inga oöversatta facktermer där det går; spelarens egna menynamn
  (Folders, Update Library) behålls dock exakt som de ser ut på skärmen.

Behåll den nivån vid ändringar — hellre en mening till än en term oförklarad.

### Mata ut-steget kan inte byggas in

Ingen web-API får avmontera enheter (medvetet säkerhetsbeslut i
webbplattformen). Appen stänger alla filhandtag innan klart-rutan visas;
Windows kör flyttbara enheter i snabb borttagning som standard (säkert att
dra ur direkt), Linux cachar skrivningar (⏏ gör nytta). Instruktionerna
speglar det. Bygg inte "vänta X sekunder"-magi — det är en falsk garanti.

## Kända fällor (kostade riktig felsökningstid)

- **GNOME/Windows "Radera" på flyttbara enheter raderar inte** — flyttar
  till dold papperskorgsmapp på enheten. Symptom: "kortet är tomt i
  filhanteraren men spelaren spelar musik". Se verifierade fakta 5–6.
- **Statiska filer serveras från rot** (`app.mount("/", ...)`) — appens
  JS är `/app.js`, INTE `/static/app.js`. Verifiera deployer mot rätt URL.
- **Verifiera inte för tidigt efter deploy** — containern behöver några
  sekunder; en curl mitt i omstarten ger tom/gammal respons.
- **Kopiera-knappen kräver säker kontext** (https eller localhost) och
  Chrome/Edge — File System Access-API:t finns inte i Firefox/Safari.
  Fallbacktexten i UI:t förklarar båda fallen.

## Drift

Deployrecept, värdspecifika sökvägar och åtkomstdetaljer ligger medvetet
utanför repot i gitignorade `DRIFT.md` (lokal). Viktigast att veta ändå:
**deploya aldrig medan ett hämtningsjobb kör** — jobbet dödas halvvägs.
Kontrollera kön först (statusarna `queued`/`running` i jobbtabellen).

## Möjliga nästa steg (ej beslutade)

- Fristående "Städa kortet"-knapp (utan att gå via en spellistsynk).
- Markörfilen kan bära mer: t.ex. senaste synktid per spellista för att
  visa "kortet är 3 spellistor efter".
- Fler spelarprofiler än Shanling (markörfilens `spelare`-fält är
  förberett) — kräver fysisk verifiering per modell, se testmetodiken
  under Verifierade fakta.
