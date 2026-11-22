import { isMap, isSeq, parseDocument } from "yaml";
import hostFs from "node:fs";
import { atomicFiles } from "./atomic-files.js";

const yamlOptions = {
  customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
};

export function removeProfileInsertText(source, pluginName) {
  const document = parseDocument(source, yamlOptions);
  if (document.errors.length) throw new Error("Cordis 配置无效，已保留原文件。");
  if (document.contents === null) return source;
  if (!isSeq(document.contents)) throw new Error("Cordis 配置不是序列，已保留原文件。");

  let changed = false;
  document.contents.items = document.contents.items.filter((entry) => {
    if (!isMap(entry)) return true;
    const insert = entry.get("insert", true);
    if (!isSeq(insert)) return true;
    const remaining = insert.items.filter((item) => {
      if (!isMap(item)) return true;
      const id = item.get("id");
      const name = item.get("name");
      return !((id === pluginName && (name === undefined || name === pluginName)) ||
        (id === pluginName + "-main" && name === pluginName) ||
        (id === undefined && name === pluginName));
    });
    if (remaining.length === insert.items.length) return true;
    changed = true;
    if (remaining.length === 0 && entry.items.length === 1) return false;
    insert.items = remaining;
    return true;
  });
  if (!changed) return source;

  const result = document.toString({ lineWidth: 0 });
  // Validate that removing the entry has not orphaned a retained alias.
  const verified = parseDocument(result, yamlOptions);
  if (verified.errors.length) throw new Error("无法安全更新 Cordis 配置，已保留原文件。");
  verified.toJS();
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return (source.startsWith("\uFEFF") ? "\uFEFF" : "") + result.replace(/\n/g, eol);
}

export function commitProfileChanges(changes, fs = hostFs, write = atomicFiles(fs).atomicWriteSync) {
  const verify = ({ file, before }) => {
    if (fs.readFileSync(file, "utf8") !== before) {
      throw new Error("profile 已在其他操作中改动，已保留当前文件：" + file);
    }
  };
  for (const change of changes) verify(change);

  const written = [];
  try {
    for (const change of changes) {
      verify(change);
      write(change.file, change.after);
      written.push(change);
    }
  } catch (error) {
    const failures = [error];
    for (const { file, before, after } of written.reverse()) {
      try {
        if (fs.readFileSync(file, "utf8") !== after) {
          throw new Error("未覆盖其他操作的新改动：" + file);
        }
        write(file, before);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, "profile 更新未能完整撤回");
    throw error;
  }
}
