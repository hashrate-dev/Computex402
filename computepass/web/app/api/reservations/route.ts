import { handleReservation } from "@/lib/server/reservations";
import { workerDeps } from "@/lib/server/deps";

export async function POST(request: Request) {
  return handleReservation(request, workerDeps());
}
