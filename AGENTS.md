# transatlantic — agent install guide

Cross-session chat for opencode v2. Follow this file when asked to install
or use the transatlantic plugin.

## Install

```sh
opencode plugin add opencode-transatlantic
opencode api post /api/location/reload
```

Verify without spending model calls:

```sh
opencode api post /api/rpc/transatlantic/poll --data '{"input":{"ticket":"nope"}}'
```

`{"output":{}}` = loaded. `rpc.unavailable` = not loaded for this location;
reload again or check the plugin file is deployed.

## Tools (namespace `transatlantic`)

- `whoami()` — own session id.
- `register(alias)` — claim a short name for this session. Lowercase.
  Never take a name held by another live session: `register` rejects those.
  Re-claiming your own name is fine.
- `unregister(alias)` — release a name you claimed.
- `peers()` / `peers(prune=true)` — list aliases with liveness.
  `prune=true` releases names whose owner is gone.
- `ask(session, message, blocking=true, timeoutMs=180000)` — ask a peer.
  `blocking=true` polls until the answer arrives. `blocking=false` returns
  a ticket at once; the answer arrives later as a `[transatlantic]` prompt.
  Timeouts keep the ticket open and flip it to notify mode.
- `post(session, message, ticket?)` — fire-and-forget. Replies notify back.
- `answer(ticket, message)` — reply to a ticket. The tool delivers it.
- `inbox(ticket?)` — read one ticket or scan recent ones.

`session` accepts a `ses_` id or a registered alias.

## Protocol (follow strictly)

1. Inbox items marked `[transatlantic]` are agent-to-agent mail,
   never the user.
2. Reply only via `transatlantic_answer`. After the tool returns, end the
   turn: short ack at most, never the payload.
3. One admission means one turn. Never re-answer an already-answered ticket.
4. Mail is queue-only. Never interrupt, steer, or cancel another session.
5. If an alias is taken by a live session, pick another name.

## Troubleshooting

- Tool not in the model snapshot: new turns pick it up; running turns do not.
- `unknown session 'x'`: no such alias. Use a `ses_` id or have the peer
  run `transatlantic_register` first, then check `transatlantic_peers`.
- `alias 'x' owner is gone`: the entry was auto-released. Retry to claim it.
- Answer arrived late: it comes as a `[transatlantic]` prompt, or check
  `transatlantic_inbox(ticket=...)`.
