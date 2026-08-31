# Design brief for the web interface

This is the brief that produced the current UI. The design came back as an eight-artboard canvas and
was implemented in `src/ui/index.html`. Keep this file in sync when the UI's job changes, so a redesign
starts from the same constraints instead of a screenshot.

Paste everything below the line into Claude Design. The data shapes come from `GET /api/events` and
`GET /api/plugins` as they actually answer, so the mockup uses real field names.

---

Design the web interface for **Hooky**, a self-hosted webhook receiver. Something POSTs to
`/hooks/<name>`, Hooky normalizes that into an event and delivers it to notification channels
(Telegram, ntfy, console). Every call is stored, and delivery runs through an outbox: when a channel
fails the event stays pending and the server tries again later, including after a restart.

## Who uses it

One developer running their own server. They open this page in two situations. First: "did that alert
actually arrive?" Then they want to see within two seconds whether the last calls were delivered and
which channel failed. Second: "why didn't it arrive?" Then they want the payload, the per-channel
error, and a way to fire the call again.

It is a technical tool for one person, not a dashboard for a team. Density beats whitespace, but not at
the cost of legibility.

## Two views

### 1. Calls (the main view)

A list of webhook calls, newest first, with a filter bar above it and a detail view for one call. The
list refreshes every 5 seconds.

Per row: time, hook name, level, title, which channels received it with their status, and the outcome
of the call as a whole. A replay is recognizable as a replay.

Filters: free text over title and body, hook name, level, outcome, pending only, and a window (last
hour, day, week). Plus paging, because the history runs over months.

The detail of one call shows everything: the fields, the body, the payload as it arrived (JSON), the
deliveries per channel with error message and attempt count, and for a pending call when the next
attempt is due. One action: replay.

### 2. Plugins

Hooky is assembled from plugins, and the UI can turn them on and off. A table with, per plugin: id,
module, whether it is running, the config, and a switch. Disabling takes the plugin out live, so a
channel stops delivering immediately. That is an intervention with consequences; show that.

## The real data

`GET /api/events?limit=50&level=error&since=24h` answers:

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
      "title": "Release to feature-2 failed",
      "body": "Stage 'Deploy tenant stacks' failed after 4m12s",
      "url": "https://dev.azure.com/example/product/_build/results?buildId=88213",
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

Fixed vocabularies:

- `level`: `debug`, `info`, `warning`, `error`, `critical`
- `state`: `pending` (the server is still trying) or `done`
- `outcome`: `delivered`, `partial` (some channels took it), `failed`, or `null` while pending
- `delivery.status`: `sent`, `failed` (with `error`), `skipped` (with `reason`)

`GET /api/stats` answers `{ "events": 412, "pending": 3, "hooks": ["ci", "deploy", "uptime"], "outcomes": { "delivered": 400, "partial": 9, "failed": 3 }, "channels": { "telegram": { "sent": 380, "failed": 12 } }, "channels_registered": ["console", "telegram", "ntfy"] }`.

`GET /api/plugins` answers, per plugin, `{ "id": "config:telegram", "name": "./src/plugins/channel-telegram.ts", "disabled": false, "state": "active", "config": { "chatId": "-100123", "match": { "minLevel": "warning" } }, "critical": false }`. `state` is `active`, `pending` (waiting for a service that is not there), `failed`, or `unmounted`. `critical` marks the rows that would take the page itself down, so they get no switch.

## States to design

1. No calls at all. This is the first thing someone sees after setting it up, so include the curl
   command that sends the first call.
2. Filters active, no results.
3. A pending call with a failing channel and a time for the next attempt.
4. A call with three channels in three different statuses, as in the JSON above.
5. A long payload and a long error message, in the detail. Neither may break out of its frame.
6. No token, or a rejected one. The page asks for a token and keeps it in localStorage. Design that as
   a proper state, not a browser prompt.
7. A plugin in `failed` and one in `pending`, with the reason visible or one click away.

## Visual direction

Technical and quiet, in the spirit of a good log viewer. System font for text, monospace for ids,
times, payloads and error messages. Works in light and dark, driven by the system preference.

Colour carries meaning and nothing else: one colour for sent, one for failed, one for skipped, one for
pending. Level is not a rainbow; only `error` and `critical` may stand out. No decorative icons, no
emoji, no gradients.

The status of a call must be readable from the row without opening it. That is the most important
requirement of the design.

## Constraints

- One page, two views, no router and no login screen.
- Buildable as a single HTML file with inline CSS and JS, no framework and no build step. No component
  library, no external fonts or icon sets.
- Must work on a 1280-wide laptop screen and stay legible on a phone (the list may collapse into cards
  there).
- Tables and payloads scroll inside their own frame; the page itself never scrolls horizontally.
- Times as `2026-08-31 18:57:49`, 24-hour, seconds included.

## What I do not want

No KPI tiles that add nothing, no chart of calls per hour (nobody asks that question here), no sidebar
navigation for two views, and no modals stacked on modals. The counters for pending and failed calls
may sit in the header, small.

Deliver the artboards plus, per view, a short note on which interaction sits where.
