-- NDPA 2023 data-minimisation: an unverified NIN must not be retained forever.
--
-- Only the submission TIME was missing — kycStatus/kycVerifiedAt exist — so we
-- add that column and leave the pruning decision to src/services/kyc-retention.ts.
-- Legacy rows stay NULL and are therefore never pruned automatically.

ALTER TABLE "Member" ADD COLUMN "kycSubmittedAt" TIMESTAMP(3);
