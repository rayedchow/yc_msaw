// The sources runtime parses process.env at import time (src/env.ts). Test-only placeholder values; the end-to-end
// tests use an in-process PGlite database and never connect to DATABASE_URL.
process.env.DATABASE_URL ??= "postgres://localhost:5432/shepherd_onboard_e2e_unused";
process.env.ENCRYPTION_KEY ??= "shepherd-onboard-e2e-encryption-key";
process.env.API_KEY_PEPPER ??= "shepherd-onboard-e2e-api-key-pepper";
process.env.WORKOS_API_KEY ??= "sk_test_unused";
process.env.WORKOS_CLIENT_ID ??= "client_test_unused";
