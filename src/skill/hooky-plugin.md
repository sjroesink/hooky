---
name: hooky-plugin
description: Extend Hooky itself with a plugin: a new channel (Slack, a webhook, a log), a normalizer for a source that posts a shape of its own (GitHub, Grafana, Azure DevOps), a delivery policy (dedupe, quiet hours), or a field in the answer a caller gets back. Use when Hooky has to do something it cannot do yet and the change belongs in code. This is work in the Hooky repository; defining a hook needs no code and is hooky-manage.
---

# Writing a Hooky plugin

Everything in Hooky is a plugin: the HTTP server, the ingest, the store, the outbox, every channel, the
API, the web interface. The core owns a vocabulary and ten events, and nothing in it knows what Telegram
is. So adding something is one new file plus a row in the composition, and never a change to the core.

This is a job in the repository, with the sources in front of you. If all you need is a hook that exists
or a message that reads differently, no code is involved: that is
`__BASE____PREFIX__/hooky-manage/SKILL.md`.

Channels registered in this instance right now: __CHANNELS__.

## The shape of a plugin

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'channel-slack'
/** Services this plugin cannot work without. It waits for them, and leaves with them. */
export const inject = ['notify']

export interface Config {
  channel: string
  webhook: string
}

export const Config: Schema<Partial<Config> & { webhook: string }, Config> = Schema.object({
  channel: Schema.string().default('slack'),
  webhook: Schema.string().required().role('secret'),
})

export function apply(ctx: Context, config: Config): void {
  // register things here; they go away when this fiber unloads
}
```

Four exports and nothing else. `src/plugins/channel-console.ts` is the smallest real one, 32 lines
including its config; read that first.

## The seams

They are declared in `src/core/events.ts`, which is also where the contract of each is written down.

| Event | Mode | A listener there decides |
|---|---|---|
| `hook/receive` | waterfall | What a raw request becomes, or refuses it. Auth lives here |
| `hook/submit` | waterfall | Who owns the event. The outbox takes it by not calling `next()` |
| `notify/render` | waterfall | How an event becomes the message that goes out |
| `notify/target` | bail | Which channels get it, and with which mapping |
| `notify/deliver` | waterfall | What happens around one delivery: rate limit, dedupe, quiet hours |
| `notify/retry` | serial | Whether a failed attempt is tried again, and after how long |
| `notify/delivered` | emit | Observation only, after every channel settled |
| `hook/processed` | emit | One queue pass is over and the store knows about it |
| `hook/answer` | waterfall | What the caller gets back: status and body |
| `agents/declare` | waterfall | What `/agents.txt` says this instance offers an agent |

And the services, each provided by a plugin and reachable as `ctx.<name>`:

| Service | Gives you |
|---|---|
| `ctx.server` | `route(method, pattern, handler)`, returning a disposer |
| `ctx.hooks` | `submit(event, { waitMs })` to feed one in, `dispatch(event)` to send one now |
| `ctx.notify` | `register(channel)`, `names`, `settings`, `deliverTo(message, target)` |
| `ctx.store` | The history and the queue: `append`, `get`, `list`, `due`, `recordAttempt`, `stats`, plus the open questions: `saveAsk`, `getAsk`, `answerAsk` |
| `ctx.routes` | The hook definitions: `list`, `get`, `create`, `setTarget`, `preview`, `run` |
| `ctx.logger(name)` | A logger that carries that name in every line |

## A channel

```ts
export function apply(ctx: Context, config: Config): void {
  ctx.notify.register({
    name: config.channel,
    match: config.match,
    // Optional. What a target may set for itself, which the API hands to the
    // web interface so the target editor can ask for it.
    settings: [{ key: 'webhook', label: 'webhook url', secret: true }],
    async send(message, signal, settings) {
      await postJson({
        url: settings?.['webhook'] || config.webhook,
        payload: { text: `*${message.title}*\n${message.body}` },
        signal,
        timeoutMs: config.timeoutMs,
        label: config.channel,
      })
    },
  })
}
```

Declare `settings` when the destination belongs to the hook rather than to the composition. A Teams
webhook url is one Teams channel and an ntfy topic is one feed, so `channel-teams.ts` and
`channel-ntfy.ts` both put it there and one row serves every hook. Config stays the fallback, and a
target that sets nothing gets what the row says. With nothing on either, throw `ChannelSkip` from
`src/core/types.ts`: that answers `skipped` with your message instead of `failed`, so the retry policy
is not asked and the outbox does not come back for it.

Declare `actions: true` when your channel renders `message.actions` itself, the way a chat with
buttons does. Then the body stays what the caller wrote; leave it off and `notify` appends one line per
answer, which is why a channel that has never heard of a question still shows a way to answer it. Only
declare it if you render every action: a channel with a limit of its own is responsible for what it
cannot fit, and `appendActions` from `src/core/ask.ts` is there for the rest.

`send` rejects on failure and that is the whole error protocol: the retry policy and the outbox read the
rejection, not a status code. `signal` aborts when your fiber unloads, so pass it into `fetch` and a
reload never leaves a request hanging. `postJson` in `src/core/http.ts` already does both, and makes a
non-2xx read the same as it does for Telegram and ntfy. `match` is optional and mostly historical: with
the routes plugin loaded the hook decides who gets what, so a new channel usually has no matcher.

## A normalizer

A source that posts a shape of its own gets a listener, not a special case in the core:

```ts
ctx.on('hook/receive', async (raw, next) => {
  const event = await next()
  if (!event || raw.headers['x-github-event'] !== 'workflow_run') return event
  const run = (raw.json?.['workflow_run'] ?? {}) as Record<string, unknown>
  return {
    ...event,
    title: `${String(run['name'])} ${String(run['conclusion'])}`,
    level: run['conclusion'] === 'success' ? 'info' : 'error',
    url: typeof run['html_url'] === 'string' ? run['html_url'] : undefined,
  }
})
```

The hook's own auth prepends itself to this event, so your listener never sees a call nobody vouched
for. Leave `payload` alone: a template reaches into it, and rewriting it takes that away.

## A policy

```ts
ctx.on(
  'notify/deliver',
  async (message, channel, next) => {
    const key = `${channel}:${message.event.hook}:${message.title}`
    const last = seen.get(key)
    if (last !== undefined && Date.now() - last < config.windowMs) {
      return { channel, status: 'skipped', reason: 'the same message went out just now' }
    }
    seen.set(key, Date.now())
    return next()
  },
  { prepend: true },
)
```

`prepend: true` puts it outside the retry loop, so one message costs one slot however many attempts it
needs. `src/plugins/rate-limit.ts` is this pattern, 44 lines, and `src/plugins/retry.ts` is the same
idea on `notify/retry`.

## A field in the answer

```ts
ctx.on('hook/answer', async (answer, event, next) => {
  const base = await next()
  return { ...base, body: { ...base.body, ticket: await fileTicket(event) } }
})
```

Only accepted calls come past there. A refused one answers through `HookRejected` and never reaches it.

`ask.ts` is the one to read before you write anything like it. It holds the answer to a call until a
person clicks a link, and it needs no new event to do it: `hook/receive` mints the urls, `notify/render`
puts them on the message, and this seam waits and adds the block. A listener here may await for as long
as the caller is willing to wait.

## Something an agent can find

`/agents.txt` and `/agents.json` say what this instance offers an agent that starts at the root and
knows nothing else. A plugin that serves something usable declares it there itself, instead of leaving
the operator to repeat it in `cordis.yml` where it would go stale:

```ts
ctx.on('agents/declare', async (_document, origin, next) => {
  const base = await next()
  return { ...base, mcp: [...base.mcp, { url: `${origin}/mcp`, type: 'streamable-http' }] }
})
```

`origin` is the instance as this caller reached it, proxy headers included, because both files hold
absolute urls. The lists are always there, empty at worst, so spread them without checking first.
`src/plugins/skill.ts` does this for its own documents, which is why moving the skill prefix never
leaves a stale url behind.

## Mount it

Either a row in `cordis.yml`:

```yaml
- id: slack
  name: ./src/plugins/channel-slack.ts
  config:
    webhook: !!js process.env.SLACK_WEBHOOK
```

Or over the API, which writes that row for you:

```sh
curl -X POST -H 'authorization: Bearer <admin token>' -H 'content-type: application/json' \
  __BASE____API__/plugins \
  -d '{"id":"slack","name":"./src/plugins/channel-slack.ts","config":{"webhook":"https://…"}}'
```

`GET __API__/plugins` lists every entry with its fiber state and its config, `PATCH __API__/plugins/:id`
reconfigures or disables one and merges config per key, `POST __API__/plugins/:id/remount` reloads one
that is stuck in `failed`, and `DELETE __API__/plugins/:id` unmounts it and removes the row. The Plugins
tab in the web interface is those four calls.

A new row does not appear by itself: HMR watches the modules under `src`, not `cordis.yml`, so a hand
edit of the composition needs a restart. Going through the API does not.

## Rules the core relies on

1. A waterfall listener calls `next()` exactly once. Returning without it is the veto, which is how auth
   refuses a request. Calling it twice is outside the contract: cordis consumes its listener list with
   `shift()`, so a second call skips a listener instead of repeating the chain.
2. `notify/target` is dispatched with `bail` and is synchronous. Answer it from memory, never from a
   query. An empty array is an answer: this hook deliberately goes nowhere.
3. Everything you register has to leave with your fiber. `ctx.notify.register` and `ctx.server.route`
   hand back a disposer that already hangs on your context; for your own state use
   `ctx.effect(() => () => cleanup())`. A plugin that cannot be unloaded cleanly is a bug, and
   `test/lifecycle.test.ts` is where that gets proven.
4. A channel name is unique. Registering one that exists throws on purpose, so two fibers of one plugin
   need two names.
5. Node runs these sources directly with type stripping. No enums, no parameter properties, `import type`
   for anything type-only, and `.ts` in the import path.
6. Do not import a channel, a source or a store into the core. If the core has to know what your plugin
   can do, the seam is in the wrong place, and adding an event is cheaper than a special case.
7. Config is a schemastery schema, so a wrong row fails at mount with a readable message instead of at
   three in the morning.

## Verify

```sh
pnpm typecheck
node --test "test/*.test.ts"
```

A test mounts what it needs and nothing else, which is the point of the composition:

```ts
const ctx = new Context()
await ctx.plugin(hooksPlugin)
await ctx.plugin(myPlugin, { channel: 'slack', webhook: 'https://example.test' })

const results = await ctx.hooks.dispatch(event({ level: 'error' }))
assert.deepEqual(results.map((one) => one.channel), ['slack'])
await ctx.fiber.dispose()
```

`test/helpers.ts` has `event()` for a ready-made event and `captureFetch()` for asserting on the request
your channel makes without a network. Add a test that unloads your plugin and checks the registration is
gone; `test/lifecycle.test.ts` shows the shape.

Then run it for real against a scratch instance, on its own port and its own database, so nothing you do
lands in the history that matters:

```sh
HOOKY_DB=/tmp/scratch.db PORT=3999 HOOKY_SECRET=scratch node src/main.ts
curl -X POST __BASE____HOOKS__/<hook> -H 'x-hooky-secret: scratch' \
  -H 'content-type: application/json' -d '{"title":"from the new plugin"}'
```

## The other skills

- `__BASE____PREFIX__/hooky-send/SKILL.md` calls a hook.
- `__BASE____PREFIX__/hooky-manage/SKILL.md` defines hooks and says what each channel receives.
- `__BASE____PREFIX__/hooky-history/SKILL.md` answers "did it arrive, and if not why".

This document is served by the instance itself, and the same file sits in the repository at
`src/skill/hooky-plugin.md`.
