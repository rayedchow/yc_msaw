import { getTenantBinding } from "../../export/bindings.js";
import type { DbExecutor } from "../../core/types.js";
import type { DeviceKeyParts } from "./device-auth.js";
import { DEVICE_KEY_HEADER } from "./device-auth.js";

/**
 * yc_msaw is the authority over device credentials. On every uploader request the runtime asks
 * it whether the presented key still belongs to an active device binding of the key's tenant
 * (`GET <yc_msaw>/v1/sources/devices/imessage/verify` with the key itself in `x-api-key`), so
 * revoking the binding in yc_msaw refuses the device on its next request even if the forwarded
 * runtime revoke never arrived. No answer means no upload: the uploader gets a retryable 503.
 *
 * The yc_msaw base URL is the tenant's own source binding publish URL (set by yc_msaw when it
 * provisioned the tenant); no tenant- or caller-supplied URL is ever used.
 */

export type AuthorityVerdict = { state: "active" } | { state: "revoked"; reason: string } | { state: "unavailable"; reason: string };

export interface DeviceAuthority {
  verify(key: string, device: DeviceKeyParts): Promise<AuthorityVerdict>;
}

const VERIFY_TIMEOUT_MS = 10_000;

export function createBindingAuthority(db: DbExecutor, fetchImpl: typeof fetch = fetch, timeoutMs = VERIFY_TIMEOUT_MS): DeviceAuthority {
  return {
    async verify(key, device) {
      let base: string;
      try {
        const binding = await getTenantBinding(db, device.tenantNs);
        if (!binding) return { state: "unavailable", reason: "tenant has no source binding (provision it from yc_msaw)" };
        base = binding.publishUrl;
      } catch (e) {
        return { state: "unavailable", reason: `binding lookup failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      let res: Response;
      try {
        // No Content-Type and no body: yc_msaw's HTTP layer parses any JSON-typed request body.
        res = await fetchImpl(new URL("/v1/sources/devices/imessage/verify", base), {
          method: "GET",
          headers: { [DEVICE_KEY_HEADER]: key },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        return { state: "unavailable", reason: `yc_msaw unreachable: ${e instanceof Error ? e.message : String(e)}` };
      }
      // Only yc_msaw's verify refusal (401) revokes. A 403/404 can come from a WAF, a misrouted deploy or a replica
      // with sources disabled; treating it as revocation would permanently revoke every device that checks in.
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        return { state: "revoked", reason: `yc_msaw refused the device key (${res.status})` };
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { state: "unavailable", reason: `yc_msaw answered ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { tenantNs?: unknown; bindingId?: unknown; provider?: unknown } | null;
      // The authority must confirm exactly the identity inside the key.
      if (!body || body.tenantNs !== device.tenantNs || body.bindingId !== device.bindingId || body.provider !== "imessage") {
        return { state: "revoked", reason: "yc_msaw confirmed a different identity" };
      }
      return { state: "active" };
    },
  };
}
