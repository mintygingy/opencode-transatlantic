import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

// transatlantic — soft cross-session chat. queue-only, never interrupts.
//
// layout note: EVERYTHING setup needs lives INSIDE setup(). the host runs
// setup in a scope where module-level user bindings are not visible
// (ReferenceError on first module const). imports are fine, locals are fine.
// the exported Transatlantic const is only the published contract for
// external rpc clients; setup builds its own identical copy (TA) locally.
// the literal is duplicated on purpose. do not "dedupe" it.
//
// channels:
// - prompt = the single mail item. wakes the peer (user-role inbox item).
//   envelope is inline (banner + ticket + reply instructions) so one admission
//   means exactly one turn. never split into two admissions (double turns).
// - storage ticket/... = durable source of truth, inbox + aliases live here.

const CONTRACT = {
  id: "transatlantic",
  methods: {
    send: {
      input: {
        type: "object",
        properties: {
          to: { type: "string" },
          from: { type: "string" },
          ticket: { type: "string" },
          text: { type: "string" },
          kind: { type: "string", description: "ask | post | answer" },
          mode: { type: "string", description: "blocking | notify" },
          replyTo: { type: "string", description: "session to notify on answer" },
        },
        required: ["to", "from", "ticket", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" }, ticket: { type: "string" }, n: { type: "number" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    answer: {
      input: {
        type: "object",
        properties: {
          ticket: { type: "string" },
          from: { type: "string" },
          text: { type: "string" },
        },
        required: ["ticket", "from", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" }, notified: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    poll: {
      input: {
        type: "object",
        properties: { ticket: { type: "string" } },
        required: ["ticket"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    },
    release: {
      input: {
        type: "object",
        properties: { ticket: { type: "string" } },
        required: ["ticket"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    message: {
      schema: {
        type: "object",
        properties: {
          ticket: { type: "string" },
          to: { type: "string" },
          from: { type: "string" },
        },
        required: ["ticket", "to", "from"],
        additionalProperties: false,
      },
    },
  },
} as const

export const Transatlantic = Rpc.define(CONTRACT as any)

export default Plugin.define({
  id: "transatlantic",
  async setup(ctx) {
    console.log("[transatlantic] setup")
    // standing protocol preamble: every agent loop sees this, so peer agents
    // never mistake mail for user chat. short on purpose.
    await ctx.session.hook("context", (event) => {
      event.system.push({
        type: "text",
        text:
          "[transatlantic protocol] inbox items marked <transatlantic ...> are agent-to-agent mail, NOT from your user. " +
          "reply only via transatlantic_answer(ticket=..., message=...) — the tool delivers it. " +
          "after the tool returns, end your turn with no chat text at all: no ack, no echo, no summary. " +
          "peers: transatlantic_peers. claim a name: transatlantic_register.",
      })
    })
    const mem = new Map<string, string>()
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const ticketID = () => `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const shortID = (s: string) => (s.length > 14 ? s.slice(0, 12) + "…" : s)
    const endsID = (s: string) => (s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-3) : s)
    const normAlias = (a: string) => a.trim().toLowerCase()
    const ownID = (toolCtx: any): string =>
      toolCtx?.sessionID ?? toolCtx?.session?.id ?? toolCtx?.sessionId ?? "unknown"

    // alias -> session. last-write-wins.
    const aliasOf = async (sessionID: string): Promise<string | undefined> => {
      try {
        const page = await ctx.storage.scan({ prefix: "alias/", limit: 100 })
        for (const e of (page.entries as any[]) ?? []) {
          const v = (e as any).value as any
          const sid = typeof v === "string" ? v : v?.sessionID
          if (sid === sessionID) return String((e as any).key).slice("alias/".length)
        }
      } catch { /* scan failed -> no alias */ }
      return undefined
    }
    const nameOf = async (sessionID: string): Promise<string> => {
      const a = await aliasOf(sessionID)
      return a ? `${a} (${shortID(sessionID)})` : shortID(sessionID)
    }
    // shared by the register tool and the /ta_register command.
    // never takes a name held by a live session; reclaims stale ones.
    const claimAlias = async (alias: string, me: string): Promise<string> => {
      const prev = (await ctx.storage.get(`alias/${alias}`)) as any
      const prevID = typeof prev === "string" ? prev : prev?.sessionID
      if (prevID === me) return `alias ${alias} is already yours.`
      if (prevID) {
        let alive = false
        try {
          await ctx.session.get({ sessionID: prevID })
          alive = true
        } catch { alive = false }
        if (alive) {
          return (
            `alias ${alias} is taken by live session ${shortID(prevID)}. ` +
            `do NOT use it — pick another name. (peers own their names; takeovers are not allowed.)`
          )
        }
        let dir = ""
        try {
          dir = ((await ctx.session.get({ sessionID: me })) as any)?.location?.directory ?? ""
        } catch { /* best effort */ }
        await ctx.storage.set(`alias/${alias}`, { sessionID: me, updated: Date.now(), directory: dir })
        return `alias ${alias} reclaimed (previous owner ${shortID(prevID)} is gone).`
      }
      let dir = ""
      try {
        dir = ((await ctx.session.get({ sessionID: me })) as any)?.location?.directory ?? ""
      } catch { /* best effort */ }
      await ctx.storage.set(`alias/${alias}`, { sessionID: me, updated: Date.now(), directory: dir })
      return `alias ${alias} -> ${me}`
    }
    // change my name: release current (if any), claim the new one.
    const changeAlias = async (alias: string, me: string): Promise<string> => {
      const cur = await aliasOf(me)
      if (cur === alias) return `alias ${alias} is already yours.`
      const res = await claimAlias(alias, me)
      if (!res.startsWith(`alias ${alias} ->`) && !res.includes("reclaimed")) return res
      if (cur) {
        try { await ctx.storage.remove(`alias/${cur}`) } catch { /* raced */ }
        return `${res} old name ${cur} released.`
      }
      return res
    }
    const peerRow = async (alias: string, sid: string, storedDir: string): Promise<{ alias: string; pwd: string; ses: string; alive: boolean }> => {
      let alive = false
      let dir = storedDir ?? ""
      try {
        const info = (await ctx.session.get({ sessionID: sid })) as any
        alive = true
        dir = info?.location?.directory ?? dir
      } catch { alive = false }
      return { alias, pwd: dir || "?", ses: endsID(sid), alive }
    }
    const resolveTarget = async (ref: string): Promise<string> => {
      const r = ref.trim()
      if (r.startsWith("ses_")) return r
      const key = `alias/${normAlias(r)}`
      const hit = (await ctx.storage.get(key)) as any
      const sid = typeof hit === "string" ? hit : hit?.sessionID
      if (!sid) throw new Error(`unknown session '${r}'. use ses_ id or register an alias (transatlantic_register / peers).`)
      try {
        await ctx.session.get({ sessionID: sid })
      } catch {
        // owner gone: self-clean so dead names don't stack up.
        try { await ctx.storage.remove(key) } catch { /* already gone */ }
        throw new Error(`alias '${r}' owner is gone; released. owner must re-register, or claim it yourself.`)
      }
      return sid
    }
    // precise reaper: session deleted -> its aliases released immediately.
    // idle sessions are NOT dead (they still wake on prompt), only deleted ones.
    const releaseAliasOf = async (sessionID: string): Promise<number> => {
      let n = 0
      try {
        const page = await ctx.storage.scan({ prefix: "alias/", limit: 100 })
        for (const e of (page.entries as any[]) ?? []) {
          const v = (e as any).value as any
          const sid = typeof v === "string" ? v : v?.sessionID
          if (sid === sessionID) {
            try { await ctx.storage.remove(String((e as any).key)); n++ } catch { /* raced */ }
          }
        }
      } catch { /* scan failed; lazy cleanup covers it */ }
      return n
    }
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe() as AsyncIterable<any>) {
          try {
            if (ev?.type === "session.deleted" && typeof ev?.data?.sessionID === "string") {
              await releaseAliasOf(ev.data.sessionID)
            }
          } catch { /* one bad event never kills the loop */ }
        }
      } catch { /* stream ends on unload */ }
    })()

    // local contract copy. identical to the export above. see layout note.
    const TA = Rpc.define(CONTRACT as any)

    const registration = await ctx.rpc.register(TA, {
      send: async (input, _c) => {
        const { to, from, ticket, text, kind = "post", mode = "blocking", replyTo = "" } = input as any
        const prev = ((await ctx.storage.get(`ticket/${ticket}`)) as any) ?? {}
        const n = (prev.n ?? 0) + 1
        await ctx.storage.set(`ticket/${ticket}`, {
          to, from, text, status: "open", mode, replyTo, n, updated: Date.now(),
        })
        const [fromName, toName] = [await nameOf(from), await nameOf(to)]
        // ONE prompt item, queue-soft. envelope format:
        // <transatlantic {ask|post|answer} from {sender} · {ticket}>
        await ctx.session.prompt({
          sessionID: to,
          text:
            `<transatlantic ${kind} from ${fromName} · ${ticket}>\n` +
            `${text}\n` +
            `reply: transatlantic_answer(ticket=${ticket}) (to: ${toName})\n` +
            `<end of message>`,
          delivery: "queue",
        })
        await registration.events.emit("message", { ticket, to, from })
        return { ok: true, ticket, n }
      },
      answer: async (input, _c) => {
        const { ticket, from, text } = input as any
        mem.set(ticket, text)
        const prev = ((await ctx.storage.get(`ticket/${ticket}`)) as any) ?? {}
        await ctx.storage.set(`ticket/${ticket}`, {
          ...prev, status: "done", answer: text, answeredBy: from, updated: Date.now(),
        })
        await registration.events.emit("message", { ticket, to: prev?.to ?? "", from })
        // notify-back only for notify-mode tickets (blocking askers poll),
        // and only on the first answer — re-answers update text, no re-notify.
        let notified = false
        const replyTo = prev.replyTo as string | undefined
        const already = prev.status === "done"
        if (!already && prev.mode === "notify" && replyTo && replyTo !== from) {
          try {
            const fromName = await nameOf(from)
            await ctx.session.prompt({
              sessionID: replyTo,
              text:
                `<transatlantic answer from ${fromName} · ${ticket}>\n` +
                `${text}\n` +
                `continue: transatlantic_post(session=${from}, ticket=${ticket})\n` +
                `<end of message>`,
              delivery: "queue",
            })
            notified = true
          } catch { /* asker gone; answer stays in storage */ }
        }
        return { ok: true, notified }
      },
      poll: async (input, _c) => {
        const { ticket } = input as any
        if (mem.has(ticket)) return { text: mem.get(ticket)! }
        const s = ((await ctx.storage.get(`ticket/${ticket}`)) as any) ?? {}
        if (s.status === "done" && typeof s.answer === "string") {
          mem.set(ticket, s.answer)
          return { text: s.answer }
        }
        return {}
      },
      release: async (input, _c) => {
        // blocking asker gave up polling -> late answers notify back instead.
        const { ticket } = input as any
        const prev = ((await ctx.storage.get(`ticket/${ticket}`)) as any) ?? {}
        if (prev.status !== "done") {
          await ctx.storage.set(`ticket/${ticket}`, { ...prev, mode: "notify", updated: Date.now() })
        }
        return { ok: true }
      },
    })

    await ctx.tool.transform((e) => {
      e.namespace({ name: "transatlantic", description: "soft cross-session chat, queue-only" })

      e.add({
        name: "ask",
        description:
          "ask another session something. blocking=true (default) waits for the answer; " +
          "blocking=false returns a ticket at once and the answer arrives later as a <transatlantic> message.",
        input: {
          type: "object",
          properties: {
            session: { type: "string", description: "target ses_ id or alias" },
            message: { type: "string" },
            blocking: { type: "boolean", description: "wait for answer (default true)" },
            timeoutMs: { type: "number", description: "wait budget for blocking mode, default 180000" },
          },
          required: ["session", "message"],
          additionalProperties: false,
        },
        options: { namespace: "transatlantic" },
        execute: async (input, toolCtx) => {
          const { session, message, blocking = true, timeoutMs = 180000 } = input as any
          const to = await resolveTarget(session)
          const from = ownID(toolCtx)
          const ticket = ticketID()
          const api = ctx.rpc(TA)
          await api.send({ to, from, ticket, text: message, kind: "ask", mode: blocking ? "blocking" : "notify", replyTo: from })
          if (!blocking) {
            return { content: `queued to ${session} as ${ticket}. answer arrives as a <transatlantic> message; or check transatlantic_inbox(ticket=${ticket}).` }
          }
          const t0 = Date.now()
          while (Date.now() - t0 < timeoutMs) {
            if (toolCtx.signal?.aborted) {
              await api.release({ ticket })
              return { content: `stopped waiting, ticket ${ticket} stays open. late answer arrives as a <transatlantic> message.` }
            }
            const r = (await api.poll({ ticket })) as any
            if (r?.text) return { content: r.text }
            await sleep(2000)
          }
          await api.release({ ticket })
          return { content: `no answer from ${session} in ${timeoutMs}ms. ticket ${ticket} stays open, late answer arrives as a <transatlantic> message.` }
        },
      })

      e.add({
        name: "post",
        description: "fire-and-forget message to another session. soft, queued behind its current work. replies notify you back.",
        input: {
          type: "object",
          properties: {
            session: { type: "string" },
            message: { type: "string" },
            ticket: { type: "string", description: "optional existing ticket to continue" },
          },
          required: ["session", "message"],
          additionalProperties: false,
        },
        options: { namespace: "transatlantic" },
        execute: async (input, toolCtx) => {
          const { session, message, ticket = ticketID() } = input as any
          const to = await resolveTarget(session)
          const api = ctx.rpc(TA)
          await api.send({ to, from: ownID(toolCtx), ticket, text: message, kind: "post", mode: "notify", replyTo: ownID(toolCtx) })
          return { content: `queued to ${session} as ${ticket}` }
        },
      })

      e.add({
        name: "answer",
        description: "answer a transatlantic ticket you received. the tool delivers the reply; do not paste the payload into chat as well.",
        input: {
          type: "object",
          properties: {
            ticket: { type: "string" },
            message: { type: "string" },
          },
          required: ["ticket", "message"],
          additionalProperties: false,
        },
        options: { namespace: "transatlantic" },
        execute: async (input, toolCtx) => {
          const { ticket, message } = input as any
          const api = ctx.rpc(TA)
          const r = (await api.answer({ ticket, from: ownID(toolCtx), text: message })) as any
          return {
            content:
              (r?.notified ? "delivered, asker notified. " : "delivered. ") +
              "one short ack at most (e.g. answered), no payload, then end turn.",
          }
        },
      })

      e.add({
        name: "inbox",
        description: "check a ticket for an answer, or list recent tickets.",
        input: {
          type: "object",
          properties: { ticket: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
        options: { namespace: "transatlantic" },
        execute: async (input) => {
          const { ticket } = input as any
          if (ticket) {
            if (mem.has(ticket)) return { content: mem.get(ticket)! }
            const s = await ctx.storage.get(`ticket/${ticket}`)
            return { content: JSON.stringify(s ?? { status: "unknown", ticket }) }
          }
          const page = await ctx.storage.scan({ prefix: "ticket/", limit: 20 })
          return { content: JSON.stringify(page.entries, null, 2) }
        },
      })

      e.add({
        name: "register",
        description:
          "claim a short alias for this session. NEVER take over a name held by another live session — " +
          "register rejects taken aliases; pick another name instead.",
        input: {
          type: "object",
          properties: { alias: { type: "string" } },
          required: ["alias"],
          additionalProperties: false,
        },
        options: { namespace: "transatlantic" },
        execute: async (input, toolCtx) => {
          const alias = normAlias((input as any).alias ?? "")
          if (!alias) return { content: "alias must be non-empty." }
          return { content: await claimAlias(alias, ownID(toolCtx)) }
        },
      })

      e.add({
        name: "unregister",
        description: "release an alias you claimed.",
        input: {
          type: "object",
          properties: { alias: { type: "string" } },
          required: ["alias"],
          additionalProperties: false,
        },
        options: { namespace: "transatlantic" },
        execute: async (input, toolCtx) => {
          const alias = normAlias((input as any).alias ?? "")
          const hit = (await ctx.storage.get(`alias/${alias}`)) as any
          const sid = typeof hit === "string" ? hit : hit?.sessionID
          if (!sid) return { content: `alias ${alias} not claimed.` }
          if (sid !== ownID(toolCtx)) return { content: `alias ${alias} belongs to ${shortID(sid)}, not you.` }
          await ctx.storage.remove(`alias/${alias}`)
          return { content: `alias ${alias} released.` }
        },
      })

      e.add({
        name: "peers",
        description:
          "list claimed session aliases and whether they still exist. " +
          "prune=true also releases names whose owner is gone (opt-in sweep).",
        input: {
          type: "object",
          properties: { prune: { type: "boolean", description: "release dead names, default false" } },
          required: [],
          additionalProperties: false,
        },
        options: { namespace: "transatlantic" },
        execute: async (input) => {
          const { prune = false } = (input as any) ?? {}
          const page = await ctx.storage.scan({ prefix: "alias/", limit: 100 })
          const out: any[] = []
          let pruned = 0
          for (const en of (page.entries as any[]) ?? []) {
            const key = String((en as any).key)
            const alias = key.slice("alias/".length)
            const v = (en as any).value as any
            const sid = typeof v === "string" ? v : v?.sessionID
            if (!sid) {
              if (prune) {
                try { await ctx.storage.remove(key); pruned++ } catch { /* raced */ }
              }
              continue
            }
            const row = await peerRow(alias, sid, typeof v === "string" ? "" : v?.directory ?? "")
            if (!row.alive && prune) {
              try { await ctx.storage.remove(key); pruned++ } catch { /* raced */ }
            } else {
              out.push({ ...row, drop: `/ta_unregister ${alias}` })
            }
          }
          const list = out.length ? JSON.stringify(out, null, 2) : "no aliases claimed yet. use transatlantic_register."
          return { content: prune ? `${list}\npruned: ${pruned}` : list }
        },
      })

      e.add({
        name: "whoami",
        description: "print your own session id so you can share it with a peer session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "transatlantic" },
        execute: async (_input, toolCtx) => {
          return { content: ownID(toolCtx) }
        },
      })
    })
    console.log("[transatlantic] tools registered")

    // slash commands. void executes: display goes through synthetic
    // annotations (no host modal api exists for plugins). no turn burned.
    await ctx.command.transform((c) => {
      const argOf = (text: string, name: string) =>
        (text ?? "").replace(new RegExp(`^/?${name}\\b`, "i"), "").trim()
      const show = async (sessionID: string, text: string) => {
        await ctx.session.synthetic({
          sessionID,
          id: `msg_ta_note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          text,
          delivery: "queue",
        })
      }
      const table = async (): Promise<string> => {
        const page = await ctx.storage.scan({ prefix: "alias/", limit: 100 })
        const rows: string[] = []
        for (const en of (page.entries as any[]) ?? []) {
          const alias = String((en as any).key).slice("alias/".length)
          const v = (en as any).value as any
          const sid = typeof v === "string" ? v : v?.sessionID
          if (!sid) continue
          const r = await peerRow(alias, sid, typeof v === "string" ? "" : v?.directory ?? "")
          rows.push(`| ${r.alias} | ${r.pwd} | ${r.ses} | ${r.alive ? "yes" : "NO"} | \`/ta_unregister ${alias}\` |`)
        }
        return rows.length
          ? `| alias | pwd | ses | alive | drop |\n|---|---|---|---|---|\n${rows.join("\n")}`
          : "no peers yet. claim a name: /ta_register <alias>"
      }
      c.add({
        name: "ta_peers",
        description: "list transatlantic peers: alias, pwd, session, drop shortcut",
        execute: async (input) => {
          await show(input.sessionID, await table())
        },
      })
      c.add({
        name: "ta_whoami",
        description: "show your transatlantic alias",
        execute: async (input) => {
          const a = await aliasOf(input.sessionID)
          await show(
            input.sessionID,
            a
              ? `transatlantic alias: ${a} (${input.sessionID})`
              : "no transatlantic alias. claim one: /ta_register <alias>",
          )
        },
      })
      c.add({
        name: "ta_register",
        description: "claim or change your transatlantic alias: /ta_register <alias>",
        execute: async (input) => {
          const arg = normAlias(argOf(input.prompt.text ?? "", "ta_register"))
          if (!arg) {
            await show(input.sessionID, "usage: /ta_register <alias>")
            return
          }
          await show(input.sessionID, await changeAlias(arg, input.sessionID))
        },
      })
      c.add({
        name: "ta_unregister",
        description: "release a transatlantic alias: /ta_unregister <alias>",
        execute: async (input) => {
          const arg = normAlias(argOf(input.prompt.text ?? "", "ta_unregister"))
          if (!arg) {
            await show(input.sessionID, "usage: /ta_unregister <alias>")
            return
          }
          const hit = (await ctx.storage.get(`alias/${arg}`)) as any
          const sid = typeof hit === "string" ? hit : hit?.sessionID
          if (!sid) {
            await show(input.sessionID, `alias ${arg} not claimed.`)
            return
          }
          if (sid !== input.sessionID) {
            await show(input.sessionID, `alias ${arg} belongs to ${shortID(sid)}, not you.`)
            return
          }
          await ctx.storage.remove(`alias/${arg}`)
          await show(input.sessionID, `alias ${arg} released.`)
        },
      })
    })
  },
})
