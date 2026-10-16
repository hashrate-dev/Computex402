import { handleMaintenance } from "@/lib/server/maintenance";
import { workerDeps } from "@/lib/server/deps";

export async function POST(request: Request) {
  return handleMaintenance(request, workerDeps());
}
