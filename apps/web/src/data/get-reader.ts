import scenario from "../../../../fixtures/web/demo-scenario.json";
import { referenceReader, type ThetisReader } from "./reader";

export function getReader(): ThetisReader {
  return referenceReader(scenario);
}
