"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { api, clearUserStorage } from "./client.mjs";
import { Icon, Loading, ErrorNotice } from "./ui.jsx";
const Session = createContext(null);
export const useSession = () => useContext(Session);
export function SessionProvider({ children }) {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(null),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api("/api/auth/me", { signal: controller.signal })
      .then((x) => {
        if (controller.signal.aborted) return;
        setUser(x.user);
        setError(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError" && e.status !== 401) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const expired = () => setUser(null);
    window.addEventListener("fieldmerge:unauthorized", expired);
    return () => {
      controller.abort();
      window.removeEventListener("fieldmerge:unauthorized", expired);
    };
  }, [attempt]);
  return (
    <Session.Provider
      value={{
        user,
        setUser: (value) => {
          setUser(value);
          setError(null);
        },
        loading,
        error,
        retry: () => {
          setLoading(true);
          setAttempt((n) => n + 1);
        },
      }}
    >
      {children}
    </Session.Provider>
  );
}
export function RoleGate({ role, children }) {
  const { user } = useSession();
  if (role && user?.role !== role)
    return (
      <div className="panel">
        <h1>Access restricted</h1>
        <p>This workspace is available to {role}s.</p>
        <Link className="button secondary" href="/records">
          Return to records
        </Link>
      </div>
    );
  return children;
}
export function AppShell({ children }) {
  const session = useSession(),
    router = useRouter(),
    pathname = usePathname(),
    [open, setOpen] = useState(false),
    [signingOut, setSigningOut] = useState(false),
    [error, setError] = useState(null);
  useEffect(() => {
    if (!session.loading && !session.error && !session.user)
      router.replace("/login");
  }, [session.loading, session.error, session.user, router]);
  if (session.loading)
    return (
      <div className="boot">
        <Loading label="Opening FieldMerge…" />
      </div>
    );
  if (session.error)
    return (
      <div className="boot">
        <ErrorNotice error={session.error} retry={session.retry} />
      </div>
    );
  if (!session.user)
    return (
      <div className="boot">
        <Loading label="Returning to sign in…" />
      </div>
    );
  const reviewer = session.user.role === "reviewer";
  const nav = [
    ["/records", "Records", "records"],
    ...(!reviewer
      ? [["/drafts", "My drafts", "drafts"]]
      : [["/reviews", "Review queue", "review"]]),
    ["/activity", reviewer ? "Submissions" : "My submissions", "activity"],
    ["/batches", reviewer ? "Upload batches" : "Batch uploads", "upload"],
    ...(reviewer
      ? [
          ["/reports", "Reports & exports", "reports"],
          ["/recovery", "Recovery", "recovery"],
        ]
      : []),
  ];
  async function logout() {
    setSigningOut(true);
    setError(null);
    try {
      await api("/api/auth/logout", { method: "POST" });
      clearUserStorage(session.user.user_id);
      session.setUser(null);
      router.replace("/login");
    } catch (e) {
      setError(e);
    } finally {
      setSigningOut(false);
    }
  }
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <Link className="brand" href="/records">
          <span className="brand-mark">
            <Icon name="tree" size={23} />
          </span>
          <span>
            FieldMerge<small>SURVEY WORKSPACE</small>
          </span>
        </Link>
        <button
          className="menu-toggle button secondary small"
          aria-expanded={open}
          aria-controls="workspace-navigation"
          onClick={() => setOpen(!open)}
        >
          <Icon name="menu" />
          Menu
        </button>
        <nav id="workspace-navigation" aria-label="Main navigation">
          <p className="nav-heading">WORKSPACE</p>
          {nav.map(([href, label, icon]) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              aria-current={
                pathname === href || pathname.startsWith(href + "/")
                  ? "page"
                  : undefined
              }
            >
              <Icon name={icon} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="live-dot" /> A record of every change
          <p>
            Independent observations.
            <br />
            Traceable decisions.
          </p>
        </div>
        <div className="account">
          <span className="avatar">
            {session.user.display_name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{session.user.display_name}</strong>
            <span>{reviewer ? "Reviewer" : "Surveyor"}</span>
          </div>
          <button
            className="icon-button"
            aria-label="Sign out"
            title="Sign out"
            disabled={signingOut}
            onClick={logout}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="app-content">
        <header className="topbar">
          <span>
            Field survey <span className="slash">/</span>{" "}
            <strong>
              {nav.find(([href]) => pathname.startsWith(href))?.[1] ??
                "Workspace"}
            </strong>
          </span>
          <span className="role-label">
            {reviewer ? "Review & reconciliation" : "Field observations"}
          </span>
        </header>
        <main id="main-content" tabIndex={-1}>
          {error ? <ErrorNotice error={error} /> : null}
          {children}
        </main>
        <footer className="app-footer">
          FieldMerge <span>·</span> Synthetic survey demonstration{" "}
          <span>·</span> Accepted data stays traceable
        </footer>
      </div>
    </div>
  );
}
export function LoginForm() {
  const session = useSession(),
    router = useRouter(),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  useEffect(() => {
    if (session.user) router.replace("/records");
  }, [session.user, router]);
  async function login(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setPassword("");
      session.setUser(result.user);
      router.replace("/records");
    } catch (x) {
      setError(x);
    } finally {
      setBusy(false);
    }
  }
  if (session.loading)
    return (
      <div className="boot">
        <Loading />
      </div>
    );
  return (
    <div className="login-page">
      <section className="login-story">
        <Link className="brand" href="/">
          <span className="brand-mark">
            <Icon name="tree" size={26} />
          </span>
          <span>
            FieldMerge<small>SURVEY WORKSPACE</small>
          </span>
        </Link>
        <div>
          <p className="eyebrow">OBSERVE. RECONCILE. TRACE.</p>
          <h1>
            Every observation
            <br />
            has a place.
          </h1>
          <p>
            Bring delayed tree surveys into one accepted record. Keep compatible
            changes, review disagreements, and follow every value back to its
            source.
          </p>
        </div>
        <div className="story-record">
          <span className="story-orbit" aria-hidden="true">
            <Icon name="tree" size={72} />
          </span>
          <div>
            <span className="mini-label">FIELD RECORD</span>
            <h2>One tree. A shared history.</h2>
            <div className="story-line">
              <span>Field observation</span>
              <span>Reviewed record</span>
            </div>
            <div className="merge-line" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
        <p className="story-footer">
          Built around careful observations and considered decisions.
        </p>
      </section>
      <section className="login-form-wrap">
        <div className="login-card">
          <p className="eyebrow">WELCOME TO YOUR WORKSPACE</p>
          <h2>Sign in to FieldMerge</h2>
          <p className="description">
            Use your assigned surveyor or reviewer account.
          </p>
          <ErrorNotice
            error={error ?? session.error}
            retry={session.error ? session.retry : undefined}
          />
          <form onSubmit={login}>
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="button primary full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
              <Icon name="arrow" size={18} />
            </button>
          </form>
          <div className="login-divider" />
          <p className="subtle">
            Your role determines which records and review tools are available.
          </p>
        </div>
        <p className="login-footnote">
          A solo university DBMS project · Synthetic demonstration data
        </p>
      </section>
    </div>
  );
}
