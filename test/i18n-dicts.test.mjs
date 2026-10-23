/**
 * i18n-dicts.test.mjs —— 词条表的**守门员**（不需要浏览器、不需要 react）。
 *
 * ## 为什么单独一个文件
 * 渲染测试能证明「这页渲染出来了」，但证明不了「有没有一条漏译」：
 * 漏译的表现是**回落中文**，而中文页刚好是默认 —— 肉眼看不出，
 * 渲染断言也不会红。所以词条表本身必须被当成数据来测：
 *
 *   1. 三本字典的键集合完全一致，且每个值非空
 *      （报错写明 `missing ru: xxx` / `empty en: xxx`，不是「渲染失败」）；
 *   2. ru / en 里没有一个 CJK 字符（漏翻的典型形态是直接留了中文）；
 *   3. 占位符（N / NAME / COUNT / MEM …）在各语言里集合一致 ——
 *      翻译时漏掉 `NAME`，删除确认就会变成「Удалить профиль «»?」；
 *   4. 反向：代码里 `tt("key")` 用到的键必须都在字典里；
 *   5. 客户端源码里**没有绕过词条的 CJK 字面量**（注释、字典本体、
 *      `tt(key, fallback)` 的第二参数除外）。
 *
 * 字典直接从 lib/client.js 里**取出来求值**：不是另抄一份，也不是正则数键名 ——
 * 抄一份就迟早跟源码分叉，正则数键名则验不到值。
 *
 * 用法：node test/i18n-dicts.test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { srcDir } from "./_harness.mjs";

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition === true) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

const clientFile = path.join(srcDir, "client.js");
const source = fs.readFileSync(clientFile, "utf8");
const lines = source.split("\n");

/** CJK 及其标点：漏译最常见的形态就是这里还留着中文。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff01-\uff60]/u;
/** 词条里的占位符（fill() 用裸名字替换，不是 `{name}`）。 */
const TOKEN = /(?<![A-Za-z0-9_])(N|M|NAME|COUNT|MEM|SESSIONS|SMEM|SN|GN|EMPTY|AT)(?![A-Za-z0-9_])/gu;

/**
 * 从源码里取出一段对象字面量并求值。
 * 括号配对要跳过字符串，否则值里的 `}` 会把范围截断。
 */
function extractObject(name) {
  const marker = `var ${name} = {`;
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`源码里找不到 ${name}`);
  const start = source.indexOf("{", at);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (escaped === true) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const text = source.slice(start, i + 1);
        return {
          dict: vm.runInNewContext(`(${text})`),
          startLine: source.slice(0, start).split("\n").length,
          endLine: source.slice(0, i + 1).split("\n").length,
        };
      }
    }
  }
  throw new Error(`${name} 的花括号没闭合`);
}

const zh = extractObject("DICT_ZH");
const en = extractObject("DICT_EN");
const ru = extractObject("DICT_RU");
const LANGS = { zh: zh.dict, en: en.dict, ru: ru.dict };

console.log(`字典规模：zh ${Object.keys(zh.dict).length} / en ${Object.keys(en.dict).length} / ru ${Object.keys(ru.dict).length} 个键`);

// ── ① 键集合一致 + 值非空 ───────────────────────────────────
{
  const zhKeys = Object.keys(zh.dict);
  eq("词典是同一批键（en 没有多也没有少）", Object.keys(en.dict).sort().join(","), zhKeys.slice().sort().join(","));
  eq("词典是同一批键（ru 没有多也没有少）", Object.keys(ru.dict).sort().join(","), zhKeys.slice().sort().join(","));

  const missing = [];
  for (const lang of ["zh", "en", "ru"]) {
    for (const key of zhKeys) {
      const value = LANGS[lang][key];
      if (value === undefined) missing.push(`missing ${lang}: ${key}`);
      else if (typeof value !== "string") missing.push(`not a string ${lang}: ${key}`);
      else if (value.trim() === "") missing.push(`empty ${lang}: ${key}`);
    }
  }
  check(`三个语言的 ${zhKeys.length} 个键都有非空译文`, missing.length === 0, missing.slice(0, 12).join(" | "));
}

// ── ② ru / en 里不许有 CJK ───────────────────────────────────
for (const lang of ["en", "ru"]) {
  const dirty = Object.entries(LANGS[lang])
    .filter(([, value]) => CJK.test(value))
    .map(([key, value]) => `${lang}.${key} = ${value.slice(0, 40)}`);
  check(`${lang} 词条里没有 CJK 字符`, dirty.length === 0, dirty.slice(0, 8).join(" | "));
}

// ── ③ 占位符集合一致 ────────────────────────────────────────
{
  const bad = [];
  for (const key of Object.keys(zh.dict)) {
    const sets = {};
    for (const lang of ["zh", "en", "ru"]) {
      const found = String(LANGS[lang][key]).match(TOKEN) ?? [];
      sets[lang] = [...new Set(found.map((token) => token.toUpperCase()))].sort().join("+");
    }
    if (sets.zh !== sets.en || sets.zh !== sets.ru) {
      bad.push(`${key}: zh[${sets.zh}] en[${sets.en}] ru[${sets.ru}]`);
    }
  }
  check("每个键的占位符集合在三种语言里一致", bad.length === 0, bad.slice(0, 8).join(" | "));
}

/**
 * 把注释换成空格（长度不变，偏移量就对得上），后面判「这行代码里 tt( 在哪」用。
 * 字符串原样保留 —— 我们只想去掉注释里的中文，不是字符串里的。
 */
function stripComments(text) {
  let out = "";
  let quote = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "\n") {
      inLine = false;
      out += ch;
      continue;
    }
    if (inLine === true) {
      out += " ";
      continue;
    }
    if (inBlock === true) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        out += "  ";
        i += 1;
        continue;
      }
      out += " ";
      continue;
    }
    if (quote === true) {
      out += ch;
      if (escaped === true) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      out += "  ";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      i += 1;
      continue;
    }
    if (ch === '"') quote = true;
    out += ch;
  }
  return out;
}

/**
 * 这个字面量是否「经过了本地化」：
 *   - `tt("key", "<中文兜底>")` 的第二参数（可以跨行）；
 *   - `diag("<中文标签>", …)` —— 诊断标签进的是宿主日志，不是界面。
 */
function isLocalized(code, start) {
  const before = code.slice(0, start);
  const ttAt = before.lastIndexOf("tt(");
  const diagAt = before.lastIndexOf("diag(");
  if (diagAt > ttAt) {
    // diag 的标签是第一个参数：前面只有 ( 和空白
    return /^\s*$/u.test(before.slice(diagAt + 5));
  }
  if (ttAt === -1) return false;
  const between = before.slice(ttAt + 3);
  return /^\s*"(?:[^"\\]|\\.)*"\s*,\s*$/u.test(between);
}

/** 双引号字符串字面量（跳过注释里的内容）。 */
function scanLiterals(text) {
  const stripped = stripComments(text);
  const found = [];
  for (let i = 0; i < stripped.length; i += 1) {
    if (stripped[i] !== '"') continue;
    let end = i + 1;
    for (; end < stripped.length; end += 1) {
      if (stripped[end] === "\\") {
        end += 1;
        continue;
      }
      if (stripped[end] === '"') break;
      if (stripped[end] === "\n") break;
    }
    found.push({ value: text.slice(i + 1, Math.min(end, text.length)), start: i });
    i = end;
  }
  return found;
}

const CODE = stripComments(source);

/** 从 `at` 处的开括号扫到配对的闭括号（跳过字符串），返回结束偏移。 */
function matchBracket(text, at, open, close) {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let i = at; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === true) {
      if (escaped === true) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/**
 * 诊断通道的豁免范围：`diag(…)` 的整段实参，以及 `reportHeadDom()` 的函数体。
 *
 * 为什么这类中文可以留：它们进的是**宿主日志**（客户端控制台收不到），
 * 不是界面文案 —— 本地化它们只会让排错变难。豁免是**按名字列出来的**，
 * 所以新写的界面代码不会顺带被放过。
 */
const DIAG_SPANS = (() => {
  const spans = [];
  for (const match of CODE.matchAll(/\bdiag\(/gu)) {
    const open = match.index + match[0].length - 1;
    spans.push([open, matchBracket(CODE, open, "(", ")")]);
  }
  for (const match of CODE.matchAll(/\blogger\??\.(?:error|warn|info|debug)\??\.\(/gu)) {
    const open = match.index + match[0].length - 1;
    spans.push([open, matchBracket(CODE, open, "(", ")")]);
  }
  // 这两个函数**专门用来拼诊断字符串**（返回值只进 diag 或 logger），不是界面文案。
  for (const fn of ["reportHeadDom", "describeEntries"]) {
    const head = CODE.indexOf(`function ${fn}(`) !== -1
      ? CODE.indexOf(`function ${fn}(`)
      : CODE.indexOf(`${fn} = function (`);
    if (head !== -1) {
      const open = CODE.indexOf("{", head);
      spans.push([head, matchBracket(CODE, open, "{", "}")]);
    }
  }
  return spans;
})();

// ── ④ 源码里没有绕过词条的 CJK 字面量 ────────────────────────
{
  const dictRanges = [zh, en, ru].map((entry) => [entry.startLine, entry.endLine]);
  const lineOf = (offset) => source.slice(0, offset).split("\n").length;
  const offenders = [];
  for (const literal of scanLiterals(source)) {
    if (CJK.test(literal.value) === false) continue;
    const lineNo = lineOf(literal.start);
    if (dictRanges.some(([a, b]) => lineNo >= a && lineNo <= b)) continue;
    if (isLocalized(CODE, literal.start) === true) continue;
    if (DIAG_SPANS.some(([a, b]) => literal.start >= a && literal.start <= b)) continue;
    offenders.push(`${path.basename(clientFile)}:${lineNo}: "${literal.value.slice(0, 40)}"`);
  }
  check("客户端源码里没有绕过 tt() 的中文字面量", offenders.length === 0, offenders.slice(0, 10).join(" | "));
}

// ── ⑤ 反向：代码里用到的键都必须在字典里 ─────────────────────
{
  const used = new Set();
  for (const match of source.matchAll(/tt\(\s*"([A-Za-z][\w.]*)"/gu)) used.add(match[1]);
  for (const match of source.matchAll(/(?:labelKey|roleKey):\s*"([A-Za-z][\w.]*)"/gu)) used.add(match[1]);
  const missing = [];
  for (const key of used) {
    for (const lang of ["zh", "en", "ru"]) {
      if (typeof LANGS[lang][key] !== "string") missing.push(`used in code but missing in ${lang}: ${key}`);
    }
  }
  check(`代码里用到的 ${used.size} 个键都在三本字典里`, missing.length === 0, missing.slice(0, 12).join(" | "));
}

// ── ⑥ 俄语确实被接上了宿主 ───────────────────────────────────
{
  check(
    "三种语言一次注册给 locale 服务",
    source.includes('ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN, ru: DICT_RU })'),
  );
  check(
    "ru 通过 addLanguage 进入宿主语言目录（否则选不中）",
    /ctx\.locale\.addLanguage\(\{ id: "ru", label: "[^"]+", fallback: "en" \}\)/u.test(source),
    "源码里没有 addLanguage({ id: \"ru\" … })",
  );
  check("没有模板字符串（本文件的红线之一）", source.split("\n").every((line) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return true;
    return code.includes("`") === false;
  }), "有一行代码里出现了反引号");
}

// ── 结果 ────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`\nOK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`\nFAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);

function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
