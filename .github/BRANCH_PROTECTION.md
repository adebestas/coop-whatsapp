# GitHub Branch Protection Setup

Run these commands once to protect `staging` and `main` branches with required status checks.

## Prerequisites
- GitHub CLI installed: `gh auth login`
- Admin access to the repository

## Protect `main` Branch

```bash
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["Type-check & Lint","Unit Tests","Security Tests","Build Verification"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"dismiss_stale_reviews":true,"require_code_owner_reviews":true,"required_approving_review_count":1}' \
  --field restrictions=null
```

## Protect `staging` Branch

```bash
gh api repos/{owner}/{repo}/branches/staging/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["Type-check & Lint","Unit Tests","Security Tests","Build Verification"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"dismiss_stale_reviews":true,"require_code_owner_reviews":true,"required_approving_review_count":1}' \
  --field restrictions=null
```

## What This Enforces

| Rule | Effect |
|------|--------|
| **Required status checks** | PR cannot merge until Type-check, Lint, Unit Tests, Security Tests, and Build all pass |
| **Strict status checks** | Branches must be up-to-date with base before merging |
| **Enforce admins** | Even admins must pass checks (no bypass) |
| **Code owner reviews** | Requires review from CODEOWNERS (if defined) |
| **1 approval required** | At least one approving review |
| **Dismiss stale reviews** | New commits dismiss previous approvals |

## Optional: Add CODEOWNERS

Create `.github/CODEOWNERS` to require specific reviewers for sensitive paths:

```
# Security-critical paths require security review
/src/services/webhooks.ts @security-team
/src/services/disbursements.ts @security-team
/src/services/withdrawals.ts @security-team
/src/lib/security*.ts @security-team
/src/routes/admin.ts @security-team
/prisma/migrations/ @db-team
```

Then update the PR review rule to require code owner reviews for these paths.

## Verify Protection

```bash
gh api repos/{owner}/{repo}/branches/main/protection --jq '.required_status_checks.contexts'
gh api repos/{owner}/{repo}/branches/staging/protection --jq '.required_status_checks.contexts'
```