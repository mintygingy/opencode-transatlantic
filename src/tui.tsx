import { Show, createResource } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { Transatlantic } from "opencode-transatlantic"

// tui side of transatlantic. client-side slash commands (no llm turn),
// real input/select dialogs, sidebar + footer alias badges.
// all state lives server-side; everything here goes through our rpc.

function currentSessionID(): string | undefined {
  try {
    const context = usePlugin()
    const r = context.ui.router.current() as any
    return r?.type === "session" && typeof r.sessionID === "string" ? r.sessionID : undefined
  } catch {
    return undefined
  }
}

function rpc() {
  return usePlugin().client.rpc(Transatlantic)
}

function AliasBadge(props: { sessionID?: string }) {
  const sid = () => props.sessionID ?? currentSessionID()
  const [alias] = createResource(sid, async (id) => {
    if (!id) return null
    try {
      const r = (await rpc().lookup({ sessionID: id })) as any
      return typeof r?.alias === "string" ? r.alias : null
    } catch {
      return null
    }
  })
  return (
    <Show when={alias()}>
      <text>ta:{alias()}</text>
    </Show>
  )
}

export default Plugin.define({
  id: "transatlantic.cli",
  setup(context) {
    const disposers: Array<() => void> = []
    const keep = (d: unknown) => {
      if (typeof d === "function") disposers.push(d as () => void)
    }

    keep(
      context.ui.slot({
        append: "sidebar.footer",
        render: (props: any) => <AliasBadge sessionID={props?.sessionID} />,
      }),
    )
    keep(
      context.ui.slot({
        append: "prompt.footer.status",
        render: (props: any) => <AliasBadge sessionID={props?.sessionID} />,
      }),
    )

    keep(
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
              const me = context.ui.router.current() as any
              const mySession = me?.type === "session" ? me.sessionID : undefined
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
              const me = context.ui.router.current() as any
              if (me?.type !== "session") {
                context.ui.toast.show({ message: "open a session first." })
                return
              }
              const ta = context.client.rpc(Transatlantic)
              const r = (await ta.lookup({ sessionID: me.sessionID })) as any
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
              const me = context.ui.router.current() as any
              if (me?.type !== "session") {
                context.ui.toast.show({ message: "open a session first." })
                return
              }
              const typed = typeof input === "string" ? input.trim().toLowerCase() : ""
              const alias =
                typed ||
                (await context.ui.dialog.prompt({ title: "alias", placeholder: "backend" }))?.trim().toLowerCase()
              if (!alias) return
              const ta = context.client.rpc(Transatlantic)
              const r = (await ta.claim({ alias, sessionID: me.sessionID })) as any
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
              const me = context.ui.router.current() as any
              if (me?.type !== "session") {
                context.ui.toast.show({ message: "open a session first." })
                return
              }
              const ta = context.client.rpc(Transatlantic)
              const mine = (await ta.lookup({ sessionID: me.sessionID })) as any
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
              const r = (await ta.releaseAlias({ alias: mine.alias, sessionID: me.sessionID })) as any
              context.ui.toast.show({ message: r.message, variant: r.ok ? "success" : "error" })
            },
          },
        ],
      })),
    )

    return () => disposers.forEach((d) => {
      try {
        d()
      } catch { /* unload race */ }
    })
  },
})
