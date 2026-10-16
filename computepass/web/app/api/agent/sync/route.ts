import { handleAgentSync } from "@/lib/server/agent";
import { workerDeps } from "@/lib/server/deps";

export async function POST(request: Request) {
  return handleAgentSync(request, workerDeps());
}
