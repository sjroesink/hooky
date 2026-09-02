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

A question adds one more: `400` when the `ask.id` you brought is malformed or already used.

`outcome` is `delivered`, `partial` or `failed`, and `results` says per channel what happened: `sent`
with the attempt count, `failed` with the channel's own error, or `skipped` with a reason. A `skipped`
channel is usually a target whose filter did not accept this event, or a channel that is not mounted
right now.

**Never retry on a 202.** The queue owns the event and retries the channels itself, with backoff, and it
survives a restart. A caller that retries sends the same notification twice. `nextAttemptAt` says when
the next pass is due. If you want to know how it ended, look it up later with `hooky-history`.

## Asking a question

Send an `ask` and the call becomes a question. Hooky gives it one reply url, puts it in the
notification, and holds this call open until somebody replies.

```sh
curl -X POST __BASE____HOOKS__/<hook> \
  -H 'content-type: application/json' \
  -H 'x-hooky-secret: <the secret of that hook>' \
  -d '{"title":"Deploy 4471 to prod?","message":"12 commits, tests green",
       "ask":{"actions":[{"title":"yes"},{"title":"no"}],"wait":120}}'
```

The answer is the one above with an `ask` block added:

```json
{ "id": "34ef85…", "queued": false, "state": "done", "outcome": "delivered",
  "results": [ { "channel": "telegram", "status": "sent", "attempts": 1 } ],
  "ask": { "id": "8f2aQ1xK…",
           "replyUrl": "__BASE__/ask/reply/8f2aQ1xK…",
           "statusUrl": "__BASE__/ask/8f2aQ1xK…",
           "expiresAt": 1788251712000,
           "actions": [ { "value": "yes", "title": "yes",
                          "url": "__BASE__/ask/reply/8f2aQ1xK…/yes", "reply": true } ],
           "answered": { "action": "yes", "at": 1788251650123 } } }
```

One url answers the question, and you decide what an answer is:

| What you send | What answers it |
|---|---|
| `ask.actions`, up to five | A reply url per answer, `replyUrl/<value>`. That is what a person taps, and `answered.action` is the value they picked. Each answer is `{"title": "yes"}`, with `"value": "approve"` to name it yourself and `"url": "…"` to make it a plain link that answers nothing. |
| `ask: true`, or an ask with no actions | Nothing is rendered in the message. Post anything to `replyUrl` and that body is the answer, in `answered.data`. |
| both | An answer url takes a body too, so "yes, but" can come back with a note attached. |

How the answers look is the channel's business, not yours: Telegram and ntfy turn them into buttons,
and a channel without buttons gets one line per answer under the body. You send the same thing either
way. `replyUrl` opens as a page that lists every answer, so a person who only has that url can still
pick one.

`ask.wait` is seconds to hold this call, capped by the instance and five minutes by default. `0` sends
the question and answers at once. `answered: null` means the wait ran out while the question was still
open, and then you pick it up again:

```sh
curl "__BASE__/ask/<ask id>?wait=60"
```

That waits again and answers with the same block. Wait on it or poll it for as long as `expiresAt` is
in the future; past that nobody can answer any more.

Four rules:

- Compare `answered.action` against the `value` of an answer, never against its title.
- One answer per question. The first reply wins and every other url then says what it was.
- `answered: null` is not a no. It means nobody answered yet.
- A question nobody received is answered right away, so read `results` before you conclude anything
  from a missing answer.

And one that is not about the protocol: a question is a notification. It arrives on somebody's phone,
possibly at night, and every answer you offer is one they may pick. Ask what you are allowed to ask,
and do not ask again because the first one was not answered fast enough.

### A form as the answer

A reply may carry a body and Hooky keeps it as it came, so anything you can put in a page can be an
answer. Build the page yourself, give the question your own id, and let the page post to the reply url:

```json
{ "title": "Five questions about the sprint",
  "url": "<the page you built>",
  "ask": { "id": "b7f2c1de-4a33-4c07-9f11-2b8e5d6a1c90", "wait": 600 } }
```

The reply url is `__BASE__/ask/reply/b7f2c1de-…`, which your page can hold before you send the
question, because you chose the id. It has to be 16 to 64 characters of `[A-Za-z0-9._-]` and it has to
be random: it is the only thing keeping the question private. Using one twice answers `400`.

No actions, so nothing is rendered under the body and the reader taps the page in `url`. That page then
posts a JSON object with `accept: application/json`, and the object comes back to you as
`answered.data`. A plain `<form method="post">` works as well: the fields arrive as an object, a
repeated field as a list, and the browser lands on a page that says the answer was passed on.

The reply routes are open cross-origin, so the page can be hosted anywhere. Whoever has a reply url can
answer, so treat it like a password: the page that carries it is exactly as private as the link to that
page.

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
