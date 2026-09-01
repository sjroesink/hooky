---
name: hooky-history
description: Find out what happened to a Hooky call: did the notification arrive, which channel failed and why, what is still queued, what a service is posting to a hook nobody defined. Also sends one again with a replay. Use when someone says a notification never came, when a call answered 202 and you want the ending, or when you need the payload a caller really sends. Calling a hook is hooky-send.
---

# What happened to a call

Every call is stored with its payload and a record per channel, so "it never arrived" is a question with
an answer. This needs the admin token: `Authorization: Bearer <admin token>`.

## Find the call

```sh
curl -H 'authorization: Bearer <token>' \
  '__BASE____API__/events?hook=urgent&outcome=failed&since=24h&limit=20'
```

| Filter | Takes |
|---|---|
| `hook` | A hook name |
| `level` | `debug` up to `critical` |
| `state` | `pending`, `done` or `rejected` |
| `outcome` | `delivered`, `partial` or `failed` |
| `channel` | Only calls that have a record for that channel |
| `search` | Substring of the title or the body |
| `since`, `until` | An epoch in ms, or `30m`, `2h`, `7d` |
| `limit`, `offset` | Paging, newest first |

`GET __API__/stats` is the summary: how many events, how many pending, the outcome counts, the per
channel counts, and the hook names that appear in the history.

## Read one

```sh
curl -H 'authorization: Bearer <token>' __BASE____API__/events/<id>
```

```json
{ "id": "34ef85…", "hook": "urgent", "level": "critical", "title": "api is down",
  "state": "pending", "outcome": null, "attempts": 2, "nextAttemptAt": 1788248112000,
  "deliveries": [ { "channel": "telegram", "status": "sent", "attempts": 1 },
                  { "channel": "ntfy", "status": "failed", "error": "fetch failed", "attempts": 3 } ],
  "payload": { "title": "api is down", "buildId": 991 } }
```

| Field | Says |
|---|---|
| `state` | `pending` while the queue still owes a pass, `done` once settled, `rejected` for a call no hook took |
| `outcome` | `delivered`, `partial` or `failed`. `null` while it is still pending |
| `attempts` | Queue passes so far, not per-channel tries |
| `nextAttemptAt` | When the next pass is due, in epoch ms |
| `deliveries` | The latest record per channel. `attempts` in there is that channel's own tries inside one pass |
| `payload` | The body as the caller sent it, which is what a template can reach |

A `pending` event with a `nextAttemptAt` in the future is not a problem, it is the queue doing its job.
The backoff grows per pass and it survives a restart. Do not send the same notification again to force
it: that is a second notification, and the first one is still coming.

## Nothing arrived at all

Work down this list, in this order:

1. `state: rejected`. No hook has that name, or the hook is switched off. The call was answered 404 or
   410 and kept anyway, payload included. `rejection.reason` says which.
2. A `skipped` delivery with "no channel named X is registered". The target names a channel that is not
   mounted right now, so the message had nowhere to go. That is a composition problem.
3. A `skipped` delivery with a matcher reason. The target's own filter did not accept this event, for
   instance a `minLevel` above the level that came in.
4. A `failed` delivery. The `error` is what the channel itself said. Telegram and ntfy answer with their
   own status text, so a 401 there is a token problem on that channel and not on the hook.
5. Nothing in the history at all. The caller never reached the instance, or it was refused before it
   became an event: a wrong secret answers 401 and is deliberately not kept.

## Calls for a hook that does not exist

```sh
curl -H 'authorization: Bearer <token>' '__BASE____API__/events?state=rejected'
```

These are the calls somebody is already making to a name nobody defined. They answer 404 to the caller
and are kept with their payload, capped at the newest 50, because that is exactly the case where you
want to see what arrives: a service is posting, the hook just does not exist yet. That payload is the
right starting point for a definition, and the `hooky-manage` skill writes the mapping over it.

## Send one again

```sh
curl -X POST -H 'authorization: Bearer <token>' __BASE____API__/events/<id>/replay
```

A replay is a new event with the same payload, carrying `replayOf` to the original, and it goes through
the hook as it stands now. So a mapping you fixed applies, and a channel that already took it gets it
again: a replay is a second notification, not a repair of the first.

A rejected call answers `409` on a replay until a hook by that name exists and is on. Define the hook
first, then replay.

## The other skills

- `__BASE____PREFIX__/hooky-send/SKILL.md` calls a hook. Needs a hook secret, not this token.
- `__BASE____PREFIX__/hooky-manage/SKILL.md` defines hooks and changes what a channel receives.

This document is served by the instance itself, so re-fetching it is how you stay current with it.
