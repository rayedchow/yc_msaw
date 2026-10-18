-- Google Contacts name enrichment: email -> display name pairs from the
-- People API (people.connections.list + otherContacts.list), synced per
-- Google-connected workspace user of the tenant. Names only - no phone
-- numbers, photos, or raw payload dumps (privacy decision, see
-- docs/integrations/google-contacts.md).
CREATE TABLE "google_contact_names" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL,
  "email" text NOT NULL,
  "display_name" text NOT NULL,
  "source" text NOT NULL,
  "owner_email" text NOT NULL,
  "resource_name" text NOT NULL,
  "synced_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_google_contact_name_tenant_email" UNIQUE ("tenant_id", "email"),
  CONSTRAINT "ck_google_contact_name_source" CHECK ("source" IN ('connections', 'other_contacts'))
);
