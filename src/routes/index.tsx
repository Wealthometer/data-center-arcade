import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Data Center — Live Visualizer" },
      { name: "description", content: "Interactive browser-based data center: spin up servers, watch CPUs, load balance traffic." },
      { property: "og:title", content: "Data Center — Live Visualizer" },
      { property: "og:description", content: "Interactive browser-based data center: spin up servers, watch CPUs, load balance traffic." },
    ],
  }),
  component: DataCenter,
});

type Server = {
  id: string;
  name: string;
  cpus: number;
  load: number[]; // per cpu, 0..1
  status: "online" | "offline" | "overloaded";
};

type Packet = {
  id: number;
  serverId: string;
  cpuIndex: number;
  progress: number; // 0..1 along path
  size: number;
};

type State = {
  servers: Server[];
  strategy: "round-robin" | "least-loaded" | "random";
  trafficRate: number; // packets per tick
  totalProcessed: number;
  dropped: number;
};

const STORAGE_KEY = "datacenter-state-v1";

function makeServer(idx: number, cpus = 4): Server {
  return {
    id: `srv-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
    name: `node-${String(idx).padStart(2, "0")}`,
    cpus,
    load: Array(cpus).fill(0),
    status: "online",
  };
}

function loadState(): State {
  if (typeof window === "undefined") return defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as State;
    // sanity
    if (!parsed.servers) return defaultState();
    return parsed;
  } catch {
    return defaultState();
  }
}

function defaultState(): State {
  return {
    servers: [makeServer(1, 4), makeServer(2, 4), makeServer(3, 6)],
    strategy: "least-loaded",
    trafficRate: 3,
    totalProcessed: 0,
    dropped: 0,
  };
}

function DataCenter() {
  const [state, setState] = useState<State>(() => defaultState());
  const [packets, setPackets] = useState<Packet[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const rrIndex = useRef(0);
  const packetId = useRef(0);

  // hydrate from localStorage after mount (SSR-safe)
  useEffect(() => {
    setState(loadState());
    setHydrated(true);
  }, []);

  // persist
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, hydrated]);

  // simulation tick
  useEffect(() => {
    const interval = setInterval(() => {
      setState((s) => {
        // CPU load decay + completion accounting will happen with packets,
        // but also natural decay to avoid stuck high values
        const servers = s.servers.map((srv) => {
          if (srv.status === "offline") {
            return { ...srv, load: srv.load.map(() => 0) };
          }
          const load = srv.load.map((l) => Math.max(0, l - 0.04));
          const avg = load.reduce((a, b) => a + b, 0) / load.length;
          const status: Server["status"] = avg > 0.9 ? "overloaded" : "online";
          return { ...srv, load, status };
        });
        return { ...s, servers };
      });

      // spawn traffic
      setPackets((prev) => {
        const next = [...prev];
        // advance existing packets
        for (let i = next.length - 1; i >= 0; i--) {
          next[i] = { ...next[i], progress: next[i].progress + 0.04 };
          if (next[i].progress >= 1) {
            const done = next[i];
            // apply load to target cpu
            setState((s) => {
              const servers = s.servers.map((srv) => {
                if (srv.id !== done.serverId) return srv;
                const load = srv.load.slice();
                load[done.cpuIndex] = Math.min(1, load[done.cpuIndex] + done.size);
                return { ...srv, load };
              });
              return { ...s, servers, totalProcessed: s.totalProcessed + 1 };
            });
            next.splice(i, 1);
          }
        }
        return next;
      });
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // packet spawner (separate to use latest state)
  useEffect(() => {
    const interval = setInterval(() => {
      setState((s) => {
        const onlineServers = s.servers.filter((srv) => srv.status !== "offline");
        if (onlineServers.length === 0) {
          return { ...s, dropped: s.dropped + s.trafficRate };
        }
        for (let i = 0; i < s.trafficRate; i++) {
          let target: Server;
          if (s.strategy === "round-robin") {
            target = onlineServers[rrIndex.current % onlineServers.length];
            rrIndex.current++;
          } else if (s.strategy === "least-loaded") {
            target = onlineServers.reduce((best, cur) => {
              const a = cur.load.reduce((x, y) => x + y, 0) / cur.cpus;
              const b = best.load.reduce((x, y) => x + y, 0) / best.cpus;
              return a < b ? cur : best;
            });
          } else {
            target = onlineServers[Math.floor(Math.random() * onlineServers.length)];
          }
          // pick least-loaded cpu in target
          let cpuIdx = 0;
          let minL = Infinity;
          for (let c = 0; c < target.load.length; c++) {
            if (target.load[c] < minL) {
              minL = target.load[c];
              cpuIdx = c;
            }
          }
          packetId.current++;
          setPackets((p) => [
            ...p,
            {
              id: packetId.current,
              serverId: target.id,
              cpuIndex: cpuIdx,
              progress: 0,
              size: 0.08 + Math.random() * 0.12,
            },
          ]);
        }
        return s;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const addServer = () => {
    setState((s) => ({
      ...s,
      servers: [...s.servers, makeServer(s.servers.length + 1, 4 + Math.floor(Math.random() * 5))],
    }));
  };

  const removeServer = (id: string) => {
    setState((s) => ({ ...s, servers: s.servers.filter((srv) => srv.id !== id) }));
    setPackets((p) => p.filter((pk) => pk.serverId !== id));
  };

  const toggleServer = (id: string) => {
    setState((s) => ({
      ...s,
      servers: s.servers.map((srv) =>
        srv.id === id
          ? { ...srv, status: srv.status === "offline" ? "online" : "offline" }
          : srv,
      ),
    }));
  };

  const reset = () => {
    setState(defaultState());
    setPackets([]);
    packetId.current = 0;
    rrIndex.current = 0;
  };

  const totalCpus = useMemo(() => state.servers.reduce((a, s) => a + s.cpus, 0), [state.servers]);
  const avgLoad = useMemo(() => {
    const all = state.servers.flatMap((s) => s.load);
    if (!all.length) return 0;
    return all.reduce((a, b) => a + b, 0) / all.length;
  }, [state.servers]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4 flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="size-3 rounded-full bg-primary animate-pulse shadow-[0_0_12px] shadow-primary" />
          <h1 className="text-xl font-mono tracking-tight">DATACENTER<span className="text-primary">.live</span></h1>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          <Stat label="SERVERS" value={state.servers.length} />
          <Stat label="CPUS" value={totalCpus} />
          <Stat label="AVG LOAD" value={`${Math.round(avgLoad * 100)}%`} />
          <Stat label="PROCESSED" value={state.totalProcessed} />
          <Stat label="DROPPED" value={state.dropped} accent={state.dropped > 0 ? "destructive" : undefined} />
        </div>
      </header>

      <main className="p-6 grid lg:grid-cols-[260px_1fr] gap-6">
        {/* Control panel */}
        <aside className="space-y-4">
          <Panel title="Load Balancer">
            <div className="space-y-2">
              {(["round-robin", "least-loaded", "random"] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => setState((s) => ({ ...s, strategy: opt }))}
                  className={`w-full text-left px-3 py-2 rounded-md text-xs font-mono border transition ${
                    state.strategy === opt
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Traffic Rate">
            <input
              type="range"
              min={0}
              max={20}
              value={state.trafficRate}
              onChange={(e) => setState((s) => ({ ...s, trafficRate: Number(e.target.value) }))}
              className="w-full accent-[color:var(--primary)]"
            />
            <div className="text-xs font-mono text-muted-foreground mt-1">
              {state.trafficRate} packets / 500ms
            </div>
          </Panel>

          <Panel title="Actions">
            <div className="space-y-2">
              <button
                onClick={addServer}
                className="w-full px-3 py-2 rounded-md text-xs font-mono bg-primary text-primary-foreground hover:opacity-90 transition"
              >
                + Add Server
              </button>
              <button
                onClick={reset}
                className="w-full px-3 py-2 rounded-md text-xs font-mono border border-border hover:border-destructive hover:text-destructive transition"
              >
                Reset
              </button>
            </div>
          </Panel>

          <div className="text-[10px] font-mono text-muted-foreground leading-relaxed px-1">
            State persists to localStorage. Click a server to toggle online/offline.
          </div>
        </aside>

        {/* Visualizer */}
        <section className="relative">
          <div className="relative rounded-xl border border-border bg-card overflow-hidden">
            {/* Load Balancer node */}
            <div className="px-6 pt-6 pb-3 flex items-center gap-3 border-b border-border">
              <div className="size-10 rounded-md bg-primary/15 border border-primary flex items-center justify-center font-mono text-primary text-xs">
                LB
              </div>
              <div>
                <div className="font-mono text-sm">Load Balancer</div>
                <div className="text-xs text-muted-foreground font-mono">
                  strategy: {state.strategy} · rate: {state.trafficRate}
                </div>
              </div>
              <div className="ml-auto flex gap-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-1 h-4 bg-primary/30 rounded-full"
                    style={{
                      animation: `pulseBar 1s ${i * 0.1}s infinite ease-in-out`,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="p-6 grid sm:grid-cols-2 xl:grid-cols-3 gap-4 min-h-[400px]">
              {state.servers.map((srv) => (
                <ServerCard
                  key={srv.id}
                  server={srv}
                  packets={packets.filter((p) => p.serverId === srv.id)}
                  onToggle={() => toggleServer(srv.id)}
                  onRemove={() => removeServer(srv.id)}
                />
              ))}
              {state.servers.length === 0 && (
                <div className="col-span-full text-center text-muted-foreground font-mono text-sm py-12">
                  No servers. Add one to start.
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <style>{`
        @keyframes pulseBar {
          0%, 100% { transform: scaleY(0.4); opacity: 0.4; }
          50% { transform: scaleY(1); opacity: 1; }
        }
        @keyframes flow {
          from { transform: translateY(-100%); opacity: 0; }
          10% { opacity: 1; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: "destructive" }) {
  return (
    <div className="px-3 py-1.5 rounded-md bg-card border border-border">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className={`text-sm ${accent === "destructive" ? "text-destructive" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">
        {title}
      </div>
      {children}
    </div>
  );
}

function ServerCard({
  server,
  packets,
  onToggle,
  onRemove,
}: {
  server: Server;
  packets: Packet[];
  onToggle: () => void;
  onRemove: () => void;
}) {
  const avg = server.load.reduce((a, b) => a + b, 0) / server.cpus;
  const statusColor =
    server.status === "offline"
      ? "bg-muted-foreground"
      : server.status === "overloaded"
      ? "bg-destructive shadow-destructive"
      : "bg-primary shadow-primary";

  return (
    <div
      className={`relative rounded-lg border bg-background p-3 transition ${
        server.status === "offline" ? "opacity-50 border-border" : "border-border hover:border-primary/50"
      }`}
    >
      {/* Incoming packet animation lane */}
      <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-px h-4 bg-border" />
      {packets.map((p) => (
        <div
          key={p.id}
          className="absolute left-1/2 -translate-x-1/2 size-1.5 rounded-full bg-accent shadow-[0_0_6px] shadow-accent pointer-events-none"
          style={{
            top: `${-8 + p.progress * 40}px`,
            opacity: 1 - p.progress * 0.3,
          }}
        />
      ))}

      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`size-2 rounded-full ${statusColor} ${server.status !== "offline" ? "shadow-[0_0_8px]" : ""}`} />
          <button onClick={onToggle} className="font-mono text-sm hover:text-primary transition">
            {server.name}
          </button>
        </div>
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive text-xs font-mono"
          aria-label="remove server"
        >
          ✕
        </button>
      </div>

      <div className="text-[10px] font-mono text-muted-foreground mb-2 flex justify-between">
        <span>{server.cpus} CPUs</span>
        <span>{Math.round(avg * 100)}% load</span>
      </div>

      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${Math.min(server.cpus, 4)}, 1fr)` }}
      >
        {server.load.map((l, i) => (
          <CpuCell key={i} load={l} active={server.status !== "offline"} />
        ))}
      </div>
    </div>
  );
}

function CpuCell({ load, active }: { load: number; active: boolean }) {
  const pct = Math.round(load * 100);
  const color =
    !active ? "var(--muted)" :
    load > 0.85 ? "var(--destructive)" :
    load > 0.6 ? "var(--accent)" :
    "var(--primary)";
  return (
    <div className="relative h-10 rounded bg-muted/40 overflow-hidden border border-border">
      <div
        className="absolute bottom-0 left-0 right-0 transition-all duration-200"
        style={{ height: `${pct}%`, backgroundColor: color, opacity: 0.85 }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-foreground/80">
        {pct}
      </div>
    </div>
  );
}
