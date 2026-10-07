-- A credit sale (udhaar): goods go home now, money is owed. The shop is lending, so a cashier needs a
-- manager -- the same shape as payment:void (20260930120000).
ALTER TYPE "ApprovalKind" ADD VALUE 'PAY_LATER';

INSERT INTO "permissions" ("id", "key")
SELECT gen_random_uuid()::text, 'sale:pay_later'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'sale:pay_later');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."key" = 'sale:pay_later'
 WHERE r."name" IN ('OWNER', 'MANAGER')
ON CONFLICT DO NOTHING;
