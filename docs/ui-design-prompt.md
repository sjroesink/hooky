# Prompt voor Claude Design

Paste alles onder de streep in Claude Design. De data-vormen komen uit `GET /api/events` en
`GET /api/plugins` zoals die nu echt antwoorden, dus het ontwerp gebruikt bestaande veldnamen.

Na het ontwerp: de UI is één HTML-bestand met inline CSS en JS (`src/ui/index.html`), geserveerd door
`src/plugins/ui.ts`. Geen bundler, geen framework. Wat er uit Claude Design komt moet dus in die vorm
terug te bouwen zijn.

---

Ontwerp de webinterface van **Notifier**, een self-hosted webhook-ontvanger. Iets stuurt een POST naar
`/hooks/<naam>`, Notifier maakt daar een genormaliseerd event van en levert dat af aan
notificatiekanalen (Telegram, ntfy, console). Elke call wordt opgeslagen, en aflevering loopt via een
outbox: mislukt een kanaal, dan blijft het event pending en probeert de server het later opnieuw, ook
na een herstart.

## Wie het gebruikt

Één ontwikkelaar die zijn eigen server beheert. Hij opent deze pagina in twee situaties. Eerst: "kwam
die alert wel aan?" Dan wil hij binnen twee seconden zien of de laatste calls zijn afgeleverd en welk
kanaal eventueel faalde. Tweede: "waarom kwam hij niet aan?" Dan wil hij de payload zien, de foutmelding
per kanaal, en de call opnieuw kunnen afvuren.

Het is een technische tool voor één persoon, geen dashboard voor een team. Dichtheid gaat voor
witruimte, maar niet ten koste van leesbaarheid.

## Twee views

### 1. Calls (de hoofdview)

Een lijst van webhook-calls, nieuwste boven, met een filterbalk erboven en een detailweergave voor één
call. De lijst verversst elke 5 seconden.

Per rij zichtbaar: tijdstip, hook-naam, level, titel, welke kanalen het kregen met hun status, en de
uitkomst van de call als geheel. Een replay is als replay te herkennen.

Filters: vrij zoeken in titel en body, hook-naam, level, uitkomst, alleen-pending, en een tijdvak
(laatste uur, dag, week). Plus paginering, want de historie loopt over maanden.

Detail van één call toont alles: de velden, de body, de payload zoals die binnenkwam (JSON), de
afleveringen per kanaal met foutmelding en aantal pogingen, en bij een pending call wanneer de volgende
poging staat. Eén actie: replay.

### 2. Plugins

Notifier is opgebouwd uit plugins, en de UI kan ze aan- en uitzetten. Een tabel met per plugin: id,
module, of hij draait, de config, en een schakelaar. Uitzetten haalt de plugin er live uit, dus een
kanaal stopt meteen met leveren. Dat is een ingreep met gevolgen, laat dat zien.

## De echte data

`GET /api/events?limit=50&level=error&since=24h` geeft:

```json
{
  "total": 412,
  "limit": 50,
  "offset": 0,
  "events": [
    {
      "id": "cd65ba03-a281-4156-a6e3-a5be201e29b3",
      "hook": "deploy",
      "level": "warning",
      "title": "Release naar feature-2 mislukt",
      "body": "Stage 'Deploy tenant stacks' faalde na 4m12s",
      "url": "https://dev.azure.com/innovadisgroep/SHV-Product/_build/results?buildId=88213",
      "tags": ["deploy", "ota"],
      "receivedAt": 1788188932292,
      "replayOf": null,
      "state": "pending",
      "outcome": null,
      "attempts": 3,
      "nextAttemptAt": 1788189021686,
      "deliveries": [
        { "channel": "console", "status": "sent", "attempts": 1 },
        { "channel": "telegram", "status": "failed", "error": "telegram responded 400: chat not found", "attempts": 3 },
        { "channel": "ntfy", "status": "skipped", "reason": "rate limited at 20 per 60000ms" }
      ]
    }
  ]
}
```

Waardes die vast staan:

- `level`: `debug`, `info`, `warning`, `error`, `critical`
- `state`: `pending` (de server probeert nog) of `done`
- `outcome`: `delivered`, `partial` (sommige kanalen namen het aan), `failed`, of `null` zolang pending
- `delivery.status`: `sent`, `failed` (met `error`), `skipped` (met `reason`)

`GET /api/stats` geeft `{ "events": 412, "pending": 3, "outcomes": { "delivered": 400, "partial": 9, "failed": 3 }, "channels": { "telegram": { "sent": 380, "failed": 12 } }, "channels_registered": ["console", "telegram", "ntfy"] }`.

`GET /api/plugins` geeft per plugin `{ "id": "config:telegram", "name": "./src/plugins/channel-telegram.ts", "disabled": false, "state": "active", "config": { "chatId": "-100123", "match": { "minLevel": "warning" } } }`. `state` is `active`, `pending` (wacht op een service die er niet is), `failed`, of `unmounted`.

## Toestanden die je moet ontwerpen

1. Nog geen enkele call. Dit is wat iemand als eerste ziet na het opzetten, dus zet er in dat geval
   het curl-commando bij waarmee hij de eerste call stuurt.
2. Filters actief, geen resultaten.
3. Een pending call met een falend kanaal en een tijdstip voor de volgende poging.
4. Een call met drie kanalen in drie verschillende statussen, zoals in de JSON hierboven.
5. Een lange payload en een lange foutmelding, in het detail. Ze mogen niet uit hun kader lopen.
6. Geen of een afgewezen API-token. De pagina vraagt om een token en bewaart dat in localStorage.
   Ontwerp dat als een nette staat, niet als een browser-prompt.
7. Een plugin in `failed` en een in `pending`, met de reden zichtbaar of opvraagbaar.

## Visuele richting

Technisch en rustig, in de lijn van een goede logviewer. Systeemfont voor tekst, monospace voor ids,
tijden, payloads en foutmeldingen. Werkt in light en dark, gestuurd door de systeemvoorkeur.

Kleur draagt betekenis en niets anders: één kleur voor sent, één voor failed, één voor skipped, één voor
pending. Level is geen kleurenregenboog, alleen `error` en `critical` mogen opvallen. Geen decoratieve
iconen, geen emoji, geen gradients.

De status van een call moet uit de rij te lezen zijn zonder hem te openen. Dat is de belangrijkste eis
aan het ontwerp.

## Randvoorwaarden

- Eén pagina, twee views, geen router en geen inlogscherm.
- Bouwbaar als één HTML-bestand met inline CSS en JS, zonder framework en zonder buildstap. Gebruik
  geen componentbibliotheek en geen externe fonts of iconensets.
- Moet werkbaar zijn op een laptopscherm van 1280 breed, en leesbaar blijven op een telefoon (de
  lijst mag daar in kaarten vallen).
- Tabellen en payloads scrollen binnen hun eigen kader; de pagina zelf scrollt nooit horizontaal.
- Tijden in `nl-NL`, korte datum met seconden.

## Wat ik niet wil

Geen KPI-tegels die niets toevoegen, geen grafiek van calls per uur (die vraag stelt niemand hier),
geen sidebar-navigatie voor twee views, en geen modals over modals. De teller van openstaande en
mislukte calls mag in de header, klein.

Lever de artboards plus, per view, een korte notitie over welke interactie waar hangt.
