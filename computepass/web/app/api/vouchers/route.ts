import { handleListVouchers } from "@/lib/server/vouchers";
import { workerDeps } from "@/lib/server/deps";

export async function GET(request: Request) {
  return handleListVouchers(request, workerDeps());
}
