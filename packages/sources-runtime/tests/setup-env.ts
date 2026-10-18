// Test environment defaults. src/env.ts parses process.env at import time, so
// every required variable needs a value before any module under test loads.
process.env.DATABASE_URL ??= "postgres://localhost:5432/aqueduct_test";
process.env.ENCRYPTION_KEY ??= "aqueduct-test-encryption-key";
process.env.API_KEY_PEPPER ??= "aqueduct-test-api-key-pepper";
process.env.WORKOS_API_KEY ??= "sk_test_workos";
process.env.WORKOS_CLIENT_ID ??= "client_test_workos";
