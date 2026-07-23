## 1. Source Analysis and Requirement Extraction

- [ ] 1.1 Map all crawler/report-relevant commits since `8cf8f9d937c1b4e320b81a35425ba5040b8c9fc5` to behavioral deltas.
- [ ] 1.2 Reconcile extracted behaviors against `AGENTS.md` pitfalls/testing considerations to remove ambiguity.
- [ ] 1.3 Group extracted behaviors into stable capability domains.

## 2. OpenSpec Artifact Authoring

- [ ] 2.1 Write `proposal.md` with clear motivation, impact, and capability contract.
- [ ] 2.2 Author one `spec.md` per capability under `specs/` using ADDED requirements and executable scenarios.
- [ ] 2.3 Document implementation rationale and source mapping in `design.md`.

## 3. Quality Gates and Change Hygiene

- [ ] 3.1 Validate OpenSpec artifacts (`openspec validate --strict`).
- [ ] 3.2 Ensure requirement language is normative (SHALL/MUST) and scenario complete.
- [ ] 3.3 Keep this change isolated on a dedicated branch and commit all OpenSpec artifacts together.