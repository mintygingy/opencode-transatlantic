import { Plugin } from "@opencode/plugin/tui"
import { Transatlantic } from "opencode-transatlantic"

// tui side of transatlantic. intentionally JSX-free: the host's tsx pipeline
// in 2.0.18 is unreliable for third-party components (react/jsxDEV resolution,
// DOM Element assumptions in slot renderers). client-side slash commands,
// real input/select dialogs and toasts need no JSX at all.
// sidebar badges deferred until the host tsx story solidifies.

export default Plugin.define({
  id: "transatlantic.cli",
  setup(context) {
    context.ui.toast.show({ message: "transatlantic tui loaded", variant: "success" })

    const currentSession = (): string | undefined => {
      try {
        const r = context.ui.router.current() as any
        return r?.type === "session" && typeof r.sessionID === "string" ? r.sessionID : undefined
      } catch {
        return undefined
      }
    }

    try {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "transatlantic.peers",
            title: "Transatlantic: peers",
            group: "Transatlantic",
            palette: true,
            slash: { name: "ta_peers" },
            run: async () => {
              const ta = context.client.rpc(Transatlantic)
              const { peers } = (await ta.peers({})) as any
              if (!peers?.length) {
                context.ui.toast.show({ message: "no peers. claim a name: /ta_register <alias>" })
                return
              }
              const picked = await context.ui.dialog.select({
                title: "peers",
                options: peers.map((p: any) => ({
                  title: p.alias,
                  value: p.alias,
                  description: `${p.pwd} · ${p.session.slice(0, 6)}…${p.session.slice(-3)}${p.alive ? "" : " · GONE"}`,
                })),
              })
              if (!picked) return
              const peer = peers.find((p: any) => p.alias === picked)
              if (!peer) return
              const mySession = currentSession()
              if (!peer.alive) {
                context.ui.toast.show({
                  message: `owner of ${peer.alias} is gone. claim it: /ta_register ${peer.alias}`,
                })
                return
              }
              if (!mySession || peer.session !== mySession) {
                context.ui.toast.show({ message: `${peer.alias} belongs to another live session.` })
                return
              }
              const yes = await context.ui.dialog.confirm({
                title: `release ${peer.alias}?`,
                message: "other sessions will no longer reach you by this name.",
                label: { confirm: "release", cancel: "keep" },
              })
              if (!yes) return
              const r = (await ta.releaseAlias({ alias: peer.alias, sessionID: mySession })) as any
              context.ui.toast.show({ message: r.message, variant: r.ok ? "success" : "error" })
            },
          },
          {
            id: "transatlantic.whoami",
            title: "Transatlantic: whoami",
            group: "Transatlantic",
            palette: true,
            slash: { name: "ta_whoami" },
            run: async () => {
              const me = currentSession()
              if (!me) {
                context.ui.toast.show({ message: "open a session first." })
                return
              }
              const ta = context.client.rpc(Transatlantic)
              const r = (await ta.lookup({ sessionID: me })) as any
              context.ui.toast.show({
                message: r?.alias ? `alias: ${r.alias}` : "no alias. claim one: /ta_register <alias>",
              })
            },
          },
          {
            id: "transatlantic.register",
            title: "Transatlantic: register",
            group: "Transatlantic",
            palette: true,
            slash: { name: "ta_register", arguments: true },
            run: async (input) => {
              const me = currentSession()
              if (!me) {
                context.ui.toast.show({ message: "open a session first." })
                return
              }
              const typed = typeof input === "string" ? input.trim().toLowerCase() : ""
              const alias =
                typed ||
                (await context.ui.dialog.prompt({ title: "alias", placeholder: "backend" }))?.trim().toLowerCase()
              if (!alias) return
              const ta = context.client.rpc(Transatlantic)
              const r = (await ta.claim({ alias, sessionID: me })) as any
              context.ui.toast.show({ message: r.message, variant: r.ok ? "success" : "error" })
            },
          },
          {
            id: "transatlantic.unregister",
            title: "Transatlantic: unregister",
            group: "Transatlantic",
            palette: true,
            slash: { name: "ta_unregister" },
            run: async () => {
              const me = currentSession()
              if (!me) {
                context.ui.toast.show({ message: "open a session first." })
                return
              }
              const ta = context.client.rpc(Transatlantic)
              const mine = (await ta.lookup({ sessionID: me })) as any
              if (!mine?.alias) {
                context.ui.toast.show({ message: "this session has no alias." })
                return
              }
              const yes = await context.ui.dialog.confirm({
                title: `release ${mine.alias}?`,
                message: "other sessions will no longer reach you by this name.",
                label: { confirm: "release", cancel: "keep" },
              })
              if (!yes) return
              const r = (await ta.releaseAlias({ alias: mine.alias, sessionID: me })) as any
              context.ui.toast.show({ message: r.message, variant: r.ok ? "success" : "error" })
            },
          },
        ],
      }))
    } catch (e) {
      console.error("[transatlantic] keymap layer failed", e)
    }
  },
})
