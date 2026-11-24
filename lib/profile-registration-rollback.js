import path from "node:path";

export function isManagedProfileSpec(spec, profileDir, deployRoot) {
  if (typeof spec !== "string" || !/^(file|link):/.test(spec)) return false;
  const local = spec.slice(spec.indexOf(":") + 1);
  const relative = path.relative(deployRoot, path.resolve(profileDir, local));
  return relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

export function restoreProfileRegistration(pkg, ledger, profileDir, deployRoot) {
  const changes = [];
  for (const [name, current] of Object.entries(pkg.dependencies ?? {})) {
    if (!isManagedProfileSpec(current, profileDir, deployRoot)) continue;
    if (!Object.hasOwn(ledger.deps ?? {}, name) ||
        typeof ledger.bundles?.[name] !== "boolean") {
      // 台账丢失自愈：当前 spec 指向本产品部署根 ⇒ 该条目是本产品写的，按「原本不存在」处理
      // （卸载时移除依赖与 bundle 位）。抛错会让用户既装不上也卸不掉。
      changes.push({ name, previous: null, wasEnabled: (pkg.dsh?.profile?.bundles ?? []).includes(name) });
      continue;
    }
    const previous = ledger.deps[name];
    if (previous !== null && (typeof previous !== "string" ||
        isManagedProfileSpec(previous, profileDir, deployRoot))) {
      throw new Error("无法识别 " + name + " 的原始依赖，已保留当前配置。");
    }
    changes.push({ name, previous, wasEnabled: ledger.bundles[name] });
  }

  for (const { name, previous, wasEnabled } of changes) {
    if (previous === null) delete pkg.dependencies[name];
    else pkg.dependencies[name] = previous;

    if (wasEnabled) {
      pkg.dsh ??= {};
      pkg.dsh.profile ??= {};
      pkg.dsh.profile.bundles ??= [];
      if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
    } else if (Array.isArray(pkg.dsh?.profile?.bundles)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((bundle) => bundle !== name);
    }
  }
  return changes.length > 0;
}
