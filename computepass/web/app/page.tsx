"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, Cpu, LoaderCircle, ShieldCheck, Wallet, Zap } from "lucide-react";
import { CHAIN_ID, MAX_REDEMPTION_UNITS, REDEMPTION_MAX_TTL_SECONDS, estimatePromptTokens, redemptionMessage } from "@/lib/protocol";
import { NETWORK, U_TOKEN } from "@/lib/catalog";

type Offer = { id:string; model:string; upstreamModel:string; provider:string; units:number; priceAtomic:string; priceLabel:string; latency:string; expiresInDays:number };
type Voucher = { id:string; offerId:string; ownerAddress:string; totalUnits:number; remainingUnits:number; paymentTx:string; status:string; issuedAt:number; expiresAt:number };
type Status = { network:string; chainName:string; asset:string; facilitator:string; ready:{ payment:boolean; inference:boolean; contract:boolean }; contractAddress:string|null };

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

type ApiError = { error?: string; detail?: string };

async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function Home() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [wallet, setWallet] = useState("");
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [prompt, setPrompt] = useState("Explicá por qué x402 sirve para comprar capacidad de cómputo bajo demanda.");
  const [maxUnits, setMaxUnits] = useState(512);
  const [output, setOutput] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/offers").then((response) => readJson<{ offers?: Offer[] }>(response)),
      fetch("/api/status").then((response) => readJson<Status>(response)),
    ]).then(([catalog, infrastructure]) => {
      setOffers(catalog.offers || []);
      setStatus(infrastructure);
    }).catch(() => setNotice("No se pudo cargar el catálogo."));
  }, []);

  const loadVouchers = useCallback(async (address: string) => {
    const response = await fetch(`/api/vouchers?owner=${encodeURIComponent(address)}`);
    if (response.ok) {
      const data = await readJson<{ vouchers?: Voucher[] }>(response);
      setVouchers(data.vouchers || []);
    }
  }, []);

  const connect = async () => {
    if (!window.ethereum) return setNotice("Necesitás una wallet EVM como MetaMask para continuar.");
    setBusy("wallet");
    try {
      await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{ chainId:"0x61" }] }).catch(async () => {
        await window.ethereum!.request({
          method:"wallet_addEthereumChain",
          params:[{ chainId:"0x61", chainName:"BSC Testnet", nativeCurrency:{ name:"tBNB", symbol:"tBNB", decimals:18 }, rpcUrls:["https://data-seed-prebsc-1-s1.bnbchain.org:8545"], blockExplorerUrls:["https://testnet.bscscan.com"] }],
        });
      });
      const accounts = await window.ethereum.request({ method:"eth_requestAccounts" }) as string[];
      const connected = accounts[0] || "";
      setWallet(connected);
      if (connected) await loadVouchers(connected);
      setNotice("Wallet conectada a BSC Testnet.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "No se pudo conectar la wallet.");
    } finally { setBusy(""); }
  };

  const buy = async (offer: Offer) => {
    if (!wallet || !window.ethereum) return void connect();
    if (!status?.ready.payment) return setNotice("La infraestructura está desplegada, pero falta activar la dirección receptora de testnet.");
    setBusy(offer.id);
    setNotice("Preparando autorización x402. Tu wallet mostrará el monto exacto en U testnet.");
    try {
      const [{ createWalletClient, custom }, { bscTestnet }, { x402Client }, { B402ExactClientScheme }, { wrapFetchWithPayment }] = await Promise.all([
        import("viem"), import("viem/chains"), import("@x402/core/client"), import("@bnb-chain/b402/client"), import("@x402/fetch"),
      ]);
      const client = createWalletClient({ account:wallet as `0x${string}`, chain:bscTestnet, transport:custom(window.ethereum) });
      // Spend controls: only U on BSC Testnet, and never more than this offer's advertised price.
      const payments = new x402Client()
        .register("eip155:*", new B402ExactClientScheme({ account:client.account!, methods:["eip3009"] }))
        .setSpendControls({ maxAmountPerPayment:false, allowedAssets:[{ network:NETWORK, asset:U_TOKEN, maxAmountPerPayment:offer.priceAtomic }] });
      const response = await wrapFetchWithPayment(fetch, payments)("/api/reservations", {
        method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ offerId:offer.id, buyer:wallet }),
      });
      const data = await readJson<ApiError & { voucher?: Voucher }>(response);
      if (!response.ok || !data.voucher) throw new Error(data.detail || data.error || "No se pudo emitir el voucher.");
      setNotice(`Voucher emitido. Liquidación: ${short(data.voucher.paymentTx)}`);
      await loadVouchers(wallet);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "La compra no pudo completarse.");
    } finally { setBusy(""); }
  };

  const redeem = async () => {
    if (!selectedVoucher || !wallet || !window.ethereum || !prompt.trim()) return;
    if (!status?.ready.inference) return setNotice("Falta conectar el proveedor de inferencia para ejecutar esta redención.");
    setBusy("redeem"); setOutput("");
    try {
      const text = prompt.trim();
      const intent = {
        domain: window.location.host,
        chainId: CHAIN_ID,
        voucherId: selectedVoucher.id,
        offerId: selectedVoucher.offerId,
        promptSha256: await sha256(text),
        maxUnits,
        nonce: randomNonce(),
        expiresAt: Math.floor(Date.now() / 1000) + REDEMPTION_MAX_TTL_SECONDS - 60,
      };
      const signature = await window.ethereum.request({ method:"personal_sign", params:[redemptionMessage(intent),wallet] }) as string;
      const response = await fetch("/api/redeem", {
        method:"POST", headers:{ "content-type":"application/json" },
        body:JSON.stringify({ voucherId:intent.voucherId, offerId:intent.offerId, address:wallet, prompt:text, maxUnits, nonce:intent.nonce, expiresAt:intent.expiresAt, signature }),
      });
      const data = await readJson<ApiError & { output?: string; usedUnits?: number; remainingUnits?: number | null }>(response);
      if (!response.ok) throw new Error(data.detail || data.error || "No se pudo redimir.");
      setOutput(data.output || "");
      setNotice(`${data.usedUnits ?? 0} unidades consumidas (entrada + salida). Quedan ${(data.remainingUnits ?? 0).toLocaleString("es-UY")}.`);
      await loadVouchers(wallet);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "La inferencia falló.");
    } finally { setBusy(""); }
  };

  const readiness = useMemo(() => status ? Object.values(status.ready).filter(Boolean).length : 0, [status]);

  return <main>
    <div className="ambient ambient-one" aria-hidden="true" />
    <div className="ambient ambient-two" aria-hidden="true" />
    <nav className="nav shell">
      <a className="brand" href="#top"><span className="brand-mark"><Cpu size={17}/></span><span>ComputePass <b>402</b></span></a>
      <div className="nav-state"><a className="docs-link" href="/docs">Manual + API</a><span className="network-dot"/> BSC Testnet
        <button className="wallet-button" onClick={connect} disabled={busy === "wallet"}><Wallet size={15}/> {wallet ? short(wallet) : "Conectar wallet"}</button>
      </div>
    </nav>

    <section className="hero shell" id="top">
      <div className="hero-copy-block">
        <div className="eyebrow"><Zap size={13}/> capacidad programable · x402 nativo</div>
        <h1>Comprá inferencia ahora.<br/><span>Usala cuando la necesites.</span></h1>
        <p className="hero-copy">Reservas de cómputo liquidadas en testnet, convertidas en vouchers redimibles mediante una API autenticada por tu wallet.</p>
        <div className="hero-actions"><a className="hero-primary" href="#market">Explorar capacidad <ArrowUpRight size={15}/></a><button onClick={connect}><Wallet size={15}/> Conectar agente</button></div>
      </div>
      <div className="hero-visual" aria-label="ComputePass de capacidad">
        <div className="orbit orbit-one"/><div className="orbit orbit-two"/>
        <article className="pass-card">
          <div className="pass-top"><span>CP<span>/</span>402</span><b><i/> AVAILABLE</b></div>
          <div className="pass-chip"><i/><i/><i/><i/></div>
          <p>COMPUTE CAPACITY PASS</p><h3>50K UNITS</h3>
          <div className="pass-details"><div><small>MODEL</small><strong>Llama 3.3 70B</strong></div><div><small>NETWORK</small><strong>BSC TESTNET</strong></div><div><small>SLA</small><strong>&lt; 1.8s</strong></div></div>
          <footer><span>x402 · EIP-3009</span><span>REDEEMABLE</span></footer>
        </article>
        <div className="float-stat stat-left"><span>Capacity</span><strong>50.000</strong></div>
        <div className="float-stat stat-right"><span>Fixed price</span><strong>0,01 U</strong></div>
      </div>
      <div className="pipeline" aria-label="Flujo del producto">
        <div><small>01</small><b>Elegí capacidad</b><span>precio y SLA explícitos</span></div><i>→</i>
        <div><small>02</small><b>Pagá con x402</b><span>U en BSC Testnet</span></div><i>→</i>
        <div><small>03</small><b>Redimí inferencia</b><span>firma sin custodia</span></div>
      </div>
    </section>

    <section className="shell market" id="market">
      <div className="section-heading"><div><span>Mercado primario</span><h2>Pases disponibles</h2></div><p>Un pago crea un derecho verificable de consumo. Nada se emite antes de la liquidación.</p></div>
      <div className="offer-grid">{offers.map((offer,index) => <article className={`offer-card ${index===0?"featured":""}`} key={offer.id}>
        <div className="offer-top"><span className="model-chip">{offer.model}</span><span className="live"><i/> disponible</span></div>
        <div className="capacity"><b>{offer.units.toLocaleString("es-UY")}</b><span>tokens (entrada + salida)</span></div>
        <dl><div><dt>Modelo servido</dt><dd>{offer.upstreamModel}</dd></div><div><dt>Latencia</dt><dd>{offer.latency}</dd></div><div><dt>Vigencia</dt><dd>{offer.expiresInDays} días</dd></div></dl>
        <div className="price-row"><span><small>Precio total</small><strong>{offer.priceLabel}</strong></span></div>
        <button className="primary" onClick={() => buy(offer)} disabled={Boolean(busy)}>{busy===offer.id?<LoaderCircle className="spin" size={17}/>:<ArrowUpRight size={17}/>} {wallet?"Comprar con x402":"Conectar y comprar"}</button>
      </article>)}</div>
    </section>

    <section className="shell infra">
      <div className="section-heading"><div><span>Infraestructura</span><h2>Estado real</h2></div><p>{readiness}/3 capas activadas en el entorno desplegado.</p></div>
      <div className="infra-grid">{[
        ["Liquidación x402",status?.ready.payment,"Facilitador público · EIP-3009"],
        ["Motor de inferencia",status?.ready.inference,"Upstream compatible con OpenAI"],
        ["Voucher onchain",status?.ready.contract,status?.contractAddress?short(status.contractAddress):"Contrato listo para desplegar"],
      ].map(([label,ready,detail]) => <div className="infra-item" key={String(label)}><span className={ready?"ok":"pending"}>{ready?<Check size={14}/>:<LoaderCircle size={14}/>}</span><div><b>{label}</b><small>{detail}</small></div></div>)}</div>
    </section>

    <section className="shell portfolio">
      <div className="section-heading"><div><span>Tu inventario</span><h2>Vouchers de capacidad</h2></div><p>El saldo se descuenta únicamente después de una inferencia válida.</p></div>
      {!wallet?<button className="empty" onClick={connect}><Wallet size={20}/> Conectá tu wallet para ver los vouchers</button>:
      vouchers.length===0?<div className="empty"><ShieldCheck size={21}/> Todavía no hay vouchers para {short(wallet)}.</div>:
      <div className="voucher-list">{vouchers.map(voucher => <article className="voucher" key={voucher.id}>
        <div><span>{voucher.offerId}</span><b>{voucher.remainingUnits.toLocaleString("es-UY")} unidades</b><small>ID {short(voucher.id)}</small></div>
        <div className="meter"><i style={{width:`${(voucher.remainingUnits/voucher.totalUnits)*100}%`}}/></div>
        <button disabled={voucher.status!=="active"} onClick={() => { setSelectedVoucher(voucher); setOutput(""); }}>{voucher.status==="active"?"Redimir":voucher.status==="expired"?"Vencido":"Agotado"}</button>
      </article>)}</div>}
    </section>

    {selectedVoucher&&<div className="modal-backdrop" onMouseDown={() => setSelectedVoucher(null)}><section className="modal" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-head"><div><span>Inferencia redimible</span><h3>{selectedVoucher.offerId}</h3></div><button onClick={() => setSelectedVoucher(null)}>×</button></div>
      <label>Prompt<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={5}/></label>
      <label>Gasto máximo (tokens de entrada + salida)<input type="number" min="1" max={MAX_REDEMPTION_UNITS} value={maxUnits} onChange={event => setMaxUnits(Math.min(MAX_REDEMPTION_UNITS,Math.max(1,Math.floor(Number(event.target.value)) || 1)))}/></label>
      <p className="signature-note">Este prompt usa unas {estimatePromptTokens(prompt.trim()).toLocaleString("es-UY")} unidades de entrada. La wallet firma el hash del prompt, el gasto máximo, un nonce de un solo uso y una caducidad de minutos. No se envía ninguna transacción.</p>
      <button className="primary" onClick={redeem} disabled={busy==="redeem"}>{busy==="redeem"?<LoaderCircle className="spin" size={17}/>:<Zap size={17}/>} Ejecutar inferencia</button>
      {output&&<output className="inference-output">{output}</output>}
    </section></div>}

    {notice&&<div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
    <footer className="shell">ComputePass 402 · infraestructura experimental en BSC Testnet <a href="/docs">Manual completo →</a></footer>
  </main>;
}
