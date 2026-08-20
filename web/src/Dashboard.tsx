import { useCallback, useEffect, useState } from "react";

type Tab = "overview" | "members" | "loans" | "contributions" | "payouts";

interface Overview {
  memberCount: number;
  contributionCount: number;
  totalSaved: number;
  activeLoans: number;
  walletBalance: number;
  payoutCount: number;
}

export default function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      });
      if (res.status === 401) {
        onLogout();
        throw new Error("session expired");
      }
      return res.json();
    },
    [token, onLogout],
  );

  useEffect(() => {
    if (tab !== "overview") return;
    api("/api/admin/overview").then(setOverview).catch(console.error);
  }, [api, tab]);

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <Sidebar tab={tab} setTab={setTab} onLogout={onLogout} />
      <main style={{ flex: 1, padding: 24 }}>
        {tab === "overview" && <OverviewView overview={overview} />}
        {tab === "members" && <MembersView api={api} />}
        {tab === "loans" && <LoansView api={api} />}
        {tab === "contributions" && <ContributionsView api={api} />}
        {tab === "payouts" && <PayoutsView api={api} />}
      </main>
    </div>
  );
}

function Sidebar({
  tab,
  setTab,
  onLogout,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  onLogout: () => void;
}) {
  const items: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "members", label: "Members" },
    { key: "loans", label: "Loans" },
    { key: "contributions", label: "Contributions" },
    { key: "payouts", label: "Payouts" },
  ];
  return (
    <nav style={{ width: 220, background: "#111827", color: "#e5e7eb", padding: 20 }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 18 }}>Coop Admin</h2>
      {items.map((i) => (
        <div
          key={i.key}
          onClick={() => setTab(i.key)}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            marginBottom: 4,
            cursor: "pointer",
            background: tab === i.key ? "#374151" : "transparent",
          }}
        >
          {i.label}
        </div>
      ))}
      <div style={{ marginTop: 30 }}>
        <button onClick={onLogout} style={{ ...buttonStyle, background: "#dc2626" }}>
          Logout
        </button>
      </div>
    </nav>
  );
}

function OverviewView({ overview }: { overview: Overview | null }) {
  if (!overview) return <p>Loading…</p>;
  const cards = [
    { label: "Members", value: overview.memberCount },
    { label: "Contributions", value: overview.contributionCount },
    { label: "Total saved", value: naira(overview.totalSaved) },
    { label: "Active loans", value: overview.activeLoans },
    { label: "Wallet balance", value: naira(overview.walletBalance) },
    { label: "Payouts", value: overview.payoutCount },
  ];
  return (
    <div>
      <h2>Overview</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        {cards.map((c) => (
          <div key={c.label} style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,.1)" }}>
            <div style={{ color: "#6b7280", fontSize: 13 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface MemberRow {
  id: string;
  name: string;
  phone: string;
  role: string;
  status: string;
  state: string | null;
  virtualAccountNumber: string | null;
  wallet: { balance: number } | null;
}

function MembersView({ api }: { api: (path: string, init?: RequestInit) => Promise<any> }) {
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  useEffect(() => {
    api("/api/admin/members").then(setMembers).catch(console.error);
  }, [api]);
  if (!members) return <p>Loading…</p>;
  return (
    <div>
      <h2>Members ({members.length})</h2>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>State</th>
            <th>Role</th>
            <th>Funding acct</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>{m.phone}</td>
              <td>{m.state ?? "—"}</td>
              <td>{m.role}</td>
              <td>{m.virtualAccountNumber ?? "—"}</td>
              <td>{naira(m.wallet?.balance ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface LoanRow {
  id: string;
  amount: number;
  interestRate: number;
  tenureMonths: number;
  status: string;
  balance: number;
  monthlyPayment: number | null;
  createdAt: string;
  member: { name: string; phone: string };
}

function LoansView({ api }: { api: (path: string, init?: RequestInit) => Promise<any> }) {
  const [loans, setLoans] = useState<LoanRow[] | null>(null);
  const load = () => api("/api/admin/loans").then(setLoans).catch(console.error);
  useEffect(() => {
    load();
  }, [api]);

  async function act(id: string, action: "approve" | "reject") {
    await api(`/api/admin/loans/${id}/${action}`, { method: "POST" });
    load();
  }

  if (!loans) return <p>Loading…</p>;
  return (
    <div>
      <h2>Loans ({loans.length})</h2>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Member</th>
            <th>Amount</th>
            <th>Months</th>
            <th>Rate</th>
            <th>Balance</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {loans.map((l) => (
            <tr key={l.id}>
              <td>{l.id.slice(-6)}</td>
              <td>{l.member.name}</td>
              <td>{naira(l.amount)}</td>
              <td>{l.tenureMonths}</td>
              <td>{l.interestRate}%/mo</td>
              <td>{naira(l.balance)}</td>
              <td>{l.status}</td>
              <td>
                {l.status === "pending" && (
                  <>
                    <button onClick={() => act(l.id, "approve")} style={{ ...buttonStyle, background: "#16a34a", marginRight: 6 }}>
                      Approve
                    </button>
                    <button onClick={() => act(l.id, "reject")} style={{ ...buttonStyle, background: "#dc2626" }}>
                      Reject
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ContributionRow {
  id: string;
  amount: number;
  type: string;
  status: string;
  createdAt: string;
  member: { name: string; phone: string };
}

function ContributionsView({ api }: { api: (path: string, init?: RequestInit) => Promise<any> }) {
  const [rows, setRows] = useState<ContributionRow[] | null>(null);
  useEffect(() => {
    api("/api/admin/contributions").then(setRows).catch(console.error);
  }, [api]);
  if (!rows) return <p>Loading…</p>;
  return (
    <div>
      <h2>Contributions ({rows.length})</h2>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th>Member</th>
            <th>Amount</th>
            <th>Type</th>
            <th>Status</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.member.name}</td>
              <td>{naira(r.amount)}</td>
              <td>{r.type}</td>
              <td>{r.status}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface PayoutRow {
  id: string;
  amount: number;
  status: string;
  note: string | null;
  createdAt: string;
  member: { name: string; phone: string };
}

function PayoutsView({ api }: { api: (path: string, init?: RequestInit) => Promise<any> }) {
  const [rows, setRows] = useState<PayoutRow[] | null>(null);
  useEffect(() => {
    api("/api/admin/payouts").then(setRows).catch(console.error);
  }, [api]);
  if (!rows) return <p>Loading…</p>;
  return (
    <div>
      <h2>Payouts ({rows.length})</h2>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th>Member</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Note</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.member.name}</td>
              <td>{naira(r.amount)}</td>
              <td>{r.status}</td>
              <td>{r.note ?? "—"}</td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function naira(amount: number): string {
  return "NGN " + amount.toLocaleString("en-NG", { minimumFractionDigits: 2 });
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "#fff",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 1px 3px rgba(0,0,0,.1)",
};

const buttonStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "none",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
};

// Add table cell spacing via CSS-in-JS on thead/tbody below isn't needed;
// browsers render th/td borders with defaults.