export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const errorSchema = {
    type: "object",
    required: ["error"],
    properties: { error: { type: "string" }, detail: { type: "string" } },
  };
  const voucherSchema = {
    type: "object",
    required: ["id", "offerId", "ownerAddress", "totalUnits", "remainingUnits", "paymentTx", "status", "issuedAt", "expiresAt"],
    properties: {
      id: { type: "string", format: "uuid" }, offerId: { type: "string" },
      ownerAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      totalUnits: { type: "integer" }, remainingUnits: { type: "integer" },
      paymentTx: { type: "string" }, contractTokenId: { type: ["string", "null"] },
      status: { type: "string", enum: ["active", "spent", "expired"] },
      issuedAt: { type: "integer", description: "Unix timestamp" },
      expiresAt: { type: "integer", description: "Unix timestamp" },
    },
  };
  const json = (schema: object) => ({ "application/json": { schema } });

  return Response.json({
    openapi: "3.1.0",
    info: {
      title: "ComputePass 402 API",
      version: "2.0.0",
      description: "Compra de capacidad con x402, inventario de vouchers y redención de inferencia en BSC Testnet.",
    },
    servers: [{ url: origin }],
    tags: [
      { name: "Discovery", description: "Catálogo y estado" },
      { name: "Vouchers", description: "Compra, inventario y consumo" },
    ],
    paths: {
      "/api/status": { get: { tags: ["Discovery"], summary: "Estado de infraestructura", responses: { "200": { description: "Estado actual", content: json({ type: "object", properties: { network: { type: "string" }, chainId: { type: "integer" }, redemptionProtocol: { type: "integer" }, chainName: { type: "string" }, asset: { type: "string" }, facilitator: { type: "string", format: "uri" }, ready: { type: "object", properties: { payment: { type: "boolean" }, inference: { type: "boolean" }, contract: { type: "boolean" } } }, contractAddress: { type: ["string", "null"] } } }) } } } },
      "/api/offers": { get: { tags: ["Discovery"], summary: "Listar ofertas", responses: { "200": { description: "Catálogo", content: json({ type: "object", properties: { offers: { type: "array", items: { type: "object", properties: { id: { type: "string" }, model: { type: "string" }, upstreamModel: { type: "string" }, provider: { type: "string" }, units: { type: "integer", description: "Tokens de entrada + salida" }, priceAtomic: { type: "string" }, decimals: { type: "integer" }, priceLabel: { type: "string" }, latency: { type: "string" }, latencyMs: { type: "integer" }, expiresInDays: { type: "integer" } } } } } }) } } } },
      "/api/vouchers": { get: { tags: ["Vouchers"], summary: "Listar vouchers de una wallet", parameters: [{ name: "owner", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }], responses: { "200": { description: "Inventario", content: json({ type: "object", properties: { vouchers: { type: "array", items: voucherSchema } } }) }, "400": { description: "Dirección inválida", content: json(errorSchema) } } } },
      "/api/reservations": { post: { tags: ["Vouchers"], summary: "Comprar y emitir un voucher", description: "Sin PAYMENT-SIGNATURE responde 402 con PAYMENT-REQUIRED. Con una autorización x402 v2 válida liquida el pago y emite el voucher.", parameters: [{ name: "PAYMENT-SIGNATURE", in: "header", required: false, schema: { type: "string", description: "PaymentPayload x402 v2 en base64" } }], requestBody: { required: true, content: json({ type: "object", required: ["offerId", "buyer"], properties: { offerId: { type: "string" }, buyer: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } }) }, responses: { "200": { description: "Mismo PAYMENT-SIGNATURE reenviado: devuelve el voucher ya emitido, sin cobrar de nuevo", content: json({ type: "object", properties: { voucher: voucherSchema } }) }, "201": { description: "Voucher emitido", headers: { "PAYMENT-RESPONSE": { schema: { type: "string" }, description: "Resultado de liquidación en base64" } }, content: json({ type: "object", properties: { voucher: voucherSchema } }) }, "402": { description: "Pago requerido o rechazado", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" }, description: "Requisitos x402 v2 en base64" } } }, "400": { description: "Solicitud o pago inválido", content: json(errorSchema) }, "409": { description: "Pago en curso o pendiente de conciliación", content: json(errorSchema) }, "502": { description: "Facilitador no disponible, liquidación fallida o de resultado desconocido", content: json(errorSchema) }, "503": { description: "Infraestructura sin configurar", content: json(errorSchema) } } } },
      "/api/redeem": { post: { tags: ["Vouchers"], summary: "Redimir capacidad por inferencia", description: "Protocolo de redención v2. El propietario firma (personal_sign) el mensaje de lib/protocol.ts: dominio, chain ID, voucher, oferta, SHA-256 del prompt, gasto máximo, nonce de un solo uso y caducidad (máx. 600 s). Se cobran tokens de entrada + salida informados por el proveedor, nunca más que maxUnits.", requestBody: { required: true, content: json({ type: "object", required: ["voucherId", "offerId", "address", "prompt", "maxUnits", "nonce", "expiresAt", "signature"], properties: { voucherId: { type: "string", format: "uuid" }, offerId: { type: "string" }, address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, prompt: { type: "string", maxLength: 16000 }, maxUnits: { type: "integer", minimum: 1, maximum: 32000, description: "Tope firmado de tokens de entrada + salida" }, nonce: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, expiresAt: { type: "integer", description: "Unix timestamp; como máximo ahora + 600 s" }, signature: { type: "string", pattern: "^0x" } } }) }, responses: { "200": { description: "Inferencia completada", content: json({ type: "object", properties: { redemptionId: { type: "string", format: "uuid" }, output: { type: "string" }, model: { type: "string" }, usedUnits: { type: "integer" }, usage: { type: "object", properties: { promptTokens: { type: "integer" }, completionTokens: { type: "integer" }, billedFromProvider: { type: "boolean" } } }, remainingUnits: { type: "integer" } } }) }, "400": { description: "Solicitud inválida o maxUnits menor que el prompt", content: json(errorSchema) }, "401": { description: "Firma requerida, inválida, vencida o con caducidad demasiado larga", content: json(errorSchema) }, "404": { description: "Voucher u oferta no encontrados", content: json(errorSchema) }, "409": { description: "Nonce ya usado, oferta distinta, voucher inactivo o capacidad insuficiente", content: json(errorSchema) }, "502": { description: "Fallo del upstream (la reserva se devuelve)", content: json(errorSchema) }, "503": { description: "Upstream no configurado", content: json(errorSchema) } } } },
      "/api/openapi": { get: { tags: ["Discovery"], summary: "Obtener este esquema OpenAPI", responses: { "200": { description: "OpenAPI 3.1 JSON" } } } },
    },
  }, { headers: { "Cache-Control": "public, max-age=300" } });
}
