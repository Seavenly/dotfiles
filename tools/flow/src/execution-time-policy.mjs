const POLICY_FIELDS = {
  wall_elapsed: {
    includes: [
      "accepted_baseline_to_current_observation",
      "human_checkpoint_wait",
      "passive_retained_wait",
    ],
    same_boot_source: "suspend_excluding_monotonic",
    cross_boot_source: "wall_clock",
  },
  active_execution: {
    definition: "sum_of_admitted_invocation_intervals",
    excludes: ["human_checkpoint_wait", "passive_retained_wait"],
  },
  fresh_observation_boundaries: [
    "admission",
    "before_dispatch",
    "receipt_or_failure",
    "cancellation_or_settlement",
    "timer_evaluation",
  ],
  uncertainty: {
    representation: "lower_upper_bounds",
    straddling_decision: "block_new_admission",
    missing_or_invalid_fact: "block_new_admission",
  },
  authority: {
    limits: "exact_confirmed_run_and_attempt_bounds",
    expansion: "exact_human_checkpoint_or_revision_authority",
    timer_ownership_transfer: "forbidden",
  },
};

export const EXECUTION_TIME_ACCOUNTING_POLICY = Object.freeze({
  schema: "flow.execution-time-accounting/v1",
  contracts: Object.freeze({
    confirmation: "flow.execution-time-accounting/v1",
    projection: "flow.execution-time-projection/v1",
    time_fact: "flow.time-fact/v1",
  }),
  ...POLICY_FIELDS,
});

export const EXECUTION_TIME_CONFIRMATION_ACCOUNTING = Object.freeze({
  schema: EXECUTION_TIME_ACCOUNTING_POLICY.schema,
  ...POLICY_FIELDS,
});

export const EXECUTION_TIME_CATALOG_ACCOUNTING = Object.freeze({
  ...executionTimePolicyFields(),
});

function executionTimePolicyFields() {
  return {
    confirmation: EXECUTION_TIME_ACCOUNTING_POLICY.contracts.confirmation,
    projection: EXECUTION_TIME_ACCOUNTING_POLICY.contracts.projection,
    time_fact: EXECUTION_TIME_ACCOUNTING_POLICY.contracts.time_fact,
    wall_elapsed: EXECUTION_TIME_ACCOUNTING_POLICY.wall_elapsed,
    active_execution: EXECUTION_TIME_ACCOUNTING_POLICY.active_execution,
    fresh_observation_boundaries:
      EXECUTION_TIME_ACCOUNTING_POLICY.fresh_observation_boundaries,
    uncertainty: EXECUTION_TIME_ACCOUNTING_POLICY.uncertainty,
    authority: EXECUTION_TIME_ACCOUNTING_POLICY.authority,
  };
}
