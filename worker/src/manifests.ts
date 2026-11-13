import correctness from "../../modules/agents/correctness/manifest.json";
import contracts from "../../modules/agents/contracts/manifest.json";
import tests from "../../modules/agents/tests/manifest.json";
import performance from "../../modules/agents/performance/manifest.json";
import verifier from "../../modules/agents/verifier/manifest.json";
import security from "../../modules/agents/security/manifest.json";
export const agents: Record<
  string,
  {
    version: number;
    name: string;
    run: boolean;
    available: boolean;
    contracts?: boolean;
    second_look?: boolean;
  }
> = { correctness, contracts, tests, performance, verifier, security };
