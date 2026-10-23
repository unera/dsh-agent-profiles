/**
 * defaults-i18n.test.mjs —— 「恢复默认」要按界面语言出厂（不需要浏览器）。
 *
 * ## 为什么默认内容是宿主的事
 * 出厂配置是中文字面量，住在 `lib/store.js`（`DEFAULT_PROFILES_ZH`）里，
 * 恢复默认与新建配置都是宿主写盘。客户端只说一句「当前界面语言是这个」，
 * 所以这里测的是宿主那一半：给 `lang` 就出那个语言的出厂内容，不给就是中文。
 *
 * ## 守的是什么
 *   1. 三种语言各有一套出厂配置，**字段结构完全一样**（只有文字不同）；
 *   2. ru / en 的出厂内容里没有 CJK 字符（漏翻的典型形态是留了中文）；
 *   3. 中文那一份**逐字没变** —— 老用户点恢复默认看到的还是原来的东西；
 *   4. 语言不认识（或老客户端不发 lang）→ 回落到中文，不是空、不是键名；
 *   5. 只影响「恢复默认 / 新建」，已经存在的配置正文一个字都不动。
 *
 * 用法：node test/defaults-i18n.test.mjs
 */

import {
  applyOp,
  defaultLang,
  defaultProfilesFor,
  defaultState,
  normalizeState,
} from "../lib/store.js";

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition === true) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff01-\uff60]/u;
const LANGS = ["zh", "en", "ru"];
/** 每套配置会进提示词的正文（顺序固定，用来比较结构）。 */
const CONTENT_FIELDS = ["name", "role", "personality", "speech", "rules"];

function content(profile) {
  return CONTENT_FIELDS.map((field) => profile[field] ?? "");
}

// ── ① 语言标签归一 ─────────────────────────────────────────
{
  eq("ru-RU → ru", defaultLang("ru-RU"), "ru");
  eq("RU → ru", defaultLang("RU"), "ru");
  eq("ru_RU → ru", defaultLang("ru_RU"), "ru");
  eq("en-GB → en", defaultLang("en-GB"), "en");
  eq("zh-Hans → zh", defaultLang("zh-Hans"), "zh");
  eq("不认识的语言 → zh（源语言、默认语言）", defaultLang("de-DE"), "zh");
  eq("空串 → zh", defaultLang(""), "zh");
  eq("undefined → zh（老客户端不发 lang）", defaultLang(undefined), "zh");
  eq("数字 → zh", defaultLang(42), "zh");
  eq("对象 → zh", defaultLang({ lang: "ru" }), "zh");
}

// ── ② 三种语言都有出厂配置，结构一致 ────────────────────────
{
  for (const lang of LANGS) {
    const profiles = defaultState(lang).profiles;
    eq(`${lang}：出厂有 3 套配置`, profiles.length, 3);
    check(
      `${lang}：每套都有非空的名称与正文`,
      profiles.every((profile) => content(profile).every((value) => value.trim() !== "")),
      JSON.stringify(profiles.map((profile) => content(profile).map((value) => value.trim() !== ""))),
    );
    check(
      `${lang}：图标与原版一致（🤖 / 🧑‍💻 / ✍️）`,
      profiles.map((profile) => profile.icon).join(",") === "🤖,🧑‍💻,✍️",
      profiles.map((profile) => profile.icon).join(","),
    );
  }

  const base = defaultState("zh").profiles;
  for (const lang of ["en", "ru"]) {
    const profiles = defaultState(lang).profiles;
    const shape = (list) => list.map((profile) => ({
      fields: Object.keys(profile).sort().join(","),
      contentFields: content(profile).length,
      ruleLines: String(profile.rules).split("\n").length,
      memories: profile.memories.length,
    }));
    eq(`${lang}：字段结构与中文版一致`, JSON.stringify(shape(profiles)), JSON.stringify(shape(base)));
    check(
      `${lang}：每套配置的正文条数（名称/角色/性格/说话/准则）与中文版一一对应`,
      profiles.every((profile, index) => content(profile).length === content(base[index]).length),
    );
  }
}

// ── ③ ru / en 的出厂内容里没有 CJK ──────────────────────────
{
  for (const lang of ["en", "ru"]) {
    const dirty = [];
    for (const profile of defaultState(lang).profiles) {
      for (const [field, value] of Object.entries(profile)) {
        if (typeof value !== "string") continue;
        if (CJK.test(value)) dirty.push(`${lang}.${field} = ${value.slice(0, 40)}`);
      }
    }
    check(`${lang} 出厂配置里没有中文`, dirty.length === 0, dirty.join(" | "));
  }
}

// ── ④ 中文那一份逐字没变（老用户看到的东西不变）──────────────
{
  const zh = defaultState("zh").profiles;
  eq("中文第一套名字", zh[0].name, "通用助手");
  eq("中文第二套名字", zh[1].name, "编程助手");
  eq("中文第三套名字", zh[2].name, "写作教练");
  check("中文第一套角色开头没变", zh[0].role.startsWith("你是一个通用型助手"), zh[0].role.slice(0, 30));
  check("中文第一套准则有 6 条", String(zh[0].rules).split("\n").length === 6);
  // ⚠ 只比正文：每次 normalizeState 都会给新的 id/时间戳，比整份对象是比错了东西。
  const zhText = JSON.stringify(zh.map(content));
  check("中文出厂内容与不带参数时完全一致", JSON.stringify(defaultState().profiles.map(content)) === zhText);
  check(
    "不认识的语言落到中文（不是空、不是键名）",
    JSON.stringify(defaultState("de-DE").profiles.map(content)) === zhText,
  );
  eq("defaultProfilesFor(不认识) 就是中文模板", defaultProfilesFor("de-DE"), defaultProfilesFor("zh"));
}

// ── ⑤ 恢复默认：语言跟着请求走 ──────────────────────────────
{
  const state = normalizeState({});
  const edited = applyOp(state, {
    op: "profile.update",
    id: state.profiles[0].id,
    patch: { name: "我的配置", role: "自定义角色", rules: "自定义准则" },
  });
  eq("自定义配置先写进去了", edited.ok, true);

  const restoredRu = applyOp(state, { op: "state.restoreDefaults", lang: "ru" });
  eq("ru 恢复默认成功", restoredRu.ok, true);
  eq("ru 恢复后有三套", state.profiles.length, 3);
  eq("ru 恢复后第一套是俄语名", state.profiles[0].name, "Универсальный помощник");
  check(
    "ru 恢复后整份内容没有中文",
    state.profiles.every((profile) => content(profile).every((value) => CJK.test(value) === false)),
    JSON.stringify(state.profiles.map((profile) => profile.name)),
  );
  check(
    "ru 恢复后不再有刚才的自定义文本",
    state.profiles.every((profile) => profile.name !== "我的配置" && profile.role !== "自定义角色"),
  );

  const restoredEn = applyOp(state, { op: "state.restoreDefaults", lang: "en-GB" });
  eq("en-GB 恢复默认成功", restoredEn.ok, true);
  eq("en 恢复后第一套是英文名", state.profiles[0].name, "General assistant");
  check(
    "en 恢复后整份内容没有中文",
    state.profiles.every((profile) => content(profile).every((value) => CJK.test(value) === false)),
  );

  // 老客户端：不发 lang ⇒ 行为与改造前逐字相同。
  const restoredLegacy = applyOp(state, { op: "state.restoreDefaults" });
  eq("不带 lang 的恢复默认仍然成功", restoredLegacy.ok, true);
  eq("不带 lang 恢复出来的是中文", state.profiles[0].name, "通用助手");
}

// ── ⑥ 新建配置的默认名跟着语言走，但不动别的 ────────────────
{
  for (const [lang, expected] of [["zh", "新配置 4"], ["en", "Profile 4"], ["ru", "Профиль 4"]]) {
    const state = defaultState(lang);
    const created = applyOp(state, { op: "profile.create", lang });
    eq(`${lang}：新建成功`, created.ok, true);
    eq(`${lang}：新建配置的默认名`, state.profiles[3].name, expected);
    eq(`${lang}：新建配置角色留空（用户自己填）`, state.profiles[3].role, "");
    check(
      `${lang}：三套出厂配置的正文没被新建动作改掉`,
      state.profiles.slice(0, 3).every((profile, index) => (
        JSON.stringify(content(profile)) === JSON.stringify(content(defaultState(lang).profiles[index]))
      )),
    );
  }
  // 客户端给了名字就用手给的，不被默认名覆盖。
  const state = defaultState("ru");
  applyOp(state, { op: "profile.create", lang: "ru", profile: { name: "Мой профиль" } });
  eq("显式给的名字优先于语言默认名", state.profiles[3].name, "Мой профиль");
}

// ── ⑦ 已存在的配置正文不会被语言影响 ────────────────────────
{
  // 从磁盘读回来的旧状态：内容是中英俄混排，也不该被「语言」改写。
  const loaded = normalizeState({
    profiles: [
      {
        name: "既有配置",
        role: "已有的角色设定",
        personality: "已有的性格",
        speech: "已有的说话习惯",
        rules: "已有的准则",
        memories: [{ text: "已有的记忆" }],
      },
    ],
  });
  const before = JSON.stringify(loaded.profiles);
  eq("读回来的状态不变", JSON.stringify(normalizeState({ profiles: loaded.profiles }).profiles), before);
  eq("读回来的状态里名字还是原来的", loaded.profiles[0].name, "既有配置");
  check("读回来的状态里记忆还在", loaded.profiles[0].memories.length === 1);
}

// ── 结果 ────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`\nOK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`\nFAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
