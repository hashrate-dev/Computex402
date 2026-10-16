import { handleRedeem } from "@/lib/server/redeem";
import { workerDeps } from "@/lib/server/deps";

export async function POST(request: Request) {
  return handleRedeem(request, workerDeps());
}
