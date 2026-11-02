# Data Protection Impact Assessment (DPIA) template

Use this template for any processing that is likely to result in a high risk to
members' rights under the Nigeria Data Protection Act 2023 (NDPA). Record the
completed assessment in the platform (`DpiaRecord`) via the developer console:
`POST /api/developer/coops/:id/dpias`.

Typical triggers for a cooperative:

- BVN, NIN, biometric or full KYC data at scale
- credit scoring, loan decisioning or automated eligibility rules
- location, transaction or behavioural profiling
- cross-border transfer of member data (also record it in the cross-border register)
- new vendor or WhatsApp channel processing member data
- large-scale use of a new data category

## 1. Assessment details

| Field | Entry |
| --- | --- |
| Title | |
| Processing activity | |
| Owner (DPO or delegate) | |
| Date started | |
| Next review date | |
| Status (`draft` / `approved` / `review_due` / `archived`) | |

## 2. Description of the processing

- What personal data is collected, and from whom?
- Why is it collected, and what is the lawful basis (consent, contract, legal obligation, vital interest, public task, legitimate interest)?
- How is it stored, who can access it, and how long is it retained?
- Which processors, integrations, or WhatsApp/payment providers receive it?
- Does any data leave Nigeria? If yes, complete the cross-border transfer record.

## 3. Necessity and proportionality

- Is the processing necessary for the stated purpose?
- Could the same outcome be achieved with less data or a less intrusive method?
- How is data minimisation applied?
- What is the retention period, and how is deletion enforced?

## 4. Risks to data subjects

For each risk, note likelihood (low/medium/high), severity, and the affected
data subjects.

| Risk | Likelihood | Severity | Notes |
| --- | --- | --- | --- |
| Unauthorised access / insider misuse | | | |
| Accidental disclosure (wrong recipient, group chat, export) | | | |
| Loss or theft of device or backup | | | |
| Re-identification from pseudonymised data | | | |
| Excessive retention | | | |
| Cross-border transfer without safeguards | | | |
| Vendor or processor failure | | | |
| Automated decision causing unfair exclusion | | | |

## 5. Mitigations

For every risk above, record the control that reduces it and the residual risk:

- access control and role separation (cooperative-scoped tenancy, RLS)
- encryption in transit and at rest
- audit logging and monitoring
- consent capture and withdrawal
- data-retention job and deletion workflow
- staff training and confidentiality undertakings
- processor contract with NDPA obligations
- breach detection and the 72-hour NDPC notification workflow

## 6. Consultation and sign-off

- Were data subjects or their representatives consulted? Outcome:
- Was the DPO consulted? Outcome:
- Is prior consultation with the NDPC required (residual high risk)? If yes, record the submission and response.
- Approved by / date:
- Review date and trigger for early review:

## 7. Outcome

- Decision (`proceed` / `proceed with conditions` / `do not proceed`)
- Conditions or actions, with owners and deadlines
- Link to related breach, cross-border, or vendor records
