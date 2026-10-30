export const ACCEPTANCE_MODEL = "acceptance-fixture-v1" as const;
export const ACCEPTANCE_PROVIDER = "acceptance" as const;
export const ACCEPTANCE_ACCOUNT_SLOT = "acceptance-fixture" as const;
export const ACCEPTANCE_PROMPT_VERSION = "acceptance-fixture-v1" as const;
export const ACCEPTANCE_FIXTURE_MIME_TYPE = "image/png" as const;
export const ACCEPTANCE_FIXTURE_BYTE_SIZE = 754;
export const ACCEPTANCE_FIXTURE_SHA256 =
  "b41794a785df3d91b13165ac34b59d7cae99060e75305a5901ae7e96f53e4de2";

export const ACCEPTANCE_SCENARIOS = [
  "happy_path",
  "claim_ack_loss",
  "output_ack_loss",
  "spool_recovery",
  "reconciliation",
] as const;

export type AcceptanceScenario = (typeof ACCEPTANCE_SCENARIOS)[number];

const ACCEPTANCE_RUN_PREFIXES: ReadonlyArray<
  readonly [prefix: string, scenario: AcceptanceScenario]
> = [
  ["happy-path-", "happy_path"],
  ["claim-ack-loss-", "claim_ack_loss"],
  ["output-ack-loss-", "output_ack_loss"],
  ["spool-recovery-", "spool_recovery"],
  ["reconciliation-", "reconciliation"],
];

export function isAcceptanceScenario(value: string): value is AcceptanceScenario {
  return ACCEPTANCE_SCENARIOS.some((scenario) => scenario === value);
}

export function acceptanceScenarioFromRunId(runId: string): AcceptanceScenario {
  const match = ACCEPTANCE_RUN_PREFIXES.find(([prefix]) =>
    runId.startsWith(prefix),
  );
  if (!match) throw new Error("INVALID_ACCEPTANCE_SCENARIO");
  return match[1];
}
