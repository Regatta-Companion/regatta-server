# Sessie-analyse voor losse zeiltochten — ontwerp

*Datum: 2026-07-08 · Status: goedgekeurd door Frans*

## Doel

Een losse avond zeilen (geen wedstrijd) verschijnt nu als kale track op het
dashboard: een statische kaart met vier getallen. Dit ontwerp geeft zo'n
sessie een volwaardige analysepagina die zowel het verhaal van de avond
vertelt (logboek) als technisch inzicht geeft (beter leren zeilen). Dezelfde
pagina is ook per boot vanuit een wedstrijd te openen.

## Uitgangspunten

- **Windrichting in tracks is onbetrouwbaar** — de analyse schat de wind uit
  het zeilpatroon en biedt altijd een handmatige correctie.
- **Analyse draait in de browser** (aanpak A): de windcorrectie-schuif moet
  rakken en cijfers direct laten meebewegen, zonder server-rondgang. Tracks
  zijn klein (duizenden punten), dus dit kan ruim.
- **Geen nieuwe endpoints, geen databasewijzigingen.** Punten komen uit de
  bestaande endpoints; de windcorrectie per track staat in `localStorage`.

## Navigatie

| Vanwaar | Link | Databron |
|---|---|---|
| Dashboard, losse track | `sessie.html?track=<id>` | `GET /api/tracks/:id/points` (eigenaar-only — losse sessies blijven privé) |
| Wedstrijd, per boot ("Analyse"-knop in bootlijst) | `sessie.html?track=<id>&race=<raceId>` | `POST /api/races/:raceId/compare-data` (zelfde zichtbaarheid als Vergelijk) |
| Oude links `race.html?track=<id>` | redirect naar `sessie.html?track=<id>` | — |

De sessiepagina is een detailpagina, geen vijfde tab in de navigatie. Na deze
wijziging doet race.html nog maar één ding: wedstrijden tonen.

## Analyse-pipeline (`web/session-analysis.js`)

Eén DOM-vrij bestand met pure functies (input: puntenlijst
`[{lat, lon, time, speed_kn}]`), zodat het zowel in de browser als onder
`node:test` draait.

1. **Koersen** — heading per punt, gladgestreken over ~5 punten.
2. **Windschatting** — histogram van koersen, gewogen naar tijd, alleen
   segmenten met snelheid > 2 kn (sluit dobberen/drijven uit). Kruisrakken
   vormen twee dominante koerspieken 70–110° uit elkaar; wind = bissectrice
   van de twee aan-de-windse koersen. Levert `{direction_deg, confidence}`; geen kruispatroon → lage
   confidence, wind onbekend.
3. **Handmatige correctie** — kompasschuif op de pagina; override wordt per
   track bewaard in `localStorage` en herrekent stap 4–6 direct.
4. **Rakken** — track opgeknipt bij koersveranderingen; per rak: gemiddelde
   koers, windhoek-categorie (aan de wind < 60° TWA, halve wind 60–120°,
   ruime wind 120–160°, voor de wind > 160°), afstand, duur, gem./max
   snelheid.
5. **Manoeuvres** — koersverandering > 60° binnen ~15 s. Boeg door de wind
   (heading passeert windrichting) → overstag; achterschip erdoor → gijp.
   Per manoeuvre: positie, tijdstip, snelheidsverlies (minimum in venster
   t.o.v. gemiddelde ervoor) en hersteltijd.
6. **Rapport** — beste 10 seconden (rollend venster), langste rak,
   opkruishoek (hoek tussen bakboord- en stuurboord-kruiskoersen), aantal
   overstag/gijp met gemiddeld verlies, tijd- en afstandsverdeling per punt
   van zeil.

## Pagina-opbouw (`web/sessie.html`)

Van boven naar beneden:

1. **Header** — tracknaam, datum, kernstats (max/gem/afstand/duur), zelfde
   stijl als bestaande pagina's.
2. **Kaart + playback** — zoals de race-weergave, maar de track gekleurd per
   raktype; windpijl in de hoek; klikbare manoeuvre-markers (⤴ overstag,
   ⤵ gijp) die de playback naar dat moment springen.
3. **Windpaneel** — geschatte richting + betrouwbaarheid, kompasschuif voor
   correctie; alles kleurt/rekent direct mee.
4. **Snelheidsgrafiek** — hele sessie, manoeuvres als stippen; klik springt
   naar dat moment in de playback.
5. **Avondrapport** — hoogtepuntkaartjes (beste 10 s, langste rak,
   opkruishoek, manoeuvres + gemiddeld verlies), rakkentabel, staafje met
   tijdverdeling per punt van zeil.

## Randgevallen

- **Geen tijdstempels** → geen snelheid/playback: alleen kaart + afstand met
  nette melding.
- **Geen kruispatroon** (alleen ruim gevaren of gemotord) → windafhankelijke
  secties tonen "Windrichting onbekend — stel handmatig in" i.p.v.
  onzin-cijfers.
- **Korte tracks** (< ~5 min of < 100 punten) → alleen basisweergave, geen
  rapport.

## Testen

- `node:test`-suite voor `session-analysis.js` met synthetische tracks
  (gegenereerde zigzag met bekende wind): windschatting binnen ±10°, exact
  aantal manoeuvres, juiste raktype-classificatie. Eerste testsuite van het
  project; draait via `npm test`.
- Browserverificatie met lokale server (zoals eerdere fixes: registreren,
  track uploaden, sessiepagina doorlopen).

## Buiten scope

- Vergelijken van sessies onderling of seizoensstatistieken over meerdere
  sessies (mogelijk vervolg).
- Windsterkte (alleen richting wordt geschat).
- Wijzigingen aan de mobiele app of Garmin-kant.
