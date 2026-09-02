# Hooky

A webhook receiver where every capability is a plugin. Something POSTs to `/hooks/<name>`, Hooky
turns that into a normalized event, stores it, and delivers it to notification channels. Adding a
channel is one file plus one row in `cordis.yml`.

The plugin runtime is [Cordis](https://arxiv.org/abs/2608.25512), the implementation from
"A Programming Paradigm for Spatiotemporal Composability" (Shi, Zhang, Cui), published as
`@deepseek-ai/cordis`. Two of its mechanisms carry the design:

- **Revertible effects.** Every registration returns a disposer attached to the plugin's fiber.
  Unloading a plugin undoes its routes, listeners, channels and timers, and the core keeps no list of
  who registered what.
- **Reactive coeffects.** A plugin names the services it needs in `inject` and stays PENDING until
  they exist. If a service disappears, its consumers unload and come back when it returns. Load order
  comes from those declarations, not from the order of rows in the config.

## Quick start

```sh
pnpm install
cp .env.example .env          # set HOOKY_SECRET at least
pnpm dev
```

Both entry points read that `.env` from the working directory before anything else runs, so `PORT` and
`HOOKY_SECRET` reach the `!!js process.env.*` expressions in `cordis.yml`. A variable that is already
exported wins over the file, which is how compose's `env_file` and the Dockerfile's `ENV` keep the last
word. `HOOKY_ENV_FILE` points at a different file. Your shell does not read the file, so export the
secret there as well if you want to paste it into the curl below.

```sh
curl -X POST localhost:3000/hooks/test \
  -H "x-hooky-secret: $HOOKY_SECRET" \
  -H 'content-type: application/json' \
  -d '{"title":"deploy finished","message":"build 1234","level":"info","tags":["deploy"]}'
```

The response is `202` with the event id. Open `http://localhost:3000/` for the history, or use the CLI:

```sh
node src/cli.ts events list --limit 5
node src/cli.ts describe            # every command and endpoint, as JSON
```

The CLI reads the same `.env`, so against a local instance it needs no exports. Set `HOOKY_URL` and
`HOOKY_SECRET` to aim it at another host.

Node 24 or newer. It runs the TypeScript sources directly through Node's type stripping, so there is no
build step and no bundler. `pnpm typecheck` runs `tsc --noEmit`, `pnpm test` runs the node test runner.

## The pipeline

```
POST /hooks/:name
   │
   ├─ ctx.server            HTTP transport, knows nothing about webhooks
   ├─ hook/receive          waterfall: the hook's own secret vetoes, a normalizer transforms
   │     └─ no such hook, or switched off: 404/410, and the call is kept as rejected
   ├─ ctx.hooks.submit()    ingest, knows nothing about HTTP
   │     └─ outbox takes ownership: store the event, then work it off
   ├─ notify/render         waterfall: HookEvent to Message
   ├─ notify/target         bail: the hook definition names the channels and the mapping
   ├─ ctx.notify            fan out, shaping the message per channel
   ├─ notify/deliver        waterfall per channel: rate limit, dedupe, quiet hours
   ├─ notify/retry          serial: the policy plugin says whether to try again
   ├─ notify/delivered      emit: logging and metrics
   ├─ hook/processed        emit: the queue is done with this pass, the store knows
   └─ hook/answer           waterfall: what the caller gets back
```

`ctx.server` knows no webhooks, `ctx.hooks` knows no HTTP, and the channels know neither. A cron or
mail ingest is a plugin that calls `ctx.hooks.submit()`; a new channel is a plugin that calls
`ctx.notify.register()`.

A waterfall listener that only observes must call `next()` exactly once. Returning without it is the
veto, which is how `auth-secret` rejects a request. Calling it twice is outside the contract: cordis
consumes its listener list with `shift()`, so a second call skips a listener instead of repeating the
chain. That is why the retry loop is a separate serial event and not a listener that calls `next()`
again.

## The answer

A call waits for the queue and hears what happened:

```
POST /hooks/urgent
{ "title": "api is down", "level": "critical" }

200
{ "id": "34ef85…", "hook": "urgent", "queued": false, "state": "done",
  "outcome": "delivered", "attempts": 1, "nextAttemptAt": null,
  "results": [ { "channel": "telegram", "status": "sent", "attempts": 1 },
               { "channel": "ntfy", "status": "sent", "attempts": 1 } ] }
```

`200` means nothing is owed any more. `202` means a pass is still to come, and then the body says why:
a channel that failed with its own error, `attempts` passes so far and `nextAttemptAt` for the next one.
A failed delivery is never a 5xx. The outbox owns the retry, so a caller that retries on a 502 sends the
same notification twice. Want a hard failure anyway? That is four lines in a `hook/answer` listener.

The wait is bounded by `waitMs` on the ingest row, 10 seconds by default. Running out costs nothing:
the answer is `202` with the event id, and the outbox carries on. That is also the answer for a caller
that does not want to wait at all:

```
POST /hooks/urgent/async  ->  202 { "id": "5c8e3e…", "queued": true, "state": "pending", "results": [] }
```

Both doors are the same handler with a different budget, and `waitMs: 0` makes the plain route behave
like the async one for every caller at once.

**A plugin gets the last word.** `hook/answer` is a waterfall over `{ status, body }`, so adding a field
is `const base = await next(); return { ...base, body: { ...base.body, ticket } }`, and answering `201`
with a shape some caller insists on is the same four lines. Only the accepted path comes past it: a
refused call answers through `HookRejected` and never reaches the seam.

## Asking a question

A call with an `ask` in it is a question. Hooky gives that question one reply url, sends it out with the
message, and holds the answer to the call until somebody replies:

```
POST /hooks/sander
{ "title": "Deploy 4471 to prod?", "message": "12 commits, tests green",
  "ask": { "actions": [ { "title": "yes" }, { "title": "no" } ], "wait": 120 } }

200
{ "id": "34ef85…", "hook": "sander", "queued": false, "state": "done", "outcome": "delivered",
  "results": [ { "channel": "telegram", "status": "sent", "attempts": 1 } ],
  "ask": {
    "id": "8f2aQ1xK…",
    "replyUrl": "https://hooky.example.com/ask/reply/8f2aQ1xK…",
    "statusUrl": "https://hooky.example.com/ask/8f2aQ1xK…",
    "expiresAt": 1788251712000,
    "actions": [
      { "value": "yes", "title": "yes", "url": "https://…/ask/reply/8f2aQ1xK…/yes", "reply": true },
      { "value": "no",  "title": "no",  "url": "https://…/ask/reply/8f2aQ1xK…/no",  "reply": true }
    ],
    "answered": { "action": "yes", "at": 1788251650123 }
  } }
```

So an agent asks and hears the answer in one call. The rest of the pipeline knows nothing about it:
this is a hook call, so the secret, the targets, the mapping, the history and the retries all behave as
they do for anything else.

**One url answers a question, and the caller decides what an answer is.**

| What you ask with | What answers it |
|---|---|
| `ask.actions` | A reply url per answer, `replyUrl/<value>`. That is what a person taps, and `answered.action` is the value they picked. Hooky renders them as lines under the body, so a channel shows them without knowing what a question is. |
| `ask: true`, or an ask with no actions | Nothing is rendered. Post anything to `replyUrl` and that body is the answer, in `answered.data`. |
| both | An answer url takes a body as well, so "yes, but" comes back with a note attached to it. |

An answer with a `url` of its own is a plain link that answers nothing. It rides along in the message
to be tapped, which is how "open the form" sits next to "not now".

**A channel with buttons uses them.** Telegram puts every answer in an inline keyboard and ntfy in its
view buttons, three of them, with anything that does not fit going back under the text. They declare
`actions: true` and then `notify` leaves their body alone, so the same question reads as buttons on a
phone and as lines in a log. Teams and console take the lines: Microsoft lists buttons not rendering as
a known issue for cards the flow bot posts, so there is nothing to gain there. One thing to know if
your questions reach Telegram: it validates the url on a button, so give that instance a public
`publicUrl` rather than a localhost one.

**Opening an answer url shows a page with one button.** That is not politeness. Telegram fetches the
urls in a message to build a link preview, so a link that answers on the GET is clicked by that crawler
before you ever see it. The button posts, and nothing prefetches a POST. `confirm: false` turns the page
off if you know better for your own channels.

First answer wins, and one `UPDATE ... WHERE answered_at IS NULL` decides it, so a second reply reads
"already answered yes" instead of overwriting anything. A question lasts `keepMs`, an hour by default,
and after that its urls say it expired. An ask is a row in SQLite, so the links already in your chat
survive a restart.

`ask.wait` is in seconds and is capped by `maxWaitMs`, five minutes by default. Running out loses
nothing: the answer comes back with `answered: null`, the question stays open, and
`GET /ask/<id>?wait=60` picks the waiting up where the call left it. `wait: 0` answers at once. A
question nobody received is never waited for at all: if no channel took it and the queue owes nothing,
the `results` say why and the call comes straight back.

### A form as the answer

Hooky does not look inside a reply body, which is the whole of the form support: whoever asks builds
the page, the page posts the fields to the reply url, and the caller gets them back as `answered.data`.

That page has to know the reply url before the question goes out, so a caller may bring its own id:

```
POST /hooks/sander
{ "title": "Five questions about the sprint",
  "url": "https://example.com/the-form",
  "ask": { "id": "b7f2c1de-4a33-4c07-9f11-2b8e5d6a1c90", "wait": 600 } }
```

The reply url is then `https://hooky.example.com/ask/reply/b7f2c1de-…`, which the page can hold before
Hooky has ever heard of the question. No actions, so nothing is rendered and the reader taps the form in
`url` instead. The page finishes with:

```js
await fetch('https://hooky.example.com/ask/reply/b7f2c1de-…', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(answers),
})
```

`ask.id` is 16 to 64 characters of `[A-Za-z0-9._-]` and it has to be random, because it is the only
thing keeping the question private. Reusing one is a `400` and not a silent overwrite.

A plain form post works as well as a `fetch`: `application/x-www-form-urlencoded` becomes an object with
one key per field, and a repeated field becomes a list. The `accept` header decides what comes back, the
page or the JSON, so a `<form method="post">` lands on "passed on" with no script at all.

The ask routes answer `access-control-allow-origin: *`, so that page can live anywhere, an artifact on
someone else's domain included. Closing that would protect nothing: the reply url is the capability, and
a plain form post never asked CORS for permission.

## Durability

The outbox plugin owns persistence. It takes ownership of `hook/submit` by returning without calling
`next()`: the event goes into SQLite first, and delivery happens after. A pass that leaves a channel
failing schedules the next pass with exponential backoff, and the queue is the events table, so a
restart continues where it left off. A retry only targets channels that have no `sent` record for that
event.

Every pass ends in one `hook/processed`, emitted after the store knows how it went. That is what a
waiting caller is waiting for, and it is why the wait needs no polling: `ctx.hooks.submit` registers
itself for that event id before the outbox even sees the event, because the sweep can be over before
`submit` resolves.

Two retry layers, on purpose. `retry.ts` covers seconds inside one attempt (a 502 from Telegram).
The outbox covers hours across restarts (Telegram down all evening).

Unload the outbox and the pipeline delivers inside the request again, with nothing else changing, but
then nothing is recorded and the UI stays empty. History and durability come from the same plugin.

## Hooks

A hook is not a piece of wiring, it is a row in the database. `POST /hooks/<name>` only works for a
name you defined, the hook carries its own secret, and it lists the channels it delivers to. Per
target you say what that channel receives, so the same call can read differently on Telegram than on
ntfy.

```sh
node src/cli.ts hooks add urgent --target telegram --target ntfy
# {"hook": {...}, "secret": "hk_...", "note": "shown once, not stored"}

node src/cli.ts hooks target urgent telegram \
  --title 'FIRE {{title}}' \
  --body '{{message}}\n\nbuild {{payload.buildId}}' \
  --level critical

node src/cli.ts hooks preview urgent --data '{"title":"api is down","buildId":991}'
node src/cli.ts hooks run urgent telegram --data '{"title":"api is down","buildId":991}'
```

A target can also carry settings for its channel, with `--set key=value`. That is for a channel whose
destination is part of the wiring rather than of the composition:

```sh
node src/cli.ts hooks target releases teams --set webhook='https://…/triggers/manual/paths/invoke?…&sig=…'
node src/cli.ts hooks target releases ntfy --set topic=releases
```

A Teams webhook url is one Teams channel and an ntfy topic is one feed on someone's phone, so both sit
on the target and every hook can point somewhere else. `GET /api/channels` says which keys a channel
takes and which of them are credentials, which is how the web interface knows to ask for them.
Telegram declares none: its chat is genuinely a property of the row.

A target with no destination and a row with no default is **skipped**, not failed. The result says
`no topic: set one on this target, or a default on the ntfy row`, and because it is not a failure the
outbox schedules no pass to find the same nothing again.

`preview` resolves the templates per channel and sends nothing. `run` is the other half: one payload,
one channel, actually sent, so you read the result on your phone instead of in a JSON body. That is
the check a preview cannot do, because how a message lands is a question about Telegram and not about
the template. A run is not an event: nothing is stored, nothing is queued, and the answer carries what
went out plus what the channel said.

**The secret belongs to the hook.** A create generates one, hands it back once and stores only its
SHA-256, so the API cannot leak it afterwards and neither can a database dump. Lost means
`hooks rotate`, not lookup. `--open` defines a hook without a secret, and `--secret` supplies your own.
A call with the wrong secret gets 401, an undefined name gets 404, a disabled hook gets 410.

**The mapping is `{{path}}` and nothing else.** No expressions, so a template is safe to store and to
edit over the API. Available: `title`, `body` (alias `message`), `hook`, `level`, `url`, `id`, `tags`,
and any path into the payload such as `payload.stages.0.step`. A path that resolves to nothing becomes
an empty string. `level` is a plain override, not a template, and it is what decides ntfy priority and
whether Telegram makes a sound. A field the map leaves out keeps what the renderer produced.

**A target can filter inside the hook.** `--min-level error` on one target means that channel only
hears the serious calls while the others get everything.

```
POST /hooks/urgent  ->  telegram  FIRE api is down / build 991   (level critical)
                        ntfy      api is down                    (level as it came in)
                        console   api is down                    (the `always` channel)
POST /hooks/notice  ->  telegram  nightly backup done
POST /hooks/random  ->  404, because nobody defined that name
```

**A call nobody took is kept.** The 404 above is still a 404 for the caller, but the call itself lands
in the history with `state: rejected` and its payload intact, and so does a call for a hook that is
switched off (410). That is the case where you want to see what arrived: some service is already
posting, you just have not defined the hook yet. `GET /api/events?state=rejected` lists them, the
Calls view marks them, and from a rejected call the UI offers to define a hook by that name with that
payload as the starting point. Replaying one answers `409` until the hook exists, because queueing an
event that can only be rejected again is not a favour.

A wrong secret is not kept. That is the one body someone else can push in for free, so it is refused
and forgotten. The kept ones are capped: `keepRejected` on the store row (default 50) evicts the
oldest, `remember: false` on the routes row turns the whole thing off, and retention prunes them like
any settled event. Without a cap a public ingest would be a way to grow the database.

Two Telegram chats is two channel entries in `cordis.yml` with different `chatId` and `channel` names,
and then two targets. The channel plugin stays unaware; only the hook knows there are two.

`ctx.routes` is the service behind this, `src/plugins/hook-routes.ts` provides it, and the definitions
live in the same SQLite file as the history. Unload that plugin and routing falls back to the `match` on
each channel, which is what the tests use to prove the layer is optional.


## Adding a channel

Write `src/plugins/channel-<name>.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { MatcherSchema } from '../core/schema.ts'
import type { Matcher } from '../core/types.ts'

export const name = 'channel-example'
export const inject = ['notify']

export interface Config {
  channel: string
  match: Matcher
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  channel: Schema.string().default('example'),
  match: MatcherSchema,
})

export function apply(ctx: Context, config: Config): void {
  ctx.notify.register({
    name: config.channel,
    match: config.match,
    // Optional: what a target may set for itself, e.g. a destination url. The
    // API hands this to the web interface, which renders a field per entry.
    settings: [{ key: 'url', label: 'endpoint', secret: true }],
    async send(message, signal, settings) {
      // Throw on failure; the pipeline turns that into a failed delivery.
      // Throw ChannelSkip when there is nothing to send to: that is a skipped
      // result, and the outbox does not come back to try it again.
    },
  })
}
```

Then add a row, or let the CLI do it:

```sh
node src/cli.ts plugins add ./src/plugins/channel-example.ts --id example --set channel=example
```

`ctx.notify.register()` returns a disposer bound to your fiber, so the channel leaves when the plugin
does. `match` on a channel is the fallback routing for events whose hook nobody defined; with the hooks
layer mounted the definitions decide, and a channel usually needs no matcher at all.

Mounting the same plugin twice with different config gives two channels. That is how you get a Telegram
channel for everything and a second one for an oncall chat, and a hook that targets both.

## Teams over a Workflows webhook

The `teams` channel posts to a Power Automate flow, the trigger that replaced the retired Office 365
connectors. In Teams, open Workflows and create one from the template
[Send webhook alerts to a channel](https://support.microsoft.com/en-US/Workflows/send-messages-in-teams-using-incoming-webhooks),
which needs no premium license. Copy the url from the workflow details.

That url points at one Teams channel, so it belongs to the hook and not to the composition. Open the
hook, add `teams` as a target, and paste it into the webhook field:

```sh
node src/cli.ts hooks add releases --target teams
node src/cli.ts hooks target releases teams --set webhook='https://…/triggers/manual/paths/invoke?…&sig=…'
```

The web interface asks for the same field, because the channel declares what it accepts and
`GET /api/channels` hands that to the page. So a second hook posting in another Teams channel is
another url on another target, not a second plugin row. The row's own `webhook`, from `TEAMS_WEBHOOK`,
is only a default for when every hook lands in the same place, and the row mounts without it.

The url is also a credential: the `sig` in the query string is what authorizes the call, and anyone
holding it can post in that channel. Stored on the target it is readable through the admin API and it
lands in `hooks export`, so treat that backup the way you treat `.env`. The target list shows
`own webhook`, never the url itself.

What the endpoint accepts depends on the flow behind it, and there is no way to ask it beforehand:

| `format` | Body it posts | For a flow that |
|---|---|---|
| `card` (default) | `{ "type": "message", "attachments": [ one adaptive card ] }` | came from a webhook template |
| `text` | `{ "text": "..." }` | was built around a plain string |

The templates from that article loop over `attachments` and post each card, so `card` is the one they
want. It is the default, and a target can override it per hook with `--set format=text`.

The wrong one answers `400 Invalid Request`. That is a failed delivery like any other, so the outbox
keeps retrying it on a backoff for hours, which is a slow way to learn. After changing `format`, fire
one call by hand and read the result.

The card carries the title coloured by level (`attention` for error and critical, `warning` for warning,
grey for debug), the body, a fact list with the hook, the level and the tags, and the url both as a
markdown link in the card and as an `Action.OpenUrl` button under it. That duplication is deliberate:
Microsoft lists buttons not rendering as a known issue for cards posted by the flow bot, and a url
nobody can reach is worse than one extra line. `facts: false` leaves the fact list out and `version`
sets the Adaptive Card version, which Teams renders from 1.0 through 1.5.

Teams throttles above four requests per second and refuses a message over 28 KB. The `rate-limit` row
covers the first at 20 per minute per channel. For the second, keep a mapped payload dump out of the
body of a hook that targets Teams.

## Composition

`cordis.yml` says what the application can do: which plugins run, which channels exist, how the server
is bound. What it does with them, so which hooks exist and where their calls go, lives in the database
and is managed over the API. That boundary is the reason a new hook needs no config edit and no restart.

Every row has an explicit `id`, because without one the loader generates a fresh id on every read and
remounts the plugin after any config edit.

`!!js` expressions work inside `config` and in `disabled`, nowhere else. `disabled` is evaluated at
every mount decision, which is how HMR stays out of production and how a channel disables itself when
its token is not configured.

Quote a `!!js` expression that contains a colon followed by a space. The tag applies to a scalar, and
YAML reads `a ? b : c` as a mapping, so an unquoted ternary arrives at the plugin as an object and the
row fails to mount with a schema error.

Rows are addressed as `config:<row id>`, a stable id that survives a restart because `src/main.ts`
mounts the config entry with a fixed id instead of letting the loader generate one.

The CLI and the UI write to this file. A YAML dump keeps the `!!js` expressions but drops comments, so
once you mutate the composition from outside, explanatory comments in `cordis.yml` are gone. That is
why the explanation lives here.

Editing the file by hand needs a restart: HMR watches `./src`, not the config. Changes through the API,
the UI or the CLI apply live, because those go through the loader.

The `routes` row carries a `seed`: hooks created on the first boot, when the table is still empty, with
`seedSecret` as their secret. That is what makes a fresh clone answer calls without a setup ritual. It
does nothing on every boot after that.

## Runtime seams

| Service | Provided by | Consumers get |
|---|---|---|
| `ctx.server` | `server-node.ts` | `route(method, pattern, handler)`, `address` |
| `ctx.hooks` | `hooks.ts` | `submit(event)`, `dispatch(event, options)` |
| `ctx.notify` | `hooks.ts` | `register(channel)`, `names`, `settings`, `deliver(message, skip)`, `deliverTo(message, target)` |
| `ctx.routes` | `hook-routes.ts` | `list`, `get`, `create`, `setTarget`, `rotate`, `preview`, `run`, `targetsFor` |
| `ctx.store` | `store-sqlite.ts` | `append`, `get`, `list`, `due`, `recordAttempt`, `stats`, `prune`, `listHooks`, `saveHook`, `saveAsk`, `answerAsk` |
| `ctx.timer` | `@deepseek-ai/cordis-plugin-timer` | `ctx.timeout`, `ctx.interval` as effects |

Every interface lives in `src/core`, every implementation in `src/plugins`. A plugin imports types from
`core` and never from another plugin, which is what makes a plugin liftable into its own npm package
without touching its code.

## The web interface

`http://localhost:3000/` serves one HTML file with inline CSS and JS. No bundler, no framework, no
build step, and it is theme-aware through `prefers-color-scheme`. Type is one scale of six steps in
`:root`, from the letterspaced micro labels up to the headings, and every size on the page picks a
step. So the whole interface gets bigger or smaller by editing six numbers. Three views:

**Calls.** The history, newest first, refreshing every 5 seconds. A row is meant to be readable without
opening it: time, hook, level, title, a chip per channel with its status, and the outcome. A rejected
call sits in the same list with its status where the channels would be, its hook name in red, and
`rejected` in the outcome dropdown filters down to those. The header counts them and that count is a
link to the filter. Their detail panel offers `define a hook for "<name>"`, which opens the create
form with the name and that call's body already in it, so the mapping you write next can complete the
paths the payload really has. Once the hook exists the same panel says so and replay opens up.
Clicking a row opens a detail panel on the right and narrows the list; Escape closes it. Drag the divider to
resize the panel, double-click it to go back to 600px, and the width is remembered per browser. The
detail holds the fields, the deliveries with their per-channel error, and the payload as it arrived.
The panel scrolls when the window is short, the payload frame scrolls inside it. Replay lives only in
the detail, so it cannot go off by accident, and polling pauses while a detail is open so the list
cannot shift under a read. Filters map one to one onto the query string and reset paging on every
change.

**Hooks.** The definitions, and the place to change them. A row shows the name, a chip per target
with `missing` when no channel of that name is registered, whether it has its own secret, and whether
it is on. The panel on the right holds the description, the payload box, the target table, and the
curl line for calling the hook.

That table has a row for every registered channel, not only the ones this hook sends to. A channel it
sends to shows what it maps, and `edit` opens the editor for it: title, body, url, level, tags, a
filter from a level up, and whatever settings the channel asks for. A channel it does not use yet has
one button, `set up`, which makes it a target without a mapping and opens that same editor. So the
panel answers "where does this hook go" in one list, and adding a destination is a click on the row
you were already reading.

Defining one and rotating a secret both show the value once, in a strip you can copy, because the
server only keeps its hash. Rotating asks first, because the old secret dies the moment the new one
lands. The `hook` field in a call's detail is a link to the definition that routed it.

The payload box sits above the targets because it feeds them. Type `{{` in a title, body, url or tags
field and the paths in that payload are offered with their current value beside them, arrows and Enter
to pick, Escape to dismiss. Fill the box with a real request body and the templates you write are
templates over something that exists, instead of a guess at a field name.

Every target editor has a `run`, and it sends. That payload, this one channel, with the fields as they
stand in the editor whether or not they are saved, so you can try a mapping and look at your phone
before committing to it. What came back sits under the buttons: sent, failed with the channel's own
error, or skipped with the reason, plus the message that went out. There is no dry run per channel any
more. Reading a rendered title in the browser told you what the template does, which the editor
already shows, and nothing about how it arrives.

This view does not poll. Definitions do not change on their own, and a refresh in the middle of an
edit is how you lose what you typed.

**Plugins.** Every loader entry with its fiber state and config. Enabling is immediate; disabling first
opens a strip inside the row naming the consequence, because the plugin leaves the composition live and
everything waiting on its service goes with it. A plugin stuck in `failed` gets a remount button instead
of a switch. Rows the API marks `critical` (the config entry, the api and the ui plugin) get no switch at
all, since turning those off would take the page down with them. The CLI can still touch them.

Outside production the page is read from disk per request, so an edit plus a refresh is enough. HMR
watches modules and `index.html` is not one.

## API and CLI

The API serves both the UI and the CLI, with `Authorization: Bearer <secret>` or `x-hooky-secret`.
That token is the admin token from the `api` row, and it has nothing to do with the per-hook secrets a
caller uses on `/hooks/<name>`.

`GET /api/describe` returns the full endpoint catalog including the template paths, and
`node src/cli.ts describe` returns that plus the command catalog, both as JSON. That is the machine
entry point for an agent driving this; the `/skills` documents below are the same surface in prose.

Hooks are managed there: `GET|POST /api/hooks`, `PATCH|DELETE /api/hooks/:name`,
`PUT|DELETE /api/hooks/:name/targets/:channel`, `POST /api/hooks/:name/rotate`,
`POST /api/hooks/:name/preview` and `POST /api/hooks/:name/targets/:channel/run`. In the CLI that is
`hooks list|show|add|set|target|untarget|rotate|preview|run|remove|export|import`.

The run endpoint takes `{ payload, map?, match? }`, where a `map` or a `match` in the body replaces
the stored one for that run only. That is what the UI sends while you are still editing a target.

`/api/send` and `POST /api/events/:id/replay` answer `202` without waiting for the queue. They are the
UI's own doors: the page reloads the list right after, so waiting there would only make a button slower.

`GET /api/events` filters on `state=pending|done|rejected` next to `hook`, `level`, `outcome`,
`channel`, `search` and `since`, and `/api/stats` carries a `rejected` count plus `hooks_defined`, so a
caller can tell a rejected call that is still stuck from one whose hook has since been defined.

Reading history needs no loader, so the API also works in a composition that mounts plugins from code.
The `/api/plugins` endpoints answer `503` when there is no loader.

## Skills for an agent

The instance describes itself as skills. Four of them, because a skill is picked by its description and
these are not one question:

| Skill | Answers | Needs |
|---|---|---|
| `hooky-send` | How do I get this notification out? | The secret of one hook |
| `hooky-manage` | How do I define a hook, or change what a channel receives? | The admin token |
| `hooky-history` | Did it arrive, and if not why? Send it again. | The admin token |
| `hooky-plugin` | How do I make Hooky do something it cannot do yet? | The repository |

`GET /skills` is the index, `GET /skills.json` the same list as JSON, both built from the frontmatter of
the documents themselves. Each document is a skill file, so installing them is a copy:

```sh
for skill in hooky-send hooky-manage hooky-history hooky-plugin; do
  mkdir -p .claude/skills/$skill
  curl -s http://127.0.0.1:3112/skills/$skill/SKILL.md > .claude/skills/$skill/SKILL.md
done
```

The split is a split in credentials too. `hooky-send` never mentions the admin token, so an agent that
only has to raise an alarm gets a document that cannot tell it to redefine anything. `hooky-plugin` is
the odd one out: it is not an HTTP job at all but a job in this repository, so it names the seams in
`src/core/events.ts`, the four exports a plugin has, and what unloading one has to undo.

The prose lives in `src/skill/*.md` and the instance fills in what only it knows: the address the caller
reached (`X-Forwarded-Host` and `X-Forwarded-Proto` included, so the examples are right behind a proxy),
the channels registered right now, and with the admin token the hooks that exist with their targets,
their state and what they are for. Without that token that section says where to look instead, because
which hook names exist is not something a public document hands out. `/healthz` already names the
channels, so those are in either version.

The documents need no token themselves. Serving them is a plugin like everything else: unload `skill`
and the routes are gone.

## Discovery with agents.txt

An agent that lands on the origin and has never heard of Hooky reads
[agents.txt](https://agents-txt.com) and finds the skills from there:

```
# agents.txt
# Standard: https://agents-txt.com
# JSON: http://127.0.0.1:3112/agents.json

Skills: http://127.0.0.1:3112/skills/hooky-send/SKILL.md
Skills: http://127.0.0.1:3112/skills/hooky-manage/SKILL.md
Skills: http://127.0.0.1:3112/skills/hooky-history/SKILL.md
Skills: http://127.0.0.1:3112/skills/hooky-plugin/SKILL.md
```

`GET /agents.json` is the same document as JSON, with the `$schema`, `version`, `standard` and `site`
the v1.0 schema requires and a `description` per skill taken from its frontmatter. Both files answer
with `Access-Control-Allow-Origin: *`, because a browser agent reads them cross-origin, and with a
`Cache-Control` that is an hour in production and `no-store` on a dev instance.

Those `Skills:` lines are in no config. The `skill` plugin declares them on the `agents/declare`
waterfall, so adding a document or moving the prefix changes the file by itself, and unloading the
plugin removes the lines. Anything else worth finding goes the same way:

| Directive | Declared by |
|---|---|
| `Skills:` | the `skill` plugin, one line per document it serves |
| `MCP:`, `A2A:`, `UCP:`, `WebMCP:` | the `agents-txt` row, or a plugin with an `agents/declare` listener |
| `Authorization:`, `Identity:` | the `agents-txt` row, and only together with a `discovery` url |

An authorization block without that url is left out rather than served, because the schema requires it
and half a declaration validates nowhere. Payments are in the vocabulary in `src/core/agents.ts` and in
neither file: Hooky charges nobody, and a plugin can add the block if that ever changes.

`robots: true` on the row also serves a `/robots.txt` that allows the two files and disallows the rest.
Off by default, because a Hooky instance is not a public site and the proxy in front of it may already
serve one.

## Docker

```sh
docker compose up --build
```

Debian, not Alpine: the loader's native helper publishes `linux-x64-gnu` and `linux-arm64-gnu`
prebuilts and no musl build. The compose file binds to loopback only. Put a reverse proxy with TLS in
front, because the shared secret and the API token travel as plain headers.

The `hooky-data` volume holds the event history, the outbox queue and the hook definitions. Losing it
loses the calls that were still pending and every hook you defined, so keep a
`node src/cli.ts hooks export > hooks.json` somewhere. The export carries the hashes, which means the
secrets your callers already use keep working after an import.

## What is not here

Nothing stores the per-channel message next to a delivery, so the history shows the event as it came
in, `preview` answers what a channel would receive and a target's `run` shows what it actually got.
A run itself is not kept either: it never becomes an event, so it stays out of the history and out of
the outbox.

No source-specific normalizer. Wiring up Azure DevOps, GitHub or Grafana is a listener on
`hook/receive` and nothing else. No dedupe, no quiet hours, no HMAC verification per source. All of
those are a plugin on an existing waterfall and need no change in the core, which is the test of
whether this design holds.
