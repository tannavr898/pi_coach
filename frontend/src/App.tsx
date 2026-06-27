import { useEffect, useState } from "react";

type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; status: string }
  | { kind: "error"; message: string };

// Minimal scaffold screen: prove the SPA -> Vite proxy -> FastAPI wire works.
// No DECA features yet (those land in Phase 2).
export default function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { status: string }) => setHealth({ kind: "ok", status: data.status }))
      .catch((err: unknown) =>
        setHealth({ kind: "error", message: err instanceof Error ? err.message : "unknown error" }),
      );
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-xl font-semibold text-slate-900">DECA Roleplay Trainer</h1>
        <p className="mt-1 text-sm text-slate-500">Scaffold — Phase 1 data foundation</p>

        <div className="mt-6 flex items-center gap-3 rounded-lg bg-slate-50 p-4">
          <StatusDot health={health} />
          <div className="text-sm">
            <div className="font-medium text-slate-700">Backend</div>
            <div className="text-slate-500">{describe(health)}</div>
          </div>
        </div>
      </div>
    </main>
  );
}

function StatusDot({ health }: { health: HealthState }) {
  const color =
    health.kind === "ok"
      ? "bg-green-500"
      : health.kind === "error"
        ? "bg-red-500"
        : "bg-amber-400 animate-pulse";
  return <span className={`h-3 w-3 shrink-0 rounded-full ${color}`} />;
}

function describe(health: HealthState): string {
  switch (health.kind) {
    case "loading":
      return "checking /api/health…";
    case "ok":
      return `connected (status: ${health.status})`;
    case "error":
      return `unreachable — ${health.message} (is the backend running on :8000?)`;
  }
}
