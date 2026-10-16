"use client";

import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowLeft, Cpu, LoaderCircle, Pause, Play, Plus, RefreshCw, X } from "lucide-react";

type Settings = { paused: boolean; maxPerPurchaseAtomic: string | null; maxPerDayAtomic: string | null; maxUnitsPerRedeem: number | null; allowedOffers: string[] | null; updatedAt: number | null };
type Task = { id: string; prompt: string; units: number; model: string | null; status: string; voucherId: string | null; unitsUsed: number | null; paidAtomic: string | null; resultText: string | null; error: string | null; createdAt: number; finishedAt: number | null };
type Event = { id: string; kind: string; message: string; taskId: string | null; createdAt: number };
type Voucher = { id: string; offerId: string; totalUnits: number; remainingUnits: number; paymentTx: string; status: string; issuedAt: number; expiresAt: number };
type Payment = { nonce: string; voucherId: string; offerId: string; amountAtomic: string; status: string; paymentTx: string | null; error: string | null; createdAt: number };
type Redemption = { id: string; voucherId: string; model: string; status: string; units: number; promptTokens: number; completionTokens: number; createdAt: number };
type LocalBudget = { maxPerPurchase?: number; maxPerDay?: number; maxUnitsPerRedeem?: number; allowedOffers?: string[] };
type Overview = {
  settings: Settings;
  agent: { online: boolean; seenAt: number; version: string | null; lastError: string | null; localBudget: LocalBudget | null } | null;
  wallet: {
    address: string; balanceAtomic: string | null; balanceSource: "chain" | "agent" | null;
    vouchers: Voucher[]; payments: Payment[]; redemptions: Redemption[];
    spentTodayAtomic: string; spentTotalAtomic: string; unitsUsedTotal: number; redemptionsTotal: number;
  } | null;
  tasks: Task[]; events: Event[];
  offers: { id: string; model: string; units: number; priceAtomic: string }[];
  decimals: number; serverTime: number;
};

const TOKEN_KEY = "computepass-admin-token";
const short = (v: string) => (v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);
const when = (s: number) => new Date(s * 1000).toLocaleString("es-UY", { dateStyle: "short", timeStyle: "short" });
const ago = (now: number, s: number) => {
  const d = Math.max(0, now - s);
  return d < 60 ? `hace ${d} s` : d < 3600 ? `hace ${Math.floor(d / 60)} min` : `hace ${Math.floor(d / 3600)} h`;
};

/** Atomic -> decimal string without float rounding. */
function u(atomic: string | null | undefined, decimals = 18): string {
  if (atomic == null) return "—";
  const a = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return `${a / base}${frac ? "," + frac : ""} U`;
}
const plain = (atomic: string | null, decimals: number) => (atomic == null ? "" : u(atomic, decimals).replace(" U", "").replace(",", "."));

const statusLabel: Record<string, string> = { queued: "en cola", running: "corriendo", done: "hecha", failed: "falló", cancelled: "cancelada", active: "activo", spent: "agotado", expired: "vencido", settled: "liquidado", pending: "pendiente", completed: "completada", rejected: "rechazada" };
const Pill = ({ s }: { s: string }) => <span className={`admin-pill admin-pill-${s}`}>{statusLabel[s] ?? s}</span>;

let memoryToken = "";
const tokenListeners = new Set<() => void>();
/** The admin token lives in sessionStorage (this tab only), with an in-memory fallback. */
const tokenStore = {
  get: () => {
    try { return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken; } catch { return memoryToken; }
  },
  set: (value: string) => {
    memoryToken = value;
    try { if (value) sessionStorage.setItem(TOKEN_KEY, value); else sessionStorage.removeItem(TOKEN_KEY); } catch {}
    tokenListeners.forEach((listener) => listener());
  },
  subscribe: (listener: () => void) => {
    tokenListeners.add(listener);
    return () => { tokenListeners.delete(listener); };
  },
};

type Caps = { maxPerPurchase: string; maxPerDay: string; maxUnitsPerRedeem: string; allowedOffers: string[] };
const capsFrom = (o: Overview): Caps => ({
  maxPerPurchase: plain(o.settings.maxPerPurchaseAtomic, o.decimals),
  maxPerDay: plain(o.settings.maxPerDayAtomic, o.decimals),
  maxUnitsPerRedeem: o.settings.maxUnitsPerRedeem?.toString() ?? "",
  allowedOffers: o.settings.allowedOffers ?? [],
});

export default function AdminPage() {
  const token = useSyncExternalStore(tokenStore.subscribe, tokenStore.get, () => "");
  const [draftToken, setDraftToken] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [units, setUnits] = useState(512);
  const [model, setModel] = useState("");
  /** null = show the saved caps; an object = the owner is editing. */
  const [editedCaps, setCaps] = useState<Caps | null>(null);
  const [openTask, setOpenTask] = useState("");

  const call = useCallback(async (body?: unknown) => {
    const res = await fetch("/api/admin/agent", {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    if (res.status === 401) {
      tokenStore.set("");
      throw new Error("Clave incorrecta.");
    }
    if (res.status === 404 && !body) throw new Error("El panel está apagado: falta configurar ADMIN_TOKEN (32+ caracteres) en el sitio.");
    if (!res.ok) throw new Error(json.detail ?? json.error ?? `Error ${res.status}`);
    return json;
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    const tick = () =>
      call().then(
        (overview) => { if (alive) { setData(overview as Overview); setError(""); } },
        (e: Error) => { if (alive) setError(e.message); },
      );
    tick();
    const id = setInterval(tick, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [call, token, refresh]);

  const load = () => setRefresh((n) => n + 1);
  const caps = editedCaps ?? (data ? capsFrom(data) : { maxPerPurchase: "", maxPerDay: "", maxUnitsPerRedeem: "", allowedOffers: [] });
  const capsDirty = editedCaps !== null;

  const act = async (label: string, body: unknown) => {
    setBusy(label);
    try {
      await call(body);
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  };

  if (!token) {
    return <main className="admin-page">
      <AdminHeader />
      <section className="shell admin-login">
        <h1>Panel del agente</h1>
        <p>Ingresá la clave de administración (la variable <code>ADMIN_TOKEN</code> del sitio). Se guarda solo en esta pestaña.</p>
        <form onSubmit={(e) => { e.preventDefault(); tokenStore.set(draftToken.trim()); setDraftToken(""); }}>
          <input type="password" autoComplete="current-password" placeholder="ADMIN_TOKEN" value={draftToken} onChange={(e) => setDraftToken(e.target.value)} />
          <button className="primary" disabled={draftToken.trim().length < 32}>Entrar</button>
        </form>
        {error && <p className="admin-error">{error}</p>}
      </section>
    </main>;
  }

  const s = data?.settings;
  const w = data?.wallet;
  const lb = data?.agent?.localBudget;
  const d = data?.decimals ?? 18;

  return <main className="admin-page">
    <AdminHeader onLogout={() => { tokenStore.set(""); setData(null); }} />
    <section className="shell admin-body">
      <div className="admin-title">
        <div>
          <span>Agente comprador · BSC Testnet</span>
          <h1>Panel del agente</h1>
        </div>
        <div className="admin-actions">
          <button className="admin-ghost" onClick={load} aria-label="Actualizar"><RefreshCw size={15} /></button>
          {s && <button className={s.paused ? "primary admin-toggle" : "admin-danger admin-toggle"} disabled={busy === "pause"} onClick={() => act("pause", { action: "settings", paused: !s.paused })}>
            {busy === "pause" ? <LoaderCircle className="spin" size={16} /> : s.paused ? <Play size={16} /> : <Pause size={16} />}
            {s.paused ? "Activar agente" : "Pausar agente"}
          </button>}
        </div>
      </div>
      {error && <p className="admin-error">{error}</p>}
      {!data && !error && <p className="admin-muted"><LoaderCircle className="spin" size={14} /> Cargando…</p>}

      {data && <>
        <div className="admin-stats">
          <Stat label="Agente" value={!data.agent ? "nunca conectó" : data.agent.online ? "en línea" : "sin conexión"} hint={data.agent ? `visto ${ago(data.serverTime, data.agent.seenAt)}${data.agent.version ? ` · v${data.agent.version}` : ""}` : "corré el daemon en tu Mac"} tone={data.agent?.online ? "ok" : "warn"} />
          <Stat label="Estado" value={s!.paused ? "pausado" : "activo"} hint={s!.paused ? "no compra ni redime" : "toma tareas de la cola"} tone={s!.paused ? "warn" : "ok"} />
          <Stat label="Saldo de la wallet" value={w ? u(w.balanceAtomic, d) : "—"} hint={w ? <a href={`https://testnet.bscscan.com/address/${w.address}`} target="_blank" rel="noreferrer">{short(w.address)}{w.balanceSource === "agent" ? " · según el agente" : ""}</a> : "sin wallet todavía"} />
          <Stat label="Gastado hoy" value={w ? u(w.spentTodayAtomic, d) : "—"} hint={`tope efectivo ${effectiveCap(lb?.maxPerDay, s!.maxPerDayAtomic, d)}`} />
          <Stat label="Consumo total" value={w ? `${w.unitsUsedTotal.toLocaleString("es-UY")} unidades` : "—"} hint={w ? `${w.redemptionsTotal} redenciones · ${u(w.spentTotalAtomic, d)} gastados` : ""} />
        </div>
        {data.agent?.lastError && <p className="admin-error">Último error del agente: {data.agent.lastError}</p>}

        <div className="admin-grid">
          <article className="admin-card">
            <h2>Nueva tarea</h2>
            <p className="admin-muted">El agente usa un voucher con saldo o compra el más barato que entre en los topes.</p>
            <form onSubmit={async (e) => { e.preventDefault(); if (await act("task", { action: "task", prompt, units, model: model || undefined })) setPrompt(""); }}>
              <textarea rows={4} placeholder="¿Qué tiene que hacer el agente?" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={16000} />
              <div className="admin-row">
                <label>Unidades máx.<input type="number" min={1} max={32000} value={units} onChange={(e) => setUnits(Number(e.target.value))} /></label>
                <label>Modelo (opcional)<input placeholder="llama, deepseek…" value={model} onChange={(e) => setModel(e.target.value)} /></label>
              </div>
              <button className="primary" disabled={!prompt.trim() || busy === "task"}>{busy === "task" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Agregar a la cola</button>
            </form>
          </article>

          <article className="admin-card">
            <h2>Topes de gasto</h2>
            <p className="admin-muted">Solo pueden achicar los topes del Mac, nunca agrandarlos. Vacío = usar el tope local.</p>
            <form onSubmit={async (e) => {
              e.preventDefault();
              if (await act("caps", { action: "settings", maxPerPurchase: caps.maxPerPurchase, maxPerDay: caps.maxPerDay, maxUnitsPerRedeem: caps.maxUnitsPerRedeem, allowedOffers: caps.allowedOffers })) setCaps(null);
            }}>
              <div className="admin-row">
                <label>Por compra (U)<input inputMode="decimal" placeholder={lb?.maxPerPurchase != null ? `local ${lb.maxPerPurchase}` : ""} value={caps.maxPerPurchase} onChange={(e) => { setCaps({ ...caps, maxPerPurchase: e.target.value }); }} /></label>
                <label>Por día (U)<input inputMode="decimal" placeholder={lb?.maxPerDay != null ? `local ${lb.maxPerDay}` : ""} value={caps.maxPerDay} onChange={(e) => { setCaps({ ...caps, maxPerDay: e.target.value }); }} /></label>
                <label>Unidades por redención<input inputMode="numeric" placeholder={lb?.maxUnitsPerRedeem != null ? `local ${lb.maxUnitsPerRedeem}` : ""} value={caps.maxUnitsPerRedeem} onChange={(e) => { setCaps({ ...caps, maxUnitsPerRedeem: e.target.value }); }} /></label>
              </div>
              <fieldset className="admin-offers">
                <legend>Ofertas permitidas (ninguna marcada = todas)</legend>
                {data.offers.map((o) => <label key={o.id}><input type="checkbox" checked={caps.allowedOffers.includes(o.id)} onChange={(e) => { setCaps({ ...caps, allowedOffers: e.target.checked ? [...caps.allowedOffers, o.id] : caps.allowedOffers.filter((x) => x !== o.id) }); }} /> {o.model} · {u(o.priceAtomic, d)}</label>)}
              </fieldset>
              <button className="primary" disabled={busy === "caps" || !capsDirty}>{busy === "caps" ? <LoaderCircle className="spin" size={16} /> : null} Guardar topes</button>
            </form>
          </article>
        </div>

        <article className="admin-card">
          <h2>Tareas</h2>
          {data.tasks.length === 0 ? <p className="admin-muted">Todavía no hay tareas.</p> : <div className="admin-table-wrap"><table className="admin-table">
            <thead><tr><th>Creada</th><th>Tarea</th><th>Estado</th><th>Unidades</th><th>Pagado</th><th /></tr></thead>
            <tbody>{data.tasks.map((t) => <Fragment key={t.id}>
              <tr onClick={() => setOpenTask(openTask === t.id ? "" : t.id)} className="admin-click">
                <td>{when(t.createdAt)}</td>
                <td className="admin-prompt">{t.prompt}</td>
                <td><Pill s={t.status} /></td>
                <td>{t.unitsUsed ?? "—"} / {t.units}</td>
                <td>{t.paidAtomic ? u(t.paidAtomic, d) : t.status === "done" ? "voucher existente" : "—"}</td>
                <td>{t.status === "queued" && <button className="admin-ghost" aria-label="Cancelar" onClick={(e) => { e.stopPropagation(); act("cancel", { action: "cancel", taskId: t.id }); }}><X size={14} /></button>}</td>
              </tr>
              {openTask === t.id && <tr><td colSpan={6} className="admin-detail">
                {t.error && <p className="admin-error">{t.error}</p>}
                {t.resultText ? <pre>{t.resultText}</pre> : !t.error && <p className="admin-muted">Sin resultado todavía.</p>}
                {t.voucherId && <p className="admin-muted">Voucher {t.voucherId}</p>}
              </td></tr>}
            </Fragment>)}</tbody>
          </table></div>}
        </article>

        <div className="admin-grid">
          <article className="admin-card">
            <h2>Vouchers</h2>
            {!w?.vouchers.length ? <p className="admin-muted">Sin vouchers.</p> : <div className="admin-table-wrap"><table className="admin-table">
              <thead><tr><th>Oferta</th><th>Saldo</th><th>Estado</th><th>Vence</th></tr></thead>
              <tbody>{w.vouchers.map((v) => <tr key={v.id}><td>{v.offerId}</td><td>{v.remainingUnits.toLocaleString("es-UY")} / {v.totalUnits.toLocaleString("es-UY")}</td><td><Pill s={v.status} /></td><td>{when(v.expiresAt)}</td></tr>)}</tbody>
            </table></div>}
          </article>
          <article className="admin-card">
            <h2>Compras</h2>
            {!w?.payments.length ? <p className="admin-muted">Sin compras.</p> : <div className="admin-table-wrap"><table className="admin-table">
              <thead><tr><th>Fecha</th><th>Oferta</th><th>Monto</th><th>Estado</th><th>Tx</th></tr></thead>
              <tbody>{w.payments.map((p) => <tr key={p.nonce}><td>{when(p.createdAt)}</td><td>{p.offerId}</td><td>{u(p.amountAtomic, d)}</td><td><Pill s={p.status} /></td>
                <td>{p.paymentTx?.startsWith("0x") && p.paymentTx.length === 66 ? <a href={`https://testnet.bscscan.com/tx/${p.paymentTx}`} target="_blank" rel="noreferrer">{short(p.paymentTx)}</a> : p.error ?? "—"}</td></tr>)}</tbody>
            </table></div>}
          </article>
        </div>

        <div className="admin-grid">
          <article className="admin-card">
            <h2>Consumo</h2>
            {!w?.redemptions.length ? <p className="admin-muted">Sin redenciones.</p> : <div className="admin-table-wrap"><table className="admin-table">
              <thead><tr><th>Fecha</th><th>Modelo</th><th>Entrada + salida</th><th>Estado</th></tr></thead>
              <tbody>{w.redemptions.map((r) => <tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.model}</td><td>{r.promptTokens} + {r.completionTokens}</td><td><Pill s={r.status} /></td></tr>)}</tbody>
            </table></div>}
          </article>
          <article className="admin-card">
            <h2>Decisiones del agente</h2>
            {!data.events.length ? <p className="admin-muted">Sin eventos.</p> : <ul className="admin-events">
              {data.events.map((e) => <li key={e.id}><span className={`admin-kind admin-kind-${e.kind}`}>{e.kind}</span><span>{e.message}</span><small>{ago(data.serverTime, e.createdAt)}</small></li>)}
            </ul>}
          </article>
        </div>
      </>}
    </section>
  </main>;
}

function effectiveCap(local: number | undefined, remoteAtomic: string | null, decimals: number) {
  const remote = remoteAtomic == null ? undefined : Number(BigInt(remoteAtomic)) / 10 ** decimals;
  const values = [local, remote].filter((v): v is number => v !== undefined);
  return values.length ? `${Math.min(...values).toLocaleString("es-UY", { maximumFractionDigits: 6 })} U` : "desconocido";
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: React.ReactNode; tone?: "ok" | "warn" }) {
  return <div className={`admin-stat ${tone ? `admin-stat-${tone}` : ""}`}><small>{label}</small><strong>{value}</strong>{hint && <span>{hint}</span>}</div>;
}

function AdminHeader({ onLogout }: { onLogout?: () => void }) {
  return <header className="nav shell">
    <Link className="brand" href="/"><span className="brand-mark"><Cpu size={17} /></span><span>ComputePass <b>402</b></span></Link>
    <div className="nav-state">
      <Link className="docs-link" href="/"><ArrowLeft size={13} /> Sitio</Link>
      {onLogout && <button className="wallet-button" onClick={onLogout}>Salir</button>}
    </div>
  </header>;
}
