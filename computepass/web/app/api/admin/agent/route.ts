import { handleAdminAgent } from "@/lib/server/agent";
import { workerDeps } from "@/lib/server/deps";

export async function GET(request: Request) {
  return handleAdminAgent(request, workerDeps());
}

export async function POST(request: Request) {
  return handleAdminAgent(request, workerDeps());
}
