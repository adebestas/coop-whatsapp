import { useState } from "react";

export default function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, pin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "login failed");
      onLogin(data.token as string);
    } catch (err: any) {
      setError(err.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 380, margin: "80px auto", padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Coop Admin</h1>
      <p style={{ color: "#6b7280" }}>Sign in with your WhatsApp phone number and PIN.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input
          placeholder="Phone (e.g. 2348012345678)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="4-digit PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          style={inputStyle}
          maxLength={4}
        />
        {error && <p style={{ color: "#dc2626" }}>{error}</p>}
        <button disabled={loading} style={buttonStyle}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 8,
  border: "1px solid #d1d5db",
  fontSize: 15,
};

const buttonStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 8,
  border: "none",
  background: "#16a34a",
  color: "#fff",
  fontSize: 15,
  fontWeight: 600,
};