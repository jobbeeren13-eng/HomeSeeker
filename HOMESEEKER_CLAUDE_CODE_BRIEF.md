# HomeSeeker — Project Brief voor Claude Code

## Wat is HomeSeeker?

HomeSeeker is een Nederlandse woningalert service. Gebruikers betalen €12,50 per maand en krijgen via Telegram real-time meldingen zodra er een nieuwe woning op Funda verschijnt die aan hun persoonlijke filters voldoet. De service is volledig in het Engels en gericht op expats, starters en doorstromers in Nederland.

De huidige stack draait via Make (no-code automation), Apify (scraping), Telegram Bot API en Stripe. Jij gaat dit opnieuw bouwen als één eigen applicatie in Node.js — goedkoper, sneller en volledig in controle.

---

## Hoe het systeem werkt

1. Een gebruiker gaat naar de website, klikt op "Start free trial" en betaalt via Stripe (€12,50/maand, eerste week gratis proefperiode).
2. Na betaling krijgt de gebruiker een instructie-email: open Telegram, stuur /start naar de HomeSeeker bot, en vul je filters in via een persoonlijke link.
3. De Telegram bot slaat de chat_id op in de database gekoppeld aan de gebruiker.
4. Het filterformulier (HTML pagina) stuurt alle filters op naar de server: stad, huur of koop, max prijs, inkomen, kamers, etc.
5. Elke 15 minuten scrapet de server nieuwe woningen van Funda via de Apify API (actor: memo23/funda-scraper), voor 7 steden × koop + huur = 14 URLs tegelijk in één run.
6. De server matcht elke nieuwe woning met alle gebruikers in de database op basis van hun filters.
7. Per match wordt een kans score berekend (0–100) en een Telegram alert gestuurd met alle details.
8. Een duplicate check voorkomt dat dezelfde woning twee keer verstuurd wordt.

---

## De kans score (0–100)

Elke alert bevat een persoonlijke kans score die aangeeft hoe groot de kans is dat de gebruiker deze woning kan krijgen.

- **Basis:** 20 punten
- **Inkomen ratio** (inkomen vs huurprijs of hypotheek): max 35 punten
  - Voor huur: inkomen moet minimaal 3× de maandhuur zijn
  - Voor koop: inkomen × 4,5 = maximale hypotheek
- **Document readiness:** max 20 punten
  - "klaar" = 20, "bijna" = 12, "bezig" = 6, "niet" = 0
- **Prijs fit** (hoe ver de woning onder de max prijs van de gebruiker zit): max 20 punten
- **Timing/urgency** (hoe snel na plaatsing de alert wordt gestuurd): max 5 punten
- **Totaal: max 100**

Kans labels:
- 🔴 0–39: Very Low
- 🟠 40–54: Low
- 🟡 55–69: Fair
- 🟢 70–84: Good
- ✅ 85–100: Excellent

---

## De Telegram alert — hoe hij eruitziet

Elke alert bevat:
- Adres, stad, prijs
- Kans score badge (bijv. 🟢 Good — 78%)
- Filters die matchen (kamers, m², energielabel etc.)
- Link naar de woning op Funda
- **Drie inline knoppen:**
  1. 🔗 View listing (link naar Funda)
  2. ✉️ Reply with AI letter (zie hieronder)
  3. ❌ Unsubscribe

---

## De AI motivatiebrief knop (één klik)

Wanneer een gebruiker op "Reply with AI letter" klikt in Telegram:
1. De bot stuurt een formulier of reeks vragen: naam, huidige woonsituatie, reden voor verhuizing, werksituatie, eventuele huisdieren.
2. Claude (Anthropic API) genereert een professionele motivatiebrief in het Nederlands gericht aan de verhuurder/makelaar voor die specifieke woning.
3. De brief wordt direct in Telegram getoond zodat de gebruiker hem kan kopiëren en versturen.

---

## Filterformulier — alle velden

Het filterformulier (filters.html) stuurt de volgende data op naar de server:

- `naam` — voornaam
- `email` — emailadres
- `chat_id` — Telegram chat ID (meegegeven via URL parameter)
- `profiel_type` — starter / expat / doorstromer / anders
- `expat_status` — EU / non-EU (alleen voor expats)
- `contract_type` — vast / tijdelijk / zzp / student
- `inkomen` — bruto maandinkomen in euro
- `document_readiness` — klaar / bijna / bezig / niet
- `beschikbaarheid_timing` — direct / 1maand / 3maanden / flexibel
- `type` — koop / huur / beide
- `woningtype` — alle / huis / appartement
- `locatie` — stad (bijv. amsterdam, rotterdam, haarlem)
- `prijs_min` — minimale prijs in euro
- `prijs_max` — maximale prijs in euro (verplicht)
- `opp_min` — minimale oppervlakte in m²
- `kamers_min` — minimaal aantal kamers
- `energielabel` — A/B/C/D/E/F/G of geen voorkeur
- `bouwjaar_min` — minimaal bouwjaar
- `tuin` — true/false
- `parkeren` — true/false
- `delen_toegestaan` — true/false
- `huisdieren` — true/false (alleen huur)
- `gemeubileerd` — true/false (alleen huur)
- `beschikbaar_per` — datum

Voeg ook toe: `kans_min` — minimale kans score filter (50 / 60 / 70 / geen voorkeur). Gebruikers krijgen dan alleen alerts als de kans score boven dit percentage ligt.

---

## Database structuur

Gebruik SQLite (of PostgreSQL op Railway). Drie tabellen:

**users**
- chat_id (primary key)
- naam, email, profiel_type, expat_status, contract_type
- inkomen, document_readiness, beschikbaarheid_timing
- type, woningtype, locatie, prijs_min, prijs_max
- opp_min, kamers_min, energielabel, bouwjaar_min
- tuin, parkeren, delen_toegestaan, huisdieren, gemeubileerd
- beschikbaar_per, kans_min
- betaald (boolean), stripe_customer_id, trial_start_date
- actief (boolean)

**sent_listings**
- url (primary key) — duplicate check
- chat_id
- sent_at

**telegram_chats**
- chat_id
- registered_at

---

## Apify scraping setup

Gebruik de Apify API om de actor `memo23/funda-scraper` te runnen.

Input body voor één run (alle 7 steden tegelijk):
```json
{
  "startUrls": [
    {"url": "https://www.funda.nl/zoeken/koop/?selected_area=[\"amsterdam\"]"},
    {"url": "https://www.funda.nl/zoeken/huur/?selected_area=[\"amsterdam\"]"},
    {"url": "https://www.funda.nl/zoeken/koop/?selected_area=[\"rotterdam\"]"},
    {"url": "https://www.funda.nl/zoeken/huur/?selected_area=[\"rotterdam\"]"},
    {"url": "https://www.funda.nl/zoeken/koop/?selected_area=[\"den-haag\"]"},
    {"url": "https://www.funda.nl/zoeken/huur/?selected_area=[\"den-haag\"]"},
    {"url": "https://www.funda.nl/zoeken/koop/?selected_area=[\"utrecht\"]"},
    {"url": "https://www.funda.nl/zoeken/huur/?selected_area=[\"utrecht\"]"},
    {"url": "https://www.funda.nl/zoeken/koop/?selected_area=[\"haarlem\"]"},
    {"url": "https://www.funda.nl/zoeken/huur/?selected_area=[\"haarlem\"]"},
    {"url": "https://www.funda.nl/zoeken/koop/?selected_area=[\"amstelveen\"]"},
    {"url": "https://www.funda.nl/zoeken/huur/?selected_area=[\"amstelveen\"]"},
    {"url": "https://www.funda.nl/zoeken/koop/?selected_area=[\"delft\"]"},
    {"url": "https://www.funda.nl/zoeken/huur/?selected_area=[\"delft\"]"}
  ],
  "maxItems": 50,
  "proxy": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

Run elke 15 minuten via een cron job op de server. Na elke run: haal de dataset op, loop door alle resultaten, match met gebruikers, stuur alerts.

---

## Stripe & betalingen

- Prijs: €12,50 per maand
- Eerste week gratis proefperiode
- Na 7 dagen start het abonnement automatisch
- Webhook van Stripe zet `betaald = true` in de database zodra betaling succesvol is
- Gebruikers die niet betalen na de proefperiode krijgen geen alerts meer

---

## Website (index.html) — aanpassingen

De huidige index.html heeft een strak donker design met groene accenten (#00e5a0), Bebas Neue + Outfit fonts. Behoud dit volledig. Pas de volgende dingen aan:

1. **Prijs aanpassen** van €9,99 naar €12,50 per maand overal op de pagina
2. **Tekst aanpassen**: verwijder verwijzingen naar specifieke platforms (Funda, Pararius). Vervang door: "We monitor all relevant Dutch housing platforms — you won't miss a thing."
3. **Timing tekst aanpassen**: vervang "within 2 minutes" door "within minutes of a new listing going live"
4. **FAQ aanpassen**: verwijder de vraag "Which platforms are monitored?" of vervang het antwoord door: "We scrape all major Dutch housing platforms continuously. You get one alert, regardless of where the listing appeared."
5. **Disclaimer toevoegen** op een logisch punt (bijv. onder de pricing sectie of bij de CTA knop): "7-day free trial. After your trial, your subscription continues at €12.50/month. No refunds after the trial period ends. Cancel anytime before the trial ends via the link in your confirmation email."
6. **Privacy policy pagina** aanmaken (privacy.html) en de footer link ernaar laten wijzen
7. **Support email** in de footer: homeseeker@gmail.com (staat al, behouden)

---

## Filterformulier (filters.html) — aanpassingen

De huidige filters.html heeft een strak donker design. Behoud het volledig. Voeg toe:

1. **Kans score filter** — nieuw veld: "Minimum chance score" met opties: No preference / 50%+ / 60%+ / 70%+
2. **Info-icoontjes** per veld met een korte tooltip die uitlegt wat het veld betekent
3. **Disclaimer** bovenaan of onderaan het formulier: "By submitting this form you agree to the 7-day free trial terms. After the trial, €12.50/month is charged. No refunds after trial period."
4. De webhook URL moet worden aangepast naar de nieuwe server endpoint

---

## Telegram bot commando's

- `/start` — welkomstbericht + persoonlijke filterlink sturen
- `/stop` of `/unsubscribe` — abonnement pauzeren (actief = false)
- `/filters` — nieuwe filterlink sturen
- `/status` — laten zien of abonnement actief is

---

## Omgevingsvariabelen die nodig zijn

```
APIFY_TOKEN=...
TELEGRAM_BOT_TOKEN=...
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
ANTHROPIC_API_KEY=...
DATABASE_URL=...
BASE_URL=https://jouwdomain.com
```

---

## Wat te bouwen — samenvatting

Bouw een Node.js Express applicatie met:

1. `/` — serveert index.html (website)
2. `/filters` — serveert filters.html (filterformulier)
3. `/webhook/telegram` — Telegram bot handler
4. `/webhook/stripe` — Stripe betaling handler
5. `/api/filters` — POST endpoint voor filterformulier data
6. Cron job elke 15 minuten — Apify run starten, resultaten ophalen, matchen, alerts sturen
7. Database setup (SQLite of PostgreSQL)
8. Kans score berekening module
9. AI motivatiebrief generator via Anthropic API
10. Privacy policy pagina

Zorg dat alles zo goedkoop mogelijk draait — Railway.app free tier of Render.com is voldoende voor de start. Gebruik geen onnodige dependencies.
