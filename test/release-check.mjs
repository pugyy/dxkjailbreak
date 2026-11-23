import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLatestRelease } from "../lib/release-check.js";

function release(tag_name, other = {}) {
  return async () => Response.json({ tag_name, draft: false, prerelease: false, ...other });
}

test("queries the official release API and builds the project release link", async () => {
  const result = await checkLatestRelease("1.2.9", async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/pugyy/dxkjailbreak/releases/latest");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return release("v1.2.10", { html_url: "https://example.com" })();
  });
  assert.deepEqual(result, {
    ok: true, state: "available", currentVersion: "1.2.9", latestTag: "v1.2.10",
    releaseUrl: "https://github.com/pugyy/dxkjailbreak/releases/tag/v1.2.10",
  });
});

test("compares versions numerically, including local pre-release builds", async () => {
  assert.equal((await checkLatestRelease("1.3.0", release("v1.3"))).state, "current");
  assert.equal((await checkLatestRelease("1.2.48", release("v1.3"))).state, "available");
  assert.equal((await checkLatestRelease("1.2.48", release("v1.2.48"))).state, "current");
  assert.equal((await checkLatestRelease("1.2.100", release("v1.2.48"))).state, "ahead");
  assert.equal((await checkLatestRelease("1.2.48-preview", release("v1.2.48"))).state, "available");
});

test("distinguishes an unpublished release from invalid metadata", async () => {
  const result = await checkLatestRelease("1.2.48", async () => new Response(null, { status: 404 }));
  assert.equal(result.state, "unpublished");
  assert.equal((await checkLatestRelease("1.2.48", release("v1.2.49-rc.1", { prerelease: true }))).state, "unpublished");
  assert.equal((await checkLatestRelease("1.2.48", release("../invalid"))).ok, false);
  assert.equal((await checkLatestRelease("1.2.48", release("v1.2.49\n"))).ok, false);
  assert.equal((await checkLatestRelease("wrong", () => assert.fail("Unexpected request"))).ok, false);
});

test("returns a usable result for rate limits, upstream failures, and timeouts", async () => {
  const limited = await checkLatestRelease("1.2.48", async () => new Response(null, {
    status: 403, headers: { "x-ratelimit-remaining": "0" },
  }));
  assert.match(limited.error, /上限/);
  const unavailable = await checkLatestRelease("1.2.48", async () => new Response(null, { status: 503 }));
  assert.match(unavailable.error, /503/);
  const timedOut = await checkLatestRelease("1.2.48", async () => { throw new DOMException("", "TimeoutError"); });
  assert.match(timedOut.error, /超时/);
});
