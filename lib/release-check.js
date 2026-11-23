const RELEASES_URL = "https://github.com/pugyy/dxkjailbreak/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/pugyy/dxkjailbreak/releases/latest";
const VERSION = /^v?((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function versionParts(value) {
  if (typeof value !== "string" || value.length > 100) return null;
  const match = VERSION.exec(value);
  if (match?.[0] !== value) return null;
  const [major, minor, patch = "0"] = match[1].split(".");
  return { numbers: [major, minor, patch].map(BigInt), prerelease: Boolean(match[2]) };
}

function compareVersions(current, latest) {
  for (let index = 0; index < current.numbers.length; index++) {
    if (current.numbers[index] !== latest.numbers[index]) {
      return current.numbers[index] < latest.numbers[index] ? "available" : "ahead";
    }
  }
  return current.prerelease ? "available" : "current";
}

export async function checkLatestRelease(currentVersion, fetchRelease = globalThis.fetch) {
  const current = versionParts(currentVersion);
  if (!current) return { ok: false, error: "无法识别当前安装的插件版本。" };

  try {
    const response = await fetchRelease(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "dxkjailbreak" },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) {
      return { ok: true, state: "unpublished", currentVersion };
    }
    if (response.status === 429 ||
        (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
      return { ok: false, error: "GitHub 请求次数已达上限，请稍后再试。" };
    }
    if (!response.ok) {
      return { ok: false, error: "GitHub 暂时无法提供发行信息（HTTP " + response.status + "）。" };
    }

    const release = await response.json();
    const latestTag = release?.tag_name;
    if (release?.draft || release?.prerelease) {
      return { ok: true, state: "unpublished", currentVersion };
    }
    const latest = versionParts(latestTag);
    if (!latest || latest.prerelease) {
      return { ok: false, error: "GitHub 返回了无法识别的正式发行版本。" };
    }

    return {
      ok: true,
      state: compareVersions(current, latest),
      currentVersion,
      latestTag,
      releaseUrl: RELEASES_URL + "/tag/" + encodeURIComponent(latestTag),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "TimeoutError"
        ? "连接 GitHub 超时，请重试。"
        : "无法读取 GitHub 的发行信息，请检查网络后重试。",
    };
  }
}
