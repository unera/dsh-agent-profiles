/**
 * prompt-i18n.test.mjs —— 提示词文案的多语言守门员。
 *
 * 为什么必须有：界面语言与提示词语言是**两条独立的路**。界面翻了、提示词没翻，
 * 表现是「设置页是俄语，而注入到模型里的标题还是中文」—— 肉眼在界面上看不出来，
 * 只有把渲染结果按语言逐个比对才能发现。
 *
 * 这里不测「翻译得好不好」（那是人的事），只测三件可证伪的事：
 *   1. 三本字典的键集合、占位符集合完全一致，且值非空；
 *   2. 换语言只换标签，**骨架**（小节数量、顺序、正文）一个字不动；
 *   3. 未知语言与缺键都回落中文，而不是渲染出 undefined。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DICTIONARIES,
  FALLBACK_LANGUAGE,
  PROMPT_LANGUAGES,
  format,
  normalizeLanguage,
  promptStrings,
  resolvePromptLanguage,
  setHostLanguage,
} from "../lib/prompt-i18n.js";
import { renderForSession, renderProfile, renderSessionExtras } from "../lib/prompt.js";

const PROFILE = {
  id: "p-1",
  name: "Кеша",
  icon: "🦜",
  role: "Роль",
  personality: "Характер",
  speech: "Речь",
  rules: "Правила",
  injectMemory: true,
  memorySummary: "Сводка",
  memories: [{ text: "факт один" }],
};

/**
 * 骨架：从第一处 `## 小节` 开始的正文，去掉标签行。
 *
 * 为什么从那里开始：标题行与前言是**文案**（各语言不同），
 * 小节正文是**用户数据**（各语言必须一模一样）。只比后者才能证明
 * 「换语言只换标签」。
 */
function skeleton(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## "));
  return lines
    .slice(start < 0 ? lines.length : start)
    .filter((line) => !line.startsWith("## "))
    .join("\n");
}

test("every language carries the same keys and no empty value", () => {
  const keys = Object.keys(DICTIONARIES[FALLBACK_LANGUAGE]).sort();
  for (const language of PROMPT_LANGUAGES) {
    const dict = DICTIONARIES[language];
    assert.deepEqual(Object.keys(dict).sort(), keys, `key set differs for ${language}`);
    for (const [key, value] of Object.entries(dict)) {
      if (Array.isArray(value)) {
        assert.equal(value.length, 3, `${language}.${key} must keep three preamble lines`);
        for (const line of value) assert.ok(line.trim() !== "", `${language}.${key} has an empty line`);
      } else {
        assert.ok(typeof value === "string" && value.trim() !== "", `${language}.${key} is empty`);
      }
    }
  }
});

test("placeholders match across languages", () => {
  const placeholders = (value) =>
    Array.isArray(value)
      ? value.flatMap((line) => [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
      : [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const keys = Object.keys(DICTIONARIES[FALLBACK_LANGUAGE]);
  for (const key of keys) {
    const expected = placeholders(DICTIONARIES[FALLBACK_LANGUAGE][key]).sort();
    for (const language of PROMPT_LANGUAGES) {
      assert.deepEqual(placeholders(DICTIONARIES[language][key]).sort(), expected, `${language}.${key} placeholders differ`);
    }
  }
});

test("translated dictionaries carry no leftover Chinese", () => {
  const cjk = /[\u4e00-\u9fff]/;
  for (const language of PROMPT_LANGUAGES) {
    if (language === FALLBACK_LANGUAGE) continue;
    const flat = JSON.stringify(DICTIONARIES[language]);
    assert.equal(cjk.test(flat), false, `${language} dictionary still contains Chinese`);
  }
});

test("switching language changes labels only, never the skeleton", () => {
  const skeletons = PROMPT_LANGUAGES.map((language) => skeleton(renderProfile(PROFILE, { language })));
  for (const value of skeletons) assert.equal(value, skeletons[0]);
  const headings = PROMPT_LANGUAGES.map((language) => renderProfile(PROFILE, { language }).split("\n").filter((l) => l.startsWith("#")).length);
  assert.deepEqual(headings, [headings[0], headings[0], headings[0]]);
});

test("russian render uses russian labels end to end", () => {
  const text = renderProfile(PROFILE, { language: "ru" });
  const t = promptStrings("ru");
  assert.ok(text.startsWith(`# ${t.heading}`));
  for (const label of [t.sectionRole, t.sectionPersonality, t.sectionSpeech, t.sectionRules, t.sectionMemorySummary, t.sectionMemoryEntries]) {
    assert.ok(text.includes(`## ${label}`), `missing section ${label}`);
  }
  assert.equal(/[\u4e00-\u9fff]/.test(text), false);
});

test("an empty profile still renders nothing in any language", () => {
  for (const language of PROMPT_LANGUAGES) {
    assert.equal(renderProfile({ name: "Пусто", icon: "🦜" }, { language }), "");
  }
});

test("a profile with only a role renders only that section", () => {
  for (const language of PROMPT_LANGUAGES) {
    const text = renderProfile({ name: "N", role: "R" }, { language });
    const sections = text.split("\n").filter((line) => line.startsWith("## "));
    assert.deepEqual(sections, [`## ${promptStrings(language).sectionRole}`]);
  }
});

test("the truncation notice is localized", () => {
  const long = { ...PROFILE, role: "я".repeat(400) };
  for (const language of PROMPT_LANGUAGES) {
    const text = renderProfile(long, { language, maxChars: 100 });
    assert.ok(text.includes(format(promptStrings(language).truncated, { max: 100 })), `no localized notice for ${language}`);
  }
});

test("session extras are localized", () => {
  const session = { note: "заметка", memories: [{ text: "факт" }] };
  for (const language of PROMPT_LANGUAGES) {
    const text = renderSessionExtras(session, { language });
    const t = promptStrings(language);
    assert.ok(text.includes(`## ${t.sectionSessionNote}`));
    assert.ok(text.includes(`## ${t.sectionSessionMemories}`));
  }
});

test("an empty profile with session extras still gets a localized head", () => {
  const store = {
    effective: () => ({ profile: null, session: { note: "x", memories: [] } }),
  };
  for (const language of PROMPT_LANGUAGES) {
    const text = renderForSession(store, "s-1", { language });
    assert.ok(text.startsWith(`# ${promptStrings(language).headingSession}`));
  }
});

test("language resolution: explicit, host, unknown", () => {
  setHostLanguage(null);
  assert.equal(resolvePromptLanguage("ru"), "ru");
  assert.equal(resolvePromptLanguage("ru-RU"), "ru");
  assert.equal(resolvePromptLanguage("de"), FALLBACK_LANGUAGE);
  assert.equal(resolvePromptLanguage(undefined), FALLBACK_LANGUAGE);
  assert.equal(resolvePromptLanguage("auto"), FALLBACK_LANGUAGE);
  setHostLanguage("ru");
  assert.equal(resolvePromptLanguage("auto"), "ru");
  assert.equal(resolvePromptLanguage(undefined), "ru");
  assert.equal(resolvePromptLanguage("en"), "en");
  setHostLanguage("de");
  assert.equal(resolvePromptLanguage("auto"), FALLBACK_LANGUAGE);
  setHostLanguage(null);
});

test("normalizeLanguage accepts case and region suffixes only for known languages", () => {
  assert.equal(normalizeLanguage(" RU "), "ru");
  assert.equal(normalizeLanguage("en-GB"), "en");
  assert.equal(normalizeLanguage("zh-Hans"), "zh");
  assert.equal(normalizeLanguage("fr"), null);
  assert.equal(normalizeLanguage(42), null);
});

test("promptStrings falls back to Chinese per key, not wholesale", () => {
  const partial = promptStrings("ru");
  assert.equal(partial.heading, DICTIONARIES.ru.heading);
  const unknown = promptStrings("xx");
  assert.equal(unknown.heading, DICTIONARIES[FALLBACK_LANGUAGE].heading);
});
