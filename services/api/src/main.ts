import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { route } from "./routes.ts";
import { createAccessClients } from "./supabase.ts";

const clients = createAccessClients();

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return route(event, clients);
}
