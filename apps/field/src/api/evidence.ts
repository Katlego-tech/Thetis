import { HEX64, record, string, UUID } from "../lib/shape";
import { type ApiClient, TIMEOUTS } from "./client";

export function evidenceApi(client: ApiClient) {
  return {
    finalize: (versionId: string) =>
      client.request("POST", `/v1/evidence/${versionId}/finalize`, {
        body: {},
        timeoutMs: TIMEOUTS.finalize,
        parse: (data) => {
          const f = record(data, "finalized", ["versionId", "sha256", "sizeBytes"]);
          if (typeof f.sizeBytes !== "number") throw new Error("sizeBytes");
          return {
            versionId: string(f.versionId, "versionId", UUID),
            sha256: string(f.sha256, "sha256", HEX64),
            sizeBytes: f.sizeBytes,
          };
        },
      }),
  };
}
