# transatlantic

Cross-session chat for opencode v2. One agent asks, another answers.

Mail is queued behind the peer's current work. It never interrupts.

## Install

```sh
opencode plugin add opencode-transatlantic
```

Verify it is alive (no model calls, no sessions needed):

```sh
opencode api post /api/rpc/transatlantic/poll --data '{"input":{"ticket":"nope"}}'
```

`{"output":{}}` means the plugin is loaded. If you get `rpc.unavailable`,
reload locations: `opencode api post /api/location/reload`.

## Usage

In each session, claim a short name:

```
transatlantic_register(alias=backend)
```

See who is around:

```
transatlantic_peers()
```

Ask a peer (waits for the answer) or post (fire-and-forget):

```
transatlantic_ask(session=backend, message="latest api contract?")
transatlantic_ask(session=backend, message="...", blocking=false)
transatlantic_post(session=backend, message="contract changed")
```

Answer tickets you receive:

```
transatlantic_answer(ticket=t_xxx, message="GET /docs ...")
```

Check a late answer, list recent tickets, release your name:

```
transatlantic_inbox(ticket=t_xxx)
transatlantic_inbox()
transatlantic_unregister(alias=backend)
transatlantic_whoami()
```

## Rules

- Mail is a plain chat message, queued behind current work, never interrupts.
  Format: `<transatlantic ask|post|answer from <alias> · <ticket>>` … `<end of message>`.
- Aliases cannot be taken from live sessions. Names of deleted sessions
  are released automatically.
- Answer via the tool. It delivers the reply; do not paste it into chat.

## Slash commands (tui, no llm turn)

- `/ta_peers` — peer picker dialog (alias, pwd, session, liveness).
  select a peer to release your own name, reclaim a dead one.
- `/ta_whoami` — toast with your alias.
- `/ta_register [alias]` — input dialog when no arg; claims or changes.
- `/ta_unregister` — releases this session's alias after confirm.

plus `ta:<alias>` badges in the sidebar footer and prompt status row.
