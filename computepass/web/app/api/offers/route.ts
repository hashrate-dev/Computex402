import { offers } from "@/lib/catalog";

export async function GET() {
  // upstreamModel is public on purpose: buyers should know exactly which model serves their pass.
  return Response.json({ offers }, { headers: { "Cache-Control": "public, max-age=60" } });
}
