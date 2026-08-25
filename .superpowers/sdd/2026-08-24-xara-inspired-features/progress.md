# SDD ledger — plan: docs/superpowers/plans/2026-08-24-xara-inspired-features.md

## Pre-flight Conflict Scan

| Task A | Task B | Shared Interface | Conflict? | Ruling |
|--------|--------|-----------------|-----------|--------|
| Task 1 (Payees) | Task 2 (Freeze) | Member model (both add relations) | No — different models (FavoritePayee vs Wallet) | Clean |
| Task 1 (Payees) | Task 5 (Enriched) | getMemberByPhone, formatBalance | No — Task 5 consumes, Task 1 is independent | Clean |
| Task 2 (Freeze) | Task 5 (Enriched) | handleBalance, handleSave | No — Task 2 adds gate, Task 5 enriches output | Clean |
| Task 3 (Analytics) | Task 5 (Enriched) | handleBalance | No — Task 3 adds new command, Task 5 modifies existing | Clean |
| Task 4 (Voice) | Tasks 1-3,5 | inbound.ts, webhook.ts | No — Task 4 adds audio path, others don't touch inbound | Clean |
| Task 1 (Payees) | Task 1 text | FavoritePayee model + Member relation + test | Self-consistent — plan matches | Clean |
| Task 2 (Freeze) | Task 2 text | Wallet.frozen + freeze.ts + conversation.ts gate + test | Self-consistent | Clean |
| Task 3 (Analytics) | Task 3 text | spending.ts + analytics command + test | Self-consistent | Clean |
| Task 4 (Voice) | Task 4 text | voice.ts + inbound.ts + webhook.ts + test | Self-consistent | Clean |
| Task 5 (Enriched) | Task 5 text | conversation.ts handleSave/handleBalance + test | Self-consistent | Clean |

Scan is clean. No conflicts found. Proceeding to execution.
