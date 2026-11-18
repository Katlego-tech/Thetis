import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method !== "GET" || event.rawPath !== "/health") {
    return { statusCode: 404 };
  }
  return { statusCode: 200, body: JSON.stringify({ status: "ok", service: "api" }) };
}
