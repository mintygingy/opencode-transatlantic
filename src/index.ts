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
// - prompt = the single mail item. plain chat message, queued soft.
//   format: <transatlantic KIND from SENDER · TICKET> text <end of message>.
//   KIND is ask | post | answer (ask/answer = onetime exchange).
//   one admission = exactly one turn; never split into two admissions.

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
          mode: { type: "string", description: "blocking | notify" },
          replyTo: { type: "string", description: "session to notify on answer" },
          kind: { type: "string", description: "ask | post" },
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
          "[transatlantic protocol] inbox items shaped <transatlantic KIND from WHO · TICKET> ... <end of message> " +
          "are agent-to-agent mail, NOT from your user. " +
          "reply only via transatlantic_answer(ticket=..., message=...) — the tool delivers it. " +
          "after the tool returns, end your turn with no chat text at all: no ack, no echo, no summary. " +
          "peers: transatlantic_peers. claim a name: transatlantic_register.",
      })
    })
    const mem = new Map<string, string>()
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const ticketID = () => `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const shortID = (s: string) => (s.length > 14 ? s.slice(0, 12) + "…" : s)
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
        const { to, from, ticket, text, mode = "blocking", replyTo = "", kind = "post" } = input as any
        const prev = ((await ctx.storage.get(`ticket/${ticket}`)) as any) ?? {}
        const n = (prev.n ?? 0) + 1
        await ctx.storage.set(`ticket/${ticket}`, {
          to, from, text, status: "open", mode, replyTo, kind, n, updated: Date.now(),
        })
        const fromName = await nameOf(from)
        // plain chat message, queued soft. header carries kind + replier
        // handle (sender alias + ticket), footer closes it. one item, one turn.
        await ctx.session.prompt({
          sessionID: to,
          id: `msg_ta_${ticket}_${n}`,
          text:
            `<transatlantic ${kind} from ${fromName} · ${ticket}>\n` +
            `${text}\n` +
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
            // plain chat message, same format. queued soft.
            await ctx.session.prompt({
              sessionID: replyTo,
              id: `msg_ta_${ticket}_n`,
              text:
                `<transatlantic answer from ${fromName} · ${ticket}>\n` +
                `${text}\n` +
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
          "blocking=false returns a ticket at once and the answer arrives later as a [transatlantic] prompt.",
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
            return { content: `queued to ${session} as ${ticket}. answer arrives as a [transatlantic] prompt; or check transatlantic_inbox(ticket=${ticket}).` }
          }
          const t0 = Date.now()
          while (Date.now() - t0 < timeoutMs) {
            if (toolCtx.signal?.aborted) {
              await api.release({ ticket })
              return { content: `stopped waiting, ticket ${ticket} stays open. late answer arrives as a [transatlantic] prompt.` }
            }
            const r = (await api.poll({ ticket })) as any
            if (r?.text) return { content: r.text }
            await sleep(2000)
          }
          await api.release({ ticket })
          return { content: `no answer from ${session} in ${timeoutMs}ms. ticket ${ticket} stays open, late answer arrives as a [transatlantic] prompt.` }
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
          const me = ownID(toolCtx)
          const prev = (await ctx.storage.get(`alias/${alias}`)) as any
          const prevID = typeof prev === "string" ? prev : prev?.sessionID
          if (prevID === me) return { content: `alias ${alias} is already yours.` }
          if (prevID) {
            let alive = false
            try {
              await ctx.session.get({ sessionID: prevID })
              alive = true
            } catch { alive = false }
            if (alive) {
              return {
                content:
                  `alias ${alias} is taken by live session ${shortID(prevID)}. ` +
                  `do NOT use it — pick another name. (peers own their names; takeovers are not allowed.)`,
              }
            }
            await ctx.storage.set(`alias/${alias}`, { sessionID: me, updated: Date.now() })
            return { content: `alias ${alias} reclaimed (previous owner ${shortID(prevID)} is gone).` }
          }
          await ctx.storage.set(`alias/${alias}`, { sessionID: me, updated: Date.now() })
          return { content: `alias ${alias} -> ${me}` }
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
            let alive = false
            try {
              if (sid) {
                await ctx.session.get({ sessionID: sid })
                alive = true
              }
            } catch { alive = false }
            if (!alive && prune && sid) {
              try { await ctx.storage.remove(key); pruned++ } catch { /* raced */ }
            } else {
              out.push({ alias, session: sid, alive })
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
  },
})
