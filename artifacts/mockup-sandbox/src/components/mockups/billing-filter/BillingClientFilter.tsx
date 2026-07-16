import { useState } from "react";

const CLIENTS = [
  { id: 1, name: "n8n" },
  { id: 2, name: "Acme Corp" },
  { id: 3, name: "Globex" },
];

const PROJECTS_BY_CLIENT: Record<number, { id: number; name: string }[]> = {
  1: [
    { id: 10, name: "n8n Core Platform" },
    { id: 11, name: "n8n AI Integrations" },
    { id: 12, name: "n8n Enterprise Support" },
  ],
  2: [
    { id: 20, name: "Acme Rebranding" },
    { id: 21, name: "Acme Mobile App" },
  ],
  3: [
    { id: 30, name: "Globex ERP Migration" },
  ],
};

const ALL_PROJECTS = Object.values(PROJECTS_BY_CLIENT).flat();

const PERIODS = ["This Month", "Last Month", "This Quarter", "Last Quarter", "All Time", "Custom"];

const MOCK_ROLES = [
  { name: "Tech Lead", employee: "Aemal Sayer", dayrate: "1.309,00 €", days: "5,38", hours: 43, revenue: "7.035,88 €", unbilled: true },
  { name: "Forward Deployed Engineer", employee: "Rohan Dhanawade", dayrate: "805,00 €", days: "18,00", hours: 144, revenue: "14.490,00 €", unbilled: false },
  { name: "AI Automation Manager", employee: "Keshav Reddy", dayrate: "1.256,64 €", days: "11,00", hours: 88, revenue: "13.823,04 €", unbilled: true },
  { name: "DevOps Engineer", employee: "Punit Kumar", dayrate: "1.005,00 €", days: "5,00", hours: 40, revenue: "5.025,00 €", unbilled: false },
];

export function BillingClientFilter() {
  const [clientSel, setClientSel] = useState<number | null>(null);
  const [projectSel, setProjectSel] = useState<string>("");
  const [periodSel, setPeriodSel] = useState("This Month");
  const [openClient, setOpenClient] = useState(false);
  const [openProject, setOpenProject] = useState(false);
  const [openPeriod, setOpenPeriod] = useState(false);

  const filteredProjects = clientSel != null ? (PROJECTS_BY_CLIENT[clientSel] ?? []) : ALL_PROJECTS;

  function handleClientChange(id: number | null) {
    setClientSel(id);
    setOpenClient(false);
    // reset project if it doesn't belong to new client
    if (id != null && projectSel !== "" && projectSel !== "all") {
      const belongs = (PROJECTS_BY_CLIENT[id] ?? []).some((p) => String(p.id) === projectSel);
      if (!belongs) setProjectSel("");
    }
  }

  const selectedClientName = clientSel != null ? CLIENTS.find((c) => c.id === clientSel)?.name : null;
  const selectedProjectName =
    projectSel === "all" ? "All Projects" :
    projectSel !== "" ? ALL_PROJECTS.find((p) => String(p.id) === projectSel)?.name : null;

  return (
    <div className="min-h-screen bg-[#0f0f10] text-white font-sans flex">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-white/8 flex flex-col py-4 gap-1 px-2">
        <div className="px-3 py-2 mb-2 flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-violet-500 to-cyan-400" />
          <span className="font-semibold text-sm">AvaTrack</span>
        </div>
        {["Dashboard", "Timesheet", "Projects", "Employees", "Reports", "Billing"].map((item) => (
          <div
            key={item}
            className={`px-3 py-1.5 rounded text-sm cursor-default ${item === "Billing" ? "bg-white/10 text-white font-medium" : "text-white/50 hover:text-white/70"}`}
          >
            {item}
          </div>
        ))}
      </aside>

      {/* Main */}
      <main className="flex-1 p-8 overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            <h1 className="text-xl font-semibold">Billing</h1>
          </div>
          <button className="flex items-center gap-2 px-3 py-1.5 rounded border border-white/10 text-sm text-white/60 hover:text-white/80 transition">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Export CSV
          </button>
        </div>

        {/* ── Filters ─────────────────────────── */}
        <div className="flex flex-wrap gap-3 mb-6 relative">

          {/* Client dropdown */}
          <div className="flex flex-col gap-1 relative">
            <label className="text-xs text-white/40">Client</label>
            <button
              onClick={() => { setOpenClient(!openClient); setOpenProject(false); setOpenPeriod(false); }}
              className="w-44 flex items-center justify-between px-3 py-1.5 rounded border border-white/10 bg-white/4 text-sm hover:border-white/20 transition"
            >
              <span className={selectedClientName ? "text-white" : "text-white/40"}>
                {selectedClientName ?? "All Clients"}
              </span>
              <svg className="w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openClient && (
              <div className="absolute top-full mt-1 w-44 z-50 bg-[#1a1a1c] border border-white/10 rounded shadow-xl overflow-hidden">
                <div
                  onClick={() => handleClientChange(null)}
                  className={`px-3 py-2 text-sm cursor-pointer hover:bg-white/6 ${clientSel == null ? "text-violet-400" : "text-white/70"}`}
                >All Clients</div>
                <div className="border-t border-white/8 my-0.5" />
                {CLIENTS.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => handleClientChange(c.id)}
                    className={`px-3 py-2 text-sm cursor-pointer hover:bg-white/6 ${clientSel === c.id ? "text-violet-400" : "text-white/70"}`}
                  >{c.name}</div>
                ))}
              </div>
            )}
          </div>

          {/* Project dropdown */}
          <div className="flex flex-col gap-1 relative">
            <label className="text-xs text-white/40">Project</label>
            <button
              onClick={() => { setOpenProject(!openProject); setOpenClient(false); setOpenPeriod(false); }}
              className="w-60 flex items-center justify-between px-3 py-1.5 rounded border border-white/10 bg-white/4 text-sm hover:border-white/20 transition"
            >
              <span className={selectedProjectName ? "text-white" : "text-white/40"}>
                {selectedProjectName ?? "Select a project…"}
              </span>
              <svg className="w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openProject && (
              <div className="absolute top-full mt-1 w-60 z-50 bg-[#1a1a1c] border border-white/10 rounded shadow-xl overflow-hidden">
                <div
                  onClick={() => { setProjectSel("all"); setOpenProject(false); }}
                  className={`px-3 py-2 text-sm cursor-pointer hover:bg-white/6 ${projectSel === "all" ? "text-violet-400" : "text-white/70"}`}
                >All Projects</div>
                <div className="border-t border-white/8 my-0.5" />
                {filteredProjects.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => { setProjectSel(String(p.id)); setOpenProject(false); }}
                    className={`px-3 py-2 text-sm cursor-pointer hover:bg-white/6 ${projectSel === String(p.id) ? "text-violet-400" : "text-white/70"}`}
                  >{p.name}</div>
                ))}
              </div>
            )}
          </div>

          {/* Period dropdown */}
          <div className="flex flex-col gap-1 relative">
            <label className="text-xs text-white/40">Period</label>
            <button
              onClick={() => { setOpenPeriod(!openPeriod); setOpenClient(false); setOpenProject(false); }}
              className="w-40 flex items-center justify-between px-3 py-1.5 rounded border border-white/10 bg-white/4 text-sm hover:border-white/20 transition"
            >
              <span className="text-white">{periodSel}</span>
              <svg className="w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {openPeriod && (
              <div className="absolute top-full mt-1 w-40 z-50 bg-[#1a1a1c] border border-white/10 rounded shadow-xl overflow-hidden">
                {PERIODS.map((p) => (
                  <div
                    key={p}
                    onClick={() => { setPeriodSel(p); setOpenPeriod(false); }}
                    className={`px-3 py-2 text-sm cursor-pointer hover:bg-white/6 ${periodSel === p ? "text-violet-400" : "text-white/70"}`}
                  >{p}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* KPI cards */}
        {projectSel !== "" && (
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: "Logged", value: "€ 40.374,92", sub: "538h / 67,3d" },
              { label: "Invoiced", value: "€ 28.900,00", sub: "360h / 45,0d" },
              { label: "Invest", value: "€ 0,00", sub: "—" },
              { label: "Unbilled", value: "€ 11.474,92", sub: "178h / 22,3d", highlight: true },
            ].map((kpi) => (
              <div key={kpi.label} className={`rounded-lg border p-4 ${kpi.highlight ? "border-yellow-500/30 bg-yellow-500/5" : "border-white/8 bg-white/2"}`}>
                <div className="text-xs text-white/40 mb-1">{kpi.label}</div>
                <div className={`text-lg font-semibold tabular-nums ${kpi.highlight ? "text-yellow-400" : "text-white"}`}>{kpi.value}</div>
                <div className="text-xs text-white/30 mt-0.5">{kpi.sub}</div>
              </div>
            ))}
          </div>
        )}

        {/* Table */}
        {projectSel !== "" ? (
          <div className="border border-white/8 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 bg-white/2">
                  <th className="text-left px-4 py-2.5 text-white/40 font-medium">Role / Employee</th>
                  <th className="text-right px-4 py-2.5 text-white/40 font-medium">Day Rate</th>
                  <th className="text-right px-4 py-2.5 text-white/40 font-medium">Days</th>
                  <th className="text-right px-4 py-2.5 text-white/40 font-medium">Hours</th>
                  <th className="text-right px-4 py-2.5 text-white/40 font-medium">Revenue</th>
                  <th className="text-right px-4 py-2.5 text-white/40 font-medium">Unbilled</th>
                </tr>
              </thead>
              <tbody>
                {MOCK_ROLES.map((row, i) => (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/2">
                    <td className="px-4 py-2.5">
                      <div className="text-white/80 font-medium">{row.name}</div>
                      <div className="text-white/40 text-xs">{row.employee}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-white/70">{row.dayrate}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-white/70">{row.days}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-white/70">{row.hours}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-white/80 font-medium">{row.revenue}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${row.unbilled ? "text-yellow-400" : "text-green-400"}`}>
                      {row.unbilled ? "€ 2.500,00" : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="bg-white/2 font-semibold border-t-2 border-white/15">
                  <td className="px-4 py-2.5 text-white/60">Total</td>
                  <td />
                  <td className="px-4 py-2.5 text-right tabular-nums">39,38</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">315</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">€ 40.373,92</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-yellow-400">€ 11.474,92</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-32 text-white/30 gap-2">
            <svg className="w-10 h-10 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            <p className="text-sm">Select a project to view billing</p>
          </div>
        )}
      </main>
    </div>
  );
}
