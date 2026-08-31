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

```sh
curl -X POST localhost:3000/hooks/test \
  -H "x-hooky-secret: $HOOKY_SECRET" \
  -H 'content-type: application/json' \
  -d '{"title":"deploy finished","message":"build 1234","level":"info","tags":["deploy"]}'
```

The response is `202` with the event id. Open `http://localhost:3000/` for the history, or use the CLI:

```sh
export HOOKY_URL=http://localhost:3000 HOOKY_SECRET=...
node src/cli.ts events list --limit 5
node src/cli.ts describe            # every command and endpoint, as JSON
```

Node 24 or newer. It runs the TypeScript sources directly through Node's type stripping, so there is no
build step and no bundler. `pnpm typecheck` runs `tsc --noEmit`, `pnpm test` runs the node test runner.

## The pipeline

```
POST /hooks/:name
   │
   ├─ ctx.server            HTTP transport, knows nothing about webhooks
   ├─ hook/receive          waterfall: auth vetoes, a normalizer transforms
   ├─ ctx.hooks.submit()    ingest, knows nothing about HTTP
   │     └─ outbox takes ownership: store the event, answer 202 now
   ├─ notify/render         waterfall: HookEvent to Message
   ├─ ctx.notify            fan out to the channels whose matcher accepts it
   ├─ notify/deliver        waterfall per channel: rate limit, dedupe, quiet hours
   ├─ notify/retry          serial: the policy plugin says whether to try again
   └─ notify/delivered      emit: logging and metrics
```

`ctx.server` knows no webhooks, `ctx.hooks` knows no HTTP, and the channels know neither. A cron or
mail ingest is a plugin that calls `ctx.hooks.submit()`; a new channel is a plugin that calls
`ctx.notify.register()`.

A waterfall listener that only observes must call `next()` exactly once. Returning without it is the
veto, which is how `auth-secret` rejects a request. Calling it twice is outside the contract: cordis
consumes its listener list with `shift()`, so a second call skips a listener instead of repeating the
chain. That is why the retry loop is a separate serial event and not a listener that calls `next()`
again.

## Durability

The outbox plugin owns persistence. It takes ownership of `hook/submit` by returning without calling
`next()`: the event goes into SQLite, the caller gets its id immediately, and delivery happens after.
A pass that leaves a channel failing schedules the next pass with exponential backoff, and the queue is
the events table, so a restart continues where it left off. A retry only targets channels that have no
`sent` record for that event.

Two retry layers, on purpose. `retry.ts` covers seconds inside one attempt (a 502 from Telegram).
The outbox covers hours across restarts (Telegram down all evening).

Unload the outbox and the pipeline delivers inside the request again, with nothing else changing, but
then nothing is recorded and the UI stays empty. History and durability come from the same plugin.

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
    async send(message, signal) {
      // Throw on failure; the pipeline turns that into a failed delivery.
    },
  })
}
```

Then add a row, or let the CLI do it:

```sh
node src/cli.ts plugins add ./src/plugins/channel-example.ts --id example --set channel=example
```

`ctx.notify.register()` returns a disposer bound to your fiber, so the channel leaves when the plugin
does. `match` filters through the same `matches()` helper for every channel, so a matcher means the
same thing everywhere.

Mounting the same plugin twice with different config gives two channels. That is how you get a Telegram
channel for everything and a second one that only fires on `critical`, with another chat id.

## Composition

`cordis.yml` is the application. Every row has an explicit `id`, because without one the loader
generates a fresh id on every read and remounts the plugin after any config edit.

`!!js` expressions work inside `config` and in `disabled`, nowhere else. `disabled` is evaluated at
every mount decision, which is how HMR stays out of production and how a channel disables itself when
its token is not configured.

Rows are addressed as `config:<row id>`, a stable id that survives a restart because `src/main.ts`
mounts the config entry with a fixed id instead of letting the loader generate one.

The CLI and the UI write to this file. A YAML dump keeps the `!!js` expressions but drops comments, so
once you mutate the composition from outside, explanatory comments in `cordis.yml` are gone. That is
why the explanation lives here.

## Runtime seams

| Service | Provided by | Consumers get |
|---|---|---|
| `ctx.server` | `server-node.ts` | `route(method, pattern, handler)`, `address` |
| `ctx.hooks` | `hooks.ts` | `submit(event)`, `dispatch(event, options)` |
| `ctx.notify` | `hooks.ts` | `register(channel)`, `names`, `deliver(message, skip)` |
| `ctx.store` | `store-sqlite.ts` | `append`, `get`, `list`, `due`, `recordAttempt`, `stats`, `prune` |
| `ctx.timer` | `@deepseek-ai/cordis-plugin-timer` | `ctx.timeout`, `ctx.interval` as effects |

Every interface lives in `src/core`, every implementation in `src/plugins`. A plugin imports types from
`core` and never from another plugin, which is what makes a plugin liftable into its own npm package
without touching its code.

## The web interface

`http://localhost:3000/` serves one HTML file with inline CSS and JS. No bundler, no framework, no
build step, and it is theme-aware through `prefers-color-scheme`. Two views:

**Calls.** The history, newest first, refreshing every 5 seconds. A row is meant to be readable without
opening it: time, hook, level, title, a chip per channel with its status, and the outcome. Clicking a
row opens a 560px detail panel on the right and narrows the list; Escape closes it. The detail holds the
fields, the deliveries with their per-channel error, and the payload as it arrived. Replay lives only in
the detail, so it cannot go off by accident, and polling pauses while a detail is open so the list
cannot shift under a read. Filters map one to one onto the query string and reset paging on every
change.

**Plugins.** Every loader entry with its fiber state and config. Enabling is immediate; disabling first
opens a strip inside the row naming the consequence, because the plugin leaves the composition live and
everything waiting on its service goes with it. A plugin stuck in `failed` gets a remount button instead
of a switch. Rows the API marks `critical` (the config entry, the api and the ui plugin) get no switch at
all, since turning those off would take the page down with them. The CLI can still touch them.

Outside production the page is read from disk per request, so an edit plus a refresh is enough. HMR
watches modules and `index.html` is not one.

## API and CLI

The API serves both the UI and the CLI, with `Authorization: Bearer <secret>` or `x-hooky-secret`.
`GET /api/describe` returns the full endpoint catalog, and `node src/cli.ts describe` returns that plus
the command catalog, both as JSON. That is the intended entry point for an agent driving this.

Reading history needs no loader, so the API also works in a composition that mounts plugins from code.
The `/api/plugins` endpoints answer `503` when there is no loader.

## Docker

```sh
docker compose up --build
```

Debian, not Alpine: the loader's native helper publishes `linux-x64-gnu` and `linux-arm64-gnu`
prebuilts and no musl build. The compose file binds to loopback only. Put a reverse proxy with TLS in
front, because the shared secret and the API token travel as plain headers.

The `hooky-data` volume holds the event history and the outbox queue. Losing it loses the calls that
were still pending.

## What is not here

No source-specific normalizer yet. Wiring up Azure DevOps, GitHub or Grafana is a listener on
`hook/receive` and nothing else. No dedupe, no quiet hours, no HMAC verification per source. All of
those are a plugin on an existing waterfall and need no change in the core, which is the test of
whether this design holds.
