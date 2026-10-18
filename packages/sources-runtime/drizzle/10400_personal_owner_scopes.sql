-- Personal owner scopes (personal-connection-attribution, range 10400-10449).
--
-- A connected personal account (Granola, Zoom, Cursor, WhatsApp/Instagram personal) belongs to the verified
-- yc_msaw principal that connected it. Each principal gets one runtime "scope tenant" per yc_msaw tenant; the
-- donor lanes run there unchanged, so tokens, lane state, raw ids, schedules and OAuth state never mix between
-- two members of one organization. Rows are written only by the service-authenticated internal API from the
-- forwarded principal (never from a request body or a provider payload) and are never updated.
CREATE TABLE IF NOT EXISTS source_lane_personal_scopes (
  scope_tenant_id text PRIMARY KEY,
  parent_tenant_id text NOT NULL,
  segment text NOT NULL,
  owner_issuer text NOT NULL,
  owner_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_lane_personal_scopes_segment_ck CHECK (segment ~ '^@u-[0-9a-f]{24}$'),
  CONSTRAINT source_lane_personal_scopes_scope_ck CHECK (scope_tenant_id = parent_tenant_id || '.' || substr(segment, 2)),
  CONSTRAINT source_lane_personal_scopes_owner_uq UNIQUE (parent_tenant_id, owner_issuer, owner_subject),
  CONSTRAINT source_lane_personal_scopes_segment_uq UNIQUE (parent_tenant_id, segment)
);

-- Device bindings enrolled into a member's owner scope (iMessage, coding sessions, office audio). The device key names
-- the organization tenant and the binding (`<prefix>_<tenantNs>.<bindingId>.<secret>`); this row says which owner
-- scope that binding's device registry row and captured data live in. Written only at enrolment, by the internal API,
-- from the forwarded principal. A binding without a row is a device enrolled before owner scopes (organization tenant).
CREATE TABLE IF NOT EXISTS source_lane_personal_devices (
  parent_tenant_id text NOT NULL,
  provider text NOT NULL,
  binding_id text NOT NULL,
  scope_tenant_id text NOT NULL REFERENCES source_lane_personal_scopes (scope_tenant_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_tenant_id, provider, binding_id)
);
