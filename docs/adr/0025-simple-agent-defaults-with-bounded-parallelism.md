# Use one agent configuration by default with bounded parallelism

## Context

Planner and reviewer templates invoke several agent roles, while init currently rewrites every role to the same selected model. Exposing a separate agent, model, and effort prompt for every role would make first-time setup difficult for a non-code user. At the same time, advanced users may want a stronger planning model and a faster implementation or merge model.

Parallel workflows also trade speed for subscription usage and Git conflict risk. An unbounded number of host agents can exhaust account limits, contend for machine resources, and create more integration conflicts.

## Decision

- Init asks for one agent, model, and effort configuration and applies it to every workflow role by default.
- `sandcastle configure` provides an advanced section where planner, implementer, reviewer, and merger roles can override that shared default independently.
- Sequential workflows run one GitHub Issue at a time.
- Parallel workflows default to at most two active issues. Configure allows a limit from one through four; there is no unbounded option.

## Consequences

- A first-time user makes one understandable model decision rather than configuring an orchestration graph.
- Role-specific cost and quality tuning remains available without becoming required setup.
- Parallel work has a predictable upper bound on local processes and subscription pressure.
- A configured limit reduces but does not eliminate merge conflicts; ADR 0024's integration and retry behavior remains required.
