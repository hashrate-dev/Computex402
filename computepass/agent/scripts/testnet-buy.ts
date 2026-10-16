/**
 * One real ComputePass purchase on BSC testnet, with a throwaway buyer wallet.
 *
 *   COMPUTEPASS_API_URL=http://127.0.0.1:8788 npx tsx scripts/testnet-buy.ts [offerId]
 *
 * - The buyer key lives in $TESTNET_BUYER_KEY_FILE (default
 *   ~/.computepass/testnet-buyer.key, mode 600), outside the repo. It is
 *   created on first run and never printed.
 * - If the wallet holds less U than the offer price it prints the address to
 *   fund and exits 2 without signing anything. EIP-3009 needs no tBNB.
 * - Buys exactly one pass, capped at the advertised price. Does not redeem.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { ComputePassClient } from "../src/api.js";
import { fromAtomic, loadConfig } from "../src/config.js";
import { Ledger } from "../src/ledger.js";

const keyFile = process.env.TESTNET_BUYER_KEY_FILE ?? join(homedir(), ".computepass", "testnet-buyer.key");
const offerId = process.argv[2] ?? "llama-70b-burst";
const apiUrl = (process.env.COMPUTEPASS_API_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");

if (!existsSync(keyFile)) {
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, `${generatePrivateKey()}\n`, { mode: 0o600 });
  console.log(`Wallet de prueba creada; clave en ${keyFile} (no la compartas).`);
}
chmodSync(keyFile, 0o600);
const key = readFileSync(keyFile, "utf8").trim() as Hex;
const account = privateKeyToAccount(key);
console.log(`Comprador (solo testnet): ${account.address}`);

const statusRes = await fetch(`${apiUrl}/api/status`).catch(() => null);
const status = (await statusRes?.json().catch(() => null)) as { ready?: { payment?: boolean } } | null;
if (!status?.ready?.payment) {
  console.error(`El sitio en ${apiUrl} no responde o no tiene MERCHANT_ADDRESS configurada.`);
  process.exit(1);
}
const { offers } = (await (await fetch(`${apiUrl}/api/offers`)).json()) as { offers: Array<{ id: string; priceAtomic: string; decimals: number }> };
const offer = offers.find((o) => o.id === offerId);
if (!offer) throw new Error(`oferta desconocida: ${offerId}`);
const price = fromAtomic(offer.priceAtomic, offer.decimals);

const asset = (process.env.COMPUTEPASS_ASSET ?? "0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565") as Hex;
const chain = createPublicClient({ chain: bscTestnet, transport: http(process.env.BSC_RPC_URL) });
const balance = await chain
  .readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })
  .catch((e: Error) => {
    console.error(`No pude leer el saldo en BSC testnet (${e.message.split("\n")[0]}). Probá con otro BSC_RPC_URL.`);
    process.exit(1);
  });
console.log(`Saldo: ${fromAtomic(balance, offer.decimals)} U · precio de ${offerId}: ${price} U`);
if (balance < BigInt(offer.priceAtomic)) {
  console.log(`\nFondeá ${account.address} con al menos ${price} U en BSC testnet y volvé a correr este comando.`);
  process.exit(2);
}

const cfg = loadConfig({
  ...process.env,
  COMPUTEPASS_API_URL: apiUrl,
  BUYER_PRIVATE_KEY: key,
  BUDGET_MAX_PER_PURCHASE: String(price),
  BUDGET_MAX_PER_DAY: String(price),
  COMPUTEPASS_STATE_DIR: process.env.COMPUTEPASS_STATE_DIR ?? join(homedir(), ".computepass", "state"),
});
const api = new ComputePassClient(cfg, new Ledger(cfg));
const result = await api.buy(offerId);
const tx = (result.settlement?.transaction as string | undefined) ?? result.voucher.txHash;
console.log(`\nCompra hecha. Voucher ${result.voucher.id}: ${result.voucher.remainingUnits} unidades.`);
console.log(`Pagado: ${result.paid} U · tx ${tx}`);
if (tx?.startsWith("0x")) console.log(`https://testnet.bscscan.com/tx/${tx}`);
