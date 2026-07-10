# Live wedstrijdverloop op de vergelijk-pagina — ontwerp

*Datum: 2026-07-10 · Status: goedgekeurd door Frans*

## Doel

De vergelijk-pagina toont nu 2–4 boten met snelheidsgrafiek en basisstats,
maar beantwoordt de wedstrijdvraag niet: **wie ligt wanneer voor, en met
hoeveel?** Dit ontwerp voegt live wedstrijdverloop toe voor de hele klasse:
een ranglijst die meebeweegt met de playback, achterstanden in meters langs
het parcours, boeirondingen als tussentijden, en actuele snelheid + VMG per
boot.

## Uitgangspunten

- **Parcours uit bestaande boeien.** Races hebben (meestal) boeien in
  `race_marks` (met `sort_order`), bereikbaar via het bestaande
  `GET /api/races/:id/marks`. Voortgang wordt gemeten in meters langs dat
  parcours — de eerlijkste maat voor "voor liggen".
- **Berekening in de browser** (zelfde argument als de sessie-analyse): de
  playback-interactie vereist de puntdata toch client-side. Alle rekenlogica
  komt als pure functies in `web/session-analysis.js` en is testbaar met
  `node:test`.
- **Minimale serverwijziging, geen databasewijziging.**

## Serverwijziging (routes/races.js, compare-data)

- Limiet op `POST /api/races/:id/compare-data` gaat van 4 naar **20**
  track-ids.
- Bij **meer dan 6** gevraagde tracks dunt de server elke track uit tot
  **maximaal 2.000 punten** (elke n-de punt; eerste en laatste punt blijven
  altijd behouden). Bij ≤ 6 tracks verandert er niets aan de respons.
- Bestaande clients (2–4 boten) merken niets.

## Parcours-motor (`web/session-analysis.js`, nieuwe pure functies)

1. **`courseFromMarks(marks)`** → `{ marks, legs, cum_distance_m[], total_distance_m }`
   of `null` bij minder dan 2 boeien. Boeien gesorteerd op `sort_order`;
   rakken tussen opeenvolgende boeien; cumulatieve afstand per boei.
2. **`computeProgress(points, course)`** → `{ progress_m[], roundings[] }`.
   Rondingsdetectie: een boot rondt de eerstvolgende boei zodra hij binnen
   **60 m** komt — alleen in parcoursvolgorde (een boei die later nogmaals
   gepasseerd wordt telt niet dubbel). Voortgang per punt = cumulatieve
   afstand van geronde rakken + (raklengte − hemelsbrede afstand tot de
   volgende boei), geklemd zodat hij nooit terugloopt (monotoon
   niet-dalend). Rondingen: `{ markIdx, pointIdx, time }`.
3. **`computeVMG(speedKn, headingDeg, boatLat, boatLon, targetLat, targetLon)`**
   → knopen: `speed × cos(hoekverschil tussen koers en peiling naar doel)`.
   Negatief wanneer de boot van de boei af vaart.
4. **`gapSeries(progressPerBoat, sampleStepS)`** → gedeelde tijdas
   (bemonstering elke ~5 s over de overlappende periode): per tijdstip is de
   **leider** de boot met de meeste voortgang; gap per boot = leider-voortgang
   − eigen voortgang (meters, leider = 0). Voedt zowel de live ranglijst
   (opzoeken bij playback-tijd) als de gap-grafiek.

Koers per punt komt uit het bestaande `computeHeadings`.

## Schermopbouw (web/race-compare.html)

- **Botenselectie**: bestaande chips; standaard zijn **alle boten van de
  gekozen klasse** geselecteerd (tot 20). Aan/uitzetten filtert kaart,
  ranglijst en grafieken tegelijk.
- **Live ranglijst** bij de kaart: per rij positienummer, kleurstip,
  bootnaam, achterstand op de leider (m), actuele snelheid (kn) en VMG (kn)
  richting volgende boei. Sorteert live mee met de playback; klik op een rij
  highlight de boot op de kaart.
- **Gap-grafiek** onder de snelheidsgrafiek: één lijn per boot,
  verticale as = achterstand op de leider (0 = leiding). Boeirondingen als
  verticale streepjes. Klik springt de playback naar dat moment (zelfde
  gedrag als de snelheidsgrafiek).
- **Rondingentabel**: rijen = boeien in parcoursvolgorde, kolommen = boten
  in rondingsvolgorde, met kloktijd en achterstand-bij-ronding. Klik op een
  cel springt naar dat moment.
- Bestaande statkaartjes en snelheidsgrafiek blijven ongewijzigd.

## Randgevallen

- **Geen of één boei** → ranglijst, gap-grafiek en rondingentabel verschijnen
  niet; één melding: "Geen parcours ingetekend — vraag de wedstrijdleiding
  boeien toe te voegen". De rest van de pagina werkt zoals nu.
- **Boot zonder tijdstempels** → uitgesloten van de live vergelijking, met
  aanduiding in de bootlijst.
- **Boot rondt een boei nooit** (uitvaller/GPS-gat) → blijft gerangschikt op
  laatste voortgang; rondingentabel toont een streepje.
- **Uitdunning is veilig voor rondingsdetectie**: bij max 2.000 punten over
  1–2 uur ligt er elke ~3–4 s een punt; bij 6 kn is dat ~12 m tussen punten,
  ruim binnen de 60 m-drempel.
- **Meer dan 20 boten** → de eerste 20 met melding (vangrail, geen feature).

## Testen

- `node:test`-uitbreiding: synthetisch parcours (3 boeien, bekende
  afstanden) + twee synthetische boten waarvan één 60 s later start →
  exacte rondingsvolgorde, monotone voortgang, gaps op de meter kloppend,
  VMG-teken correct (naar de boei positief, ervan af negatief).
- Server: compare-data met 8 tracks → uitgedund (≤ 2.000 punten/boot, eerste
  en laatste punt aanwezig); met 3 tracks → identiek aan huidig gedrag;
  met 21 tracks → 400-fout.
- Browserverificatie met lokale server: race met boeien + meerdere
  synthetische boten; playback draaien; ranglijst-sortering, gap-grafiek en
  rondingstreepjes controleren.

## Buiten scope

- Windas-terugval voor races zonder boeien (aanpak C) — kan later.
- Tijd-gaps in seconden (alleen meters in deze versie).
- Handicap/rating-correcties (SW/ORC).
- Wijzigingen aan race.html (één-boot-weergave) of de mobiele app.
