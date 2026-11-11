-- Reductions that were already on an enrollment before discounts were recorded get a history row,
-- so every reduced fee has an entry in the discount register. The reason was never written down.
-- List price = fee / (1 - pct/100); the discount is the difference, in whole paise.
INSERT INTO "fee_discount" ("id", "enrollment_id", "branch_id", "kind", "amount", "pct_after", "reason", "origin")
SELECT gen_random_uuid(), e."id", e."branch_id", 'other',
       round(e."fee_total" * e."discount_pct" / (100 - e."discount_pct"))::bigint,
       e."discount_pct",
       'From the institute’s records — reason not recorded', 'import'
FROM "enrollment" e
WHERE e."discount_pct" > 0 AND e."discount_pct" < 100
  AND NOT EXISTS (SELECT 1 FROM "fee_discount" d WHERE d."enrollment_id" = e."id");
