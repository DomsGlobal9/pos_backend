-- Changing or clearing a GSTIN already on a customer needs a manager: a swapped GSTIN sends a business's
-- tax credit to someone else. Adding one where there was none stays open to the counter.
INSERT INTO "permissions" ("id", "key")
SELECT gen_random_uuid()::text, 'customer:gstin'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'customer:gstin');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."key" = 'customer:gstin'
 WHERE r."name" IN ('OWNER', 'MANAGER')
ON CONFLICT DO NOTHING;
