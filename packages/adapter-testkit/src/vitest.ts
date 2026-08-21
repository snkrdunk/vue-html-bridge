import { describe, it } from "vitest";
import {
  createAdapterContractCases,
  type AdapterContractFixture,
} from "./contract.js";

export function defineVitestAdapterContract<TSettings>(
  name: string,
  fixture: AdapterContractFixture<TSettings>,
): void {
  describe(name, () => {
    for (const contractCase of createAdapterContractCases(fixture)) {
      it(contractCase.name, contractCase.run);
    }
  });
}
