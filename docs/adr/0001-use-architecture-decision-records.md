# ADR-0001: Use Architecture Decision Records

- Status: Accepted
- Date: 2026-03-07

## Context

Sidearm is intended to replace a working AutoHotkey-based setup with a long-lived Windows desktop application built around Tauri, Rust, and a typed frontend. Several early choices are expensive to reverse later:

- the runtime split between Synapse, the app shell, the Rust core, and the frontend
- the control-based domain model
- the discovery and verification flow for device-specific behavior
- the persistence format and migration story
- security boundaries around plugins, actions, and launch behavior

These decisions need a durable record that is easy to extend without rewriting a single large architecture document.

## Decision Drivers

- Preserve the reasoning behind high-cost architectural choices.
- Keep decision history close to the codebase.
- Make trade-offs, assumptions, and validation debt explicit.
- Support later superseding decisions without editing history away.
- Keep documents short enough to stay current.

## Considered Options

### Option 1: Keep architecture notes informally in README and chat history

- Pros: low overhead
- Cons: weak traceability, easy to lose rationale, poor change history

### Option 2: Maintain a single large architecture document

- Pros: one place to read
- Cons: hard to evolve, encourages mixing stable decisions with transient notes, difficult to supersede specific choices

### Option 3: Maintain small numbered ADRs

- Pros: append-only history, localized changes, explicit status, good fit for evolving architecture
- Cons: more files to manage, requires basic discipline

## Decision

The project will use small, numbered Architecture Decision Records stored under `docs/adr/`.

Each ADR should be short and include, at minimum:

- status
- date
- context
- considered options
- decision
- consequences
- references when an external source materially informed the choice

ADRs are append-only records:

- Existing ADRs may receive factual corrections, but not silent reversals.
- If a decision changes, a new ADR supersedes the older one.
- Architectural uncertainty must be recorded explicitly instead of being hidden in vague wording.

The first ADR set will cover:

- the ADR practice itself
- the Tauri v2 + React + Rust in-process architecture
- the control-based domain model and versioned JSON config
- the hybrid device discovery and verification flow

## Consequences

- The project gains a durable decision log from day one.
- Early ambiguity remains visible instead of being flattened into implementation guesses.
- Team members can challenge or supersede decisions without rewriting history.
- There is a small overhead for every material architectural change, but that overhead is intentional.

## References

- Microsoft, "Architecture decision records": https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record
- AWS Prescriptive Guidance, "Architecture decision records": https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/welcome.html
- MADR project: https://adr.github.io/madr/
