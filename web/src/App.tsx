import { useEffect, useState } from "react";
import Login from "./Login";
import Dashboard from "./Dashboard";

export interface LoginResponse {
  token: string;
  member: {
    id: string;
    name: string;
    phone: string;
    cooperative: {
      id: string;
      name: string;
      code: string;
      state: string | null;
      country: string;
      currency: string;
    };
  };
}

const TOKEN_KEY = "coop_admin_token";

export default function App() {
  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem(TOKEN_KEY),
  );

  useEffect(() => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }, [token]);

  if (!token) return <Login onLogin={setToken} />;
  return <Dashboard token={token} onLogout={() => setToken(null)} />;
}

export type { LoginResponse as AuthInfo };