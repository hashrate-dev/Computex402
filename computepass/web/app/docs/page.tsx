import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, BookOpen, Braces, Cpu, ExternalLink, ShieldCheck, Wallet } from "lucide-react";

export const metadata: Metadata = {
  title: "Manual y API · ComputePass 402",
  description: "Manual completo de uso e integración de ComputePass 402.",
};

const base = "https://computepass-402.fabrianchi.chatgpt.site";

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code>{children}</code></pre>;
}

function Method({ verb, path }: { verb: string; path: string }) {
  return <div className="method"><b>{verb}</b><code>{path}</code></div>;
}

export default function DocsPage() {
  return <main className="docs-page">
    <div className="docs-glow" aria-hidden="true" />
    <header className="docs-header shell">
      <Link className="brand" href="/"><span className="brand-mark"><Cpu size={17}/></span><span>ComputePass <b>402</b></span></Link>
      <Link className="back-link" href="/"><ArrowLeft size={14}/> Volver al producto</Link>
    </header>

    <div className="docs-layout shell">
      <aside className="docs-toc">
        <span>DOCUMENTACIÓN</span>
        <a href="#inicio">Inicio rápido</a>
        <a href="#sitio">Uso del sitio</a>
        <a href="#wallet">Wallet y red</a>
        <a href="#compra">Comprar capacidad</a>
        <a href="#redimir">Redimir inferencia</a>
        <a href="#estado">Estado del sistema</a>
        <a href="#api">Referencia API</a>
        <a href="#x402">Flujo x402</a>
        <a href="#errores">Errores</a>
        <a href="#seguridad">Seguridad</a>
      </aside>

      <article className="docs-content">
        <section className="docs-hero" id="inicio">
          <div className="eyebrow"><BookOpen size={13}/> manual de producto + API</div>
          <h1>Cómo operar<br/><span>ComputePass 402.</span></h1>
          <p>Guía completa para comprar capacidad de inferencia, administrar vouchers y consumir el servicio desde una persona, una aplicación o un agente autónomo.</p>
          <div className="docs-badges"><span>BSC Testnet</span><span>x402 v2</span><span>EIP-3009</span><span>JSON API</span></div>
        </section>

        <section className="docs-section">
          <div className="docs-section-title"><span>01</span><div><small>PRIMEROS PASOS</small><h2>Inicio rápido</h2></div></div>
          <div className="step-list">
            <div><b>1</b><p><strong>Instalá o abrí una wallet EVM.</strong> MetaMask y otras wallets compatibles funcionan mediante <code>window.ethereum</code>.</p></div>
            <div><b>2</b><p><strong>Conectate a BSC Testnet.</strong> El sitio solicita cambiar a chain ID <code>97</code> y puede agregar la red si todavía no existe.</p></div>
            <div><b>3</b><p><strong>Elegí un pase.</strong> Cada oferta especifica modelo, capacidad, precio, latencia objetivo y vigencia.</p></div>
            <div><b>4</b><p><strong>Autorizá el pago x402.</strong> La wallet firma una autorización EIP-3009 en U testnet; no se emite un voucher hasta que el facilitador liquide el pago.</p></div>
            <div><b>5</b><p><strong>Redimí capacidad.</strong> Elegí un voucher, escribí el prompt, fijá el máximo de unidades y firmá el mensaje de consumo.</p></div>
          </div>
        </section>

        <section className="docs-section" id="sitio">
          <div className="docs-section-title"><span>02</span><div><small>INTERFAZ</small><h2>Uso del sitio</h2></div></div>
          <div className="docs-grid">
            <article><Wallet size={18}/><h3>Conectar wallet</h3><p>El botón superior conecta la cuenta, cambia a BSC Testnet y carga los vouchers asociados a esa dirección.</p></article>
            <article><Cpu size={18}/><h3>Mercado primario</h3><p>Las tarjetas muestran capacidad disponible y el modelo exacto que la sirve. El precio se expresa en U; una unidad es un token, de entrada o de salida.</p></article>
            <article><ShieldCheck size={18}/><h3>Inventario</h3><p>La cartera muestra saldo inicial, saldo restante, estado y vencimiento de cada voucher emitido.</p></article>
            <article><Braces size={18}/><h3>Estado real</h3><p>Indica si pago, inferencia y contrato onchain están configurados en el entorno productivo.</p></article>
          </div>
        </section>

        <section className="docs-section" id="wallet">
          <div className="docs-section-title"><span>03</span><div><small>RED Y ACTIVOS</small><h2>Wallet y BSC Testnet</h2></div></div>
          <table><tbody>
            <tr><th>Red</th><td>BSC Testnet</td></tr><tr><th>Chain ID</th><td><code>97</code> / <code>0x61</code></td></tr>
            <tr><th>Gas</th><td>tBNB</td></tr><tr><th>Activo de pago</th><td>U testnet</td></tr>
            <tr><th>Contrato U</th><td><code>0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565</code></td></tr>
            <tr><th>Dominio EIP-712</th><td><code>United Stables</code>, versión <code>1</code></td></tr>
          </tbody></table>
          <div className="callout"><b>Importante</b><p>Es una red de prueba. No envíes activos de mainnet ni uses una wallet que custodie fondos importantes.</p></div>
        </section>

        <section className="docs-section" id="compra">
          <div className="docs-section-title"><span>04</span><div><small>RESERVA</small><h2>Comprar capacidad</h2></div></div>
          <p>La compra ocurre en dos solicitudes. La primera devuelve <code>402 Payment Required</code>. El cliente x402 firma la autorización indicada y repite la solicitud con el encabezado <code>PAYMENT-SIGNATURE</code>.</p>
          <ol><li>Seleccioná la oferta.</li><li>Revisá monto, token y dirección receptora en la wallet.</li><li>Firmá la autorización EIP-3009.</li><li>Esperá la verificación y liquidación del facilitador.</li><li>El voucher aparece en “Tu inventario”.</li></ol>
          <p>No se descuenta gas para firmar la autorización; la liquidación onchain la presenta el facilitador. Si la verificación o la liquidación fallan, no se crea el voucher.</p>
        </section>

        <section className="docs-section" id="redimir">
          <div className="docs-section-title"><span>05</span><div><small>INFERENCIA</small><h2>Redimir un voucher</h2></div></div>
          <p>La redención no es una transacción blockchain. La wallet firma (<code>personal_sign</code>) un mensaje que vincula el sitio, la red, el voucher, la oferta, el hash SHA-256 del prompt y el gasto máximo, con un nonce de un solo uso y una caducidad corta.</p>
          <Code>{`ComputePass redemption v2
Domain: <host del sitio>
Chain ID: 97
Voucher: <voucher-id>
Offer: <offer-id>
Prompt SHA-256: <hash-hex>
Max units: <maxUnits>
Nonce: <0x + 64 hex aleatorios>
Expires: <unix, como máximo ahora + 600>`}</Code>
          <p>El backend verifica la firma, marca el nonce como usado, reserva <code>maxUnits</code> de forma condicional y llama al proveedor con el modelo de esa oferta. Se cobra lo que el proveedor informa como tokens de entrada + salida, nunca más que <code>maxUnits</code>; el resto vuelve al voucher. Si el proveedor falla, se devuelve toda la reserva. Una firma reenviada se rechaza con <code>nonce_already_used</code>.</p>
        </section>

        <section className="docs-section" id="estado">
          <div className="docs-section-title"><span>06</span><div><small>OPERACIÓN</small><h2>Estado del sistema</h2></div></div>
          <table><thead><tr><th>Capa</th><th>Activa cuando…</th></tr></thead><tbody>
            <tr><td>Liquidación x402</td><td>Existe una dirección receptora válida configurada.</td></tr>
            <tr><td>Motor de inferencia</td><td>Hay API key de un upstream compatible con OpenAI (OpenRouter por defecto).</td></tr>
            <tr><td>Voucher onchain</td><td>Se configuró la dirección del contrato desplegado.</td></tr>
          </tbody></table>
          <p>Una capa pendiente no es reemplazada por una simulación: el endpoint devuelve un error explícito hasta que sea configurada.</p>
        </section>

        <section className="docs-section api-section" id="api">
          <div className="docs-section-title"><span>07</span><div><small>INTEGRACIÓN</small><h2>Referencia API</h2></div></div>
          <div className="api-links"><a href="/api/openapi" target="_blank">Abrir OpenAPI JSON <ExternalLink size={13}/></a><code>{base}</code></div>

          <div className="endpoint"><Method verb="GET" path="/api/status"/><p>Devuelve red, activo, facilitador y disponibilidad de cada capa.</p><Code>{`curl ${base}/api/status`}</Code></div>

          <div className="endpoint"><Method verb="GET" path="/api/offers"/><p>Lista las ofertas comprables y sus precios en unidades atómicas.</p><Code>{`curl ${base}/api/offers`}</Code></div>

          <div className="endpoint"><Method verb="GET" path="/api/vouchers?owner=0x…"/><p>Lista hasta 50 vouchers de una wallet, ordenados por fecha de emisión.</p><Code>{`curl "${base}/api/vouchers?owner=0xTU_WALLET"`}</Code></div>

          <div className="endpoint"><Method verb="POST" path="/api/reservations"/><p>Inicia o completa una reserva pagada. Sin firma devuelve HTTP 402 y <code>PAYMENT-REQUIRED</code>; con una autorización válida devuelve HTTP 201 y el voucher.</p><Code>{`curl -i -X POST ${base}/api/reservations \\
  -H "content-type: application/json" \\
  -d '{"offerId":"llama-70b-burst","buyer":"0xTU_WALLET"}'`}</Code></div>

          <div className="endpoint"><Method verb="POST" path="/api/redeem"/><p>Consume capacidad tras verificar la firma v2 del propietario (ver “Redimir un voucher”).</p><Code>{`curl -X POST ${base}/api/redeem \\
  -H "content-type: application/json" \\
  -d '{
    "voucherId": "UUID",
    "address": "0xTU_WALLET",
    "prompt": "Explicá x402",
    "offerId": "llama-70b-burst",
    "maxUnits": 512,
    "nonce": "0x…64 hex",
    "expiresAt": 1760000000,
    "signature": "0xFIRMA"
  }'`}</Code></div>
        </section>

        <section className="docs-section" id="x402">
          <div className="docs-section-title"><span>08</span><div><small>PROTOCOLO</small><h2>Flujo x402 para clientes</h2></div></div>
          <p>Para aplicaciones web, usá un cliente x402 que soporte el esquema B402 EIP-3009. El adaptador realiza automáticamente el primer pedido, interpreta el 402, solicita la firma y reintenta.</p>
          <Code>{`import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { B402ExactClientScheme } from "@bnb-chain/b402/client";

const payments = new x402Client().register(
  "eip155:*",
  new B402ExactClientScheme({
    account: walletClient.account,
    methods: ["eip3009"],
  }),
);

const paidFetch = wrapFetchWithPayment(fetch, payments);
const response = await paidFetch("${base}/api/reservations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ offerId, buyer }),
});`}</Code>
          <p>El servidor valida que red, activo, monto, receptor, timeout y datos del esquema coincidan exactamente con la oferta anunciada.</p>
        </section>

        <section className="docs-section" id="errores">
          <div className="docs-section-title"><span>09</span><div><small>DIAGNÓSTICO</small><h2>Errores frecuentes</h2></div></div>
          <table><thead><tr><th>Código</th><th>Significado</th><th>Acción</th></tr></thead><tbody>
            <tr><td><code>merchant_not_configured</code></td><td>Pagos aún no activados.</td><td>Configurar la dirección receptora.</td></tr>
            <tr><td><code>payment_verification_failed</code></td><td>Autorización rechazada.</td><td>Revisar saldo, red, vencimiento y firma.</td></tr>
            <tr><td><code>payment_settlement_failed</code></td><td>No se liquidó onchain.</td><td>No reintentar a ciegas; revisar el estado del pago.</td></tr>
            <tr><td><code>payment_in_progress</code></td><td>Ese pago ya se está procesando o espera conciliación.</td><td>No firmar otro pago; consultar el inventario.</td></tr>
            <tr><td><code>settlement_outcome_unknown</code></td><td>El facilitador no respondió al liquidar.</td><td>No firmar otro pago; se concilia con la cadena.</td></tr>
            <tr><td><code>wallet_signature_invalid</code></td><td>Firma de redención incorrecta.</td><td>Reconstruir exactamente el mensaje v2 documentado, con el host correcto.</td></tr>
            <tr><td><code>nonce_already_used</code></td><td>La firma ya se usó.</td><td>Firmar una solicitud nueva con otro nonce.</td></tr>
            <tr><td><code>signature_expired</code></td><td>La firma venció.</td><td>Firmar de nuevo; la caducidad máxima es 600 s.</td></tr>
            <tr><td><code>max_units_below_prompt</code></td><td>El prompt solo ya supera el gasto máximo.</td><td>Subir <code>maxUnits</code> o acortar el prompt.</td></tr>
            <tr><td><code>insufficient_capacity</code></td><td>El voucher no cubre el máximo solicitado.</td><td>Reducir <code>maxUnits</code> o usar otro voucher.</td></tr>
            <tr><td><code>inference_not_configured</code></td><td>No hay upstream activo.</td><td>Configurar proveedor y secreto.</td></tr>
            <tr><td><code>inference_upstream_failed</code></td><td>Falló el proveedor.</td><td>La capacidad se devuelve; reintentar luego.</td></tr>
          </tbody></table>
        </section>

        <section className="docs-section" id="seguridad">
          <div className="docs-section-title"><span>10</span><div><small>BUENAS PRÁCTICAS</small><h2>Seguridad y límites</h2></div></div>
          <ul><li>Verificá siempre red, activo, monto y receptor antes de firmar.</li><li>No compartas claves privadas ni frases semilla. El sitio nunca las solicita.</li><li>Las API keys del proveedor deben guardarse como secretos del entorno, no en el navegador.</li><li>Los prompts no se almacenan: se registra su hash SHA-256 para auditoría.</li><li><code>maxUnits</code> acepta entre 1 y 32.000 (entrada + salida); la salida de una llamada se limita a 4096 tokens y los prompts a 16.000 caracteres.</li><li>Cada firma de redención sirve una sola vez y vence en 10 minutos como máximo.</li><li>La consulta de vouchers es pública por dirección; la redención exige prueba criptográfica de propiedad.</li></ul>
        </section>

        <footer className="docs-footer"><span>ComputePass 402 · documentación v2</span><Link href="/">Volver al mercado →</Link></footer>
      </article>
    </div>
  </main>;
}
