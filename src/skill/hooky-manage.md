---
name: hooky-manage
description: Define, change and remove Hooky hooks: a new webhook endpoint, another channel on an existing hook, what the message looks like per channel, a rotated secret, a hook switched off. Use when someone asks for a webhook to post to, when a call answers 404 because no hook has that name, or when a notification arrives with the wrong wording, level or filter. Sending a notification is hooky-send.
---

# Defining and changing hooks

A hook is a row in the database, not a piece of wiring. It has a name, its own secret, and a list of
targets; a target names a channel and, optionally, what the message to that channel looks like. The same
call can read one way on Telegram and another way on ntfy.

Everything here needs the admin token: `Authorization: Bearer <admin token>`. That token is not a hook
secret. Never hand it to a caller: a caller gets the secret of its own hook and nothing else.

Channels registered right now: __CHANNELS__. A target may name a channel that does not exist, and
`GET __API__/hooks` marks it `missing: true`. Adding a channel is a change to the composition and not to
a hook, so that is a job for whoever runs the server.

__DEFINED__

## Define one

```sh
curl -X POST -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  __BASE____API__/hooks \
  -d '{"name":"deploy","description":"CI tells me when a release lands",
       "targets":[{"channel":"telegram"}]}'
```

The answer carries the secret once:

```json
{ "hook": { "name": "deploy", "hasSecret": true, "targets": [ … ] },
  "secret": "hk_…", "note": "shown once, not stored" }
```

The server keeps only its SHA-256, so a lost secret is a rotate and never a lookup. Hand it to whoever
calls the hook and store it where they can find it again. `"secret": false` defines an open hook that
anyone who knows the name can post to; `"secret": "hk_…"` supplies one you already have.

A hook name has to survive being a path segment: letters, digits, dot, dash, underscore.

## Say what a channel receives

```sh
curl -X PUT -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  __BASE____API__/hooks/deploy/targets/telegram \
  -d '{"map":{"title":"FIRE {{title}}","body":"{{message}}\n\nbuild {{payload.buildId}}","level":"critical"},
       "match":{"minLevel":"warning"}}'
```

`map` is what goes out, `match` is an extra filter for this channel only. Setting the same channel again
replaces that target; it never adds a second one.

| In a map | Is |
|---|---|
| `title`, `body`, `url` | Templates. A field the map does not mention keeps what came in |
| `level` | A fixed override, not a template. Decides ntfy priority and Telegram sound |
| `tags` | Templates as well, and they replace the event's tags |

| In a match | Is |
|---|---|
| `minLevel` | Only from this level up. `{"minLevel":"error"}` keeps the noise off one channel |
| `tags` | Only when the event carries one of these |

An empty value inside a target means "leave this alone", never "make this empty". So dropping a mapping
is `{"map":{}}`, and a `tags: []` does not wipe the event's tags.

## When the channel needs the destination

Some channels take the destination from the target rather than from the composition, because the
destination is part of what this hook does: a Workflows webhook url is one Teams channel, an ntfy topic
is one feed on somebody's phone.

```sh
curl -X PUT -H 'authorization: Bearer <token>' -H 'content-type: application/json'   __BASE____API__/hooks/deploy/targets/teams   -d '{"settings":{"webhook":"https://…/triggers/manual/paths/invoke?…&sig=…"}}'
```

`GET __API__/channels` lists, per channel, the settings it accepts: the key, a label, and whether it is
a credential. Ask that before you invent a key, because a channel ignores what it did not declare. What
teams takes:

| Setting | Is |
|---|---|
| `webhook` | The Workflows trigger url. Which Teams channel this target posts in |
| `format` | `card` for an Adaptive Card, `text` for a flow built around a plain string |

And what ntfy takes:

| Setting | Is |
|---|---|
| `topic` | The topic this target publishes to. Anyone who knows a topic can read it |
| `server` | Only for a target on another instance than the row |
| `token` | For a protected topic the row's token does not cover |

Two hooks posting in two Teams channels, or on two ntfy topics, is two targets with two settings, not
two plugins. Leave the setting out and the channel falls back to its own row, which may have nothing:
then the delivery is **skipped**, with `no topic: set one on this target, or a default on the ntfy row`
as the reason. That is the fix, not a bug to report, and a skip is never retried.

## A hook that asks something back

Nothing to define. A hook is a hook, and a caller turns one call into a question by sending an `ask`
in the payload; `hooky-send` is the document for that side. What matters here is that the answers go
out over the channels this hook already has, so a hook that asks should reach a person and not a log.
A question on a hook whose only target writes to disk is a question nobody will ever answer.

## A hook a program listens to

If the instance has an `sse` channel, coupling it to a hook makes that hook readable as a live stream:

```sh
curl -X PUT -H 'authorization: Bearer <token>' __BASE____API__/hooks/<hook>/targets/sse -d '{}'
```

After that `GET __BASE__/sse/<hook>` is a stream of every event on that hook, for whoever holds the
admin token or that hook's own secret. Without the target the stream endpoint answers 409, on purpose:
a stream that can never carry anything looks like a broken connection.

It is a channel like any other, so `skipped · nobody is listening on this hook` in the history means
exactly that and is not a fault to chase.

## Templates

`{{path}}` resolves against the event. A path that resolves to nothing becomes an empty string, an
object becomes compact JSON, an array is joined with commas. There is no escaping and no logic: a
channel escapes what it needs itself.

| Path | Is |
|---|---|
| `{{title}}` | The title as it came in |
| `{{message}}` | The body as it came in |
| `{{hook}}` | The hook name |
| `{{level}}` | The level as it came in |
| `{{url}}`, `{{id}}`, `{{tags}}`, `{{receivedAt}}` | The other event fields |
| `{{payload.a.b}}`, `{{payload.items.0.name}}` | Anything in the body the caller posted |

Write templates over a payload that exists. Ask the caller for a real request body, or take one from a
call that already came in: `GET __API__/events/<id>` carries the payload, and
`GET __API__/events?state=rejected` carries the ones for a hook nobody defined yet.

## Try it before you trust it

```sh
# what the templates produce, per channel, sending nothing
curl -X POST -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  __BASE____API__/hooks/deploy/preview -d '{"title":"api is down","buildId":991}'

# and the real thing, to one channel
curl -X POST -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  __BASE____API__/hooks/deploy/targets/telegram/run \
  -d '{"payload":{"title":"api is down","buildId":991},"map":{"title":"trying this"}}'
```

`preview` answers what the template does. `run` sends it for real over the channel, because how a
message lands is a question about Telegram and not about the template. A `map` or `match` in a `run`
body replaces the stored one for that run only, so a mapping can be tried before it is saved. A run is
not an event: it is never stored and never queued.

## The rest of the surface

| Endpoint | Does |
|---|---|
| `GET __API__/hooks` | Every definition, with `missing: true` on a target whose channel is gone |
| `GET __API__/hooks/:name` | One definition |
| `PATCH __API__/hooks/:name` | Change `description`, `disabled`, or the whole `targets` list |
| `DELETE __API__/hooks/:name/targets/:channel` | Remove one target |
| `POST __API__/hooks/:name/rotate` | New secret, shown once. The old one stops working immediately |
| `DELETE __API__/hooks/:name` | Remove the hook. Calls to that name answer 404 after this |
| `GET __API__/channels` | The channels that exist, the settings each takes per target, and what they delivered |
| `GET __API__/hooks?include=hash` | Every definition with its hash, which is the backup format |
| `PUT __API__/hooks` | Replace every definition with `{"hooks": [...]}` from such a backup |

`GET __API__/describe` is the machine-readable catalogue of all of it. Read that when this document and
the instance disagree, because the catalogue comes from the code.

## Rules that keep this clean

1. Do not define a hook nobody asked for. A hook decides what gets told to whom, and on a channel that
   reaches a phone that is somebody's night. Ask.
2. Switching a hook off is `PATCH {"disabled": true}` and keeps its history. Removing it is final and
   makes every call answer 404.
3. Rotating breaks every caller that still holds the old secret. Have somewhere to put the new one
   before you rotate.
4. Keep `critical` for what should interrupt somebody. It is one level for every channel of the hook,
   and a hook that maps everything to critical is a hook people mute.
5. One call is one notification. Do not tell a caller to post twice: add a target and let the hook fan
   out.
6. A setting marked as a credential, like a Teams webhook url, is readable through this API and lands
   in a backup from `GET __API__/hooks?include=hash`. Do not paste one into a ticket, a commit or a
   screenshot, and treat that backup the way you treat an environment file.
7. A reply link to an open question is a capability: whoever holds it answers the question, with no
   secret of their own. They sit in the database until they expire, so a copy of the file is a copy of
   every open question. Nothing to configure, only something to know before you pass one on.

## The other skills

- `__BASE____PREFIX__/hooky-send/SKILL.md` calls a hook. Needs a hook secret, not this token.
- `__BASE____PREFIX__/hooky-history/SKILL.md` answers "did it arrive, and if not why", and sends one
  again.

This document is served by the instance itself, so re-fetching it is how you stay current with it.
