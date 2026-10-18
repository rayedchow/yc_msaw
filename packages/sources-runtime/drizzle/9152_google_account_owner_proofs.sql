-- Google account ownership proofs (google-auth range 9150-9159; owner-only personal sources).
--
-- A yc_msaw principal proves control of a Google address with an identity-only Google sign-in
-- (scopes `openid email`, online access, no refresh token): the callback checks the OIDC nonce,
-- PKCE, email_verified and that the consenting account is the expected address. Nothing is
-- stored except the fact below; no token, and no google_oauth_grants row, so the address keeps
-- its collection mode (a domain-wide-delegation mailbox stays DWD). The runtime reports the
-- newest of grant/proof as the address's owner (providers/google-auth/index.ts).
-- Bookkeeping only: not journaled, not exported.
CREATE TABLE IF NOT EXISTS google_account_owner_proofs (
  tenant_id text NOT NULL,
  account_email text NOT NULL CHECK (account_email = lower(account_email) AND account_email <> ''),
  google_sub text NOT NULL,
  hosted_domain text,
  proven_by_subject text NOT NULL,
  proven_by_issuer text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_email)
);
