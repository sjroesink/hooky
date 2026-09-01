---
name: hooky-send
description: Send a notification through Hooky by calling a hook that already exists. Use when a script, a service or an agent has to report something outward, to Telegram, ntfy, a log or whatever channel that hook has, or when a call to a hook answers 401, 404 or 410. Defining or changing a hook is hooky-manage.
---

# Calling a hook

Hooky turns an HTTP call into a notification. A hook is a named endpoint with its own secret. Which
channels it reaches, and how the message reads on each, is decided by the hook and not by this call. A
channel is whatever the instance has registered: a phone, a chat, a log, another service.

You need two things: the name of a hook and the secret of that hook. That secret is not the admin token,
and it is not shared between hooks.

__DEFINED__

## The call

```sh
curl -X POST __BASE____HOOKS__/<hook> \
  -H 'content-type: application/json' \
  -H 'x-hooky-secret: <the secret of that hook>' \
  -d '{"title":"api is down","message":"3 checks failed in a row","level":"error"}'
```

Fields, all optional:

| Field | Meaning |
|---|---|
| `title` | The headline. Falls back to the hook name. |
| `message` | The body. `body` works too. |
| `level` | `debug`, `info`, `warning`, `error`, `critical`. Anything else becomes `info`. |
| `url` | A link to click through to. |
| `tags` | Array of strings. |

Everything else you send is kept as the payload, and the hook can put it in the message with
`{{payload.your.field}}`. So send the build number, the branch, the run id: it costs nothing here and it
is the difference between a useful notification and a vague one. A body that is not JSON is taken as the
message.

The level is urgency, not routing. On a channel that reaches a phone it sets the ntfy priority and
whether Telegram makes a sound; on a channel that writes a log it is just a word. It never decides which
channels a call reaches, so raising the level to be heard is the wrong move: that is a change to the
hook.

## The answer

The call waits for the queue to work the event off, so the answer says what happened:

```json
{ "id": "34ef85…", "hook": "urgent", "queued": false, "state": "done",
  "outcome": "delivered", "attempts": 1, "nextAttemptAt": null,
  "results": [ { "channel": "telegram", "status": "sent", "attempts": 1 } ] }
```

| Status | Means | What to do |
|---|---|---|
| `200` | Settled. Nothing is owed any more. | Read `outcome` and `results`. Done. |
| `202` | Accepted, a pass is still to come. | Nothing. Never retry, see below. |
| `400` | The body is not a JSON object. | Fix the body. |
| `401` | Wrong or missing secret. | Ask for the right one. Do not guess, and do not try another hook's secret. |
| `404` | No hook by that name. | Do not invent one. Ask which hook to use, or define it with `hooky-manage`. |
| `410` | The hook exists but is switched off. | Somebody switched it off on purpose. Ask before turning it on. |
| `413` | The body is too large. | Send less. |

`outcome` is `delivered`, `partial` or `failed`, and `results` says per channel what happened: `sent`
with the attempt count, `failed` with the channel's own error, or `skipped` with a reason. A `skipped`
channel is usually a target whose filter did not accept this event, or a channel that is not mounted
right now.

**Never retry on a 202.** The queue owns the event and retries the channels itself, with backoff, and it
survives a restart. A caller that retries sends the same notification twice. `nextAttemptAt` says when
the next pass is due. If you want to know how it ended, look it up later with `hooky-history`.

## When you must not wait

```sh
curl -X POST __BASE____HOOKS__/<hook>/async -H 'x-hooky-secret: <secret>' \
  -H 'content-type: application/json' -d '{"title":"fire and forget"}'
```

That door answers `202` the moment the event is stored, with `results: []`, and never waits for a
channel. Use it when a slow channel must not hold up your own work: a hot path, a client with a one
second timeout, a shell script that only wants to know the call was taken. The event is just as safe as
on the plain route.

## The other skills

- `__BASE____PREFIX__/hooky-manage/SKILL.md` defines hooks, changes what a channel receives, rotates a
  secret. Needs the admin token.
- `__BASE____PREFIX__/hooky-history/SKILL.md` answers "did it arrive, and if not why", and sends one
  again. Needs the admin token.

This document is served by the instance itself, so re-fetching it is how you stay current with it.
