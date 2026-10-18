import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SourceService } from "../src/sources/service.js";
import { DEFAULT_NODE_CACHE_BYTES } from "../src/sources/store.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

/**
 * perf-verification-2 O2: a warm find over ~38k message directories took 2.7 s at a 64 MiB node cache (the walk
 * thrashed the LRU) and 0.2 s once its ~72 MiB working set fit. The default budget covers that, and operators can size it.
 */
describe("$SOURCES node cache budget", () => {
  it("defaults to 256 MiB and follows SOURCES_NODE_CACHE_MB", () => {
    expect(DEFAULT_NODE_CACHE_BYTES).toBe(256 * 1024 * 1024);
    expect(new SourceService(new DirectoryObjectStore("/nonexistent-node-cache-test")).nodeCache.maxBytes).toBe(DEFAULT_NODE_CACHE_BYTES);
    expect(loadConfig({}).sourcesNodeCacheBytes).toBeUndefined();
    expect(loadConfig({ SOURCES_NODE_CACHE_MB: "1024" }).sourcesNodeCacheBytes).toBe(1024 * 1024 * 1024);
    for (const bad of ["8", "0.5", "lots", "999999"]) expect(() => loadConfig({ SOURCES_NODE_CACHE_MB: bad })).toThrow(/SOURCES_NODE_CACHE_MB/);
  });
});
