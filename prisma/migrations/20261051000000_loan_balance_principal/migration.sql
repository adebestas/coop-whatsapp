-- =============================================================================
-- Recompute Loan.balance as the outstanding PRINCIPAL
-- =============================================================================
-- The old approval path set balance = totalRepayable (principal + ALL interest),
-- but repayment decremented balance by the principal portion only. So a loan
-- never reached zero after its contractual installments and the member was
-- charged an extra installment.
--
-- balance is the outstanding principal everywhere it is read (isPaid,
-- deductions, guarantor exposure, loan-protection write-off, provisioning).
--
-- Derivation: balance_old = total - principalRepaid, so
--   balance_new = amount - principalRepaid = balance_old - (total - amount)
-- where total = monthlyPayment * tenureMonths.
-- =============================================================================

UPDATE "Loan"
SET "balance" = GREATEST(
  0,
  "balance" - (COALESCE("monthlyPayment", 0) * "tenureMonths" - "amount")
)
WHERE "status" IN ('approved', 'disbursed')
  AND "monthlyPayment" IS NOT NULL
  AND "balance" > "amount";
