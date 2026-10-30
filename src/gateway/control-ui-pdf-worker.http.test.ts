import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readHttp, startControlUiFixture } from "./control-ui-fixture.test-support.js";

const policy =
  "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'none'; connect-src 'none'; worker-src 'none'; form-action 'none'";
const worker = "self.postMessage({ type: 'ready' });";

describe.each(["", "/dashboard"])("PDF worker policy under %j", (basePath) => {
  const dirs = createTempDirTracker();
  let server: Awaited<ReturnType<typeof startControlUiFixture>>;
  beforeAll(async () => {
    const root = dirs.make("openclaw-pdf-worker-");
    await Promise.all([
      fs.writeFile(path.join(root, "pdf-preview-worker.js"), worker),
      fs.writeFile(path.join(root, "sw.js"), "self.skipWaiting();"),
      fs.writeFile(path.join(root, "index.html"), "<!doctype html><html><body>App</body></html>"),
    ]);
    server = await startControlUiFixture({
      basePath,
      root: { kind: "bundled", path: root, publicAssetBuildId: "fixture" },
    });
  });
  afterAll(async () => {
    await server.close().finally(() => dirs.cleanup());
  });
  it.each(["", "/__openclaw__"])(
    "scopes GET, HEAD and 304 to the fixed worker at %j",
    async (namespace) => {
      const url = server.origin + basePath + namespace + "/pdf-preview-worker.js?v=fixture";
      for (const method of ["GET", "HEAD"]) {
        for (const conditional of [false, true]) {
          const response = await readHttp(url, {
            method,
            headers: conditional ? { "If-None-Match": "*" } : {},
          });
          expect(response.status).toBe(conditional ? 304 : 200);
          expect(response.headers["content-security-policy"]).toBe(policy);
          expect(response.headers["x-frame-options"]).toBe("DENY");
          expect(response.headers["x-content-type-options"]).toBe("nosniff");
          expect(response.headers["cache-control"]).toContain("immutable");
          if (!conditional)
            expect(response.headers["content-type"]).toBe("application/javascript; charset=utf-8");
          expect(response.text).toBe(method === "GET" && !conditional ? worker : "");
        }
      }
    },
  );
  it("keeps app and service-worker policy unchanged and unknown workers missing", async () => {
    for (const asset of ["index.html", "sw.js"]) {
      const response = await readHttp(server.origin + basePath + "/" + asset);
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["content-security-policy"]).toContain("object-src 'none'");
      expect(response.headers["x-frame-options"]).toBe("DENY");
    }
    const missing = await readHttp(server.origin + basePath + "/nested/pdf-preview-worker.js");
    expect(missing.status).toBe(404);
    expect(missing.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
