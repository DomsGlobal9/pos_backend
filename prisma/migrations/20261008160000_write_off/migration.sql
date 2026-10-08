-- Writing off what a customer will never pay (owner's go-ahead, 8 Oct). Recorded as a BALANCE row
-- that closes the bill without pretending money came in; a cashier needs a manager.
ALTER TYPE "PaymentStatus" ADD VALUE 'WRITTEN_OFF';
ALTER TYPE "ApprovalKind" ADD VALUE 'WRITE_OFF';

INSERT INTO "permissions" ("id", "key")
SELECT gen_random_uuid()::text, 'order:write_off'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'order:write_off');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."key" = 'order:write_off'
 WHERE r."name" IN ('OWNER', 'MANAGER')
ON CONFLICT DO NOTHING;
