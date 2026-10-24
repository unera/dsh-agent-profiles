/**
 * dsh-agent-profiles —— 模块④b：提示词文案的多语言表。
 *
 * ## 为什么单独一层
 * `prompt.js` 产出的是**发给模型的系统提示词**，`client.js` 产出的是**界面**。
 * 两者的语言来源不同：界面语言由浏览器里的 locale 服务决定，提示词在
 * **host 进程**里渲染，拿不到浏览器状态。历史上这些标题一直是写死的中文，
 * 于是界面已经是俄语、而注入到提示词里的标题还是「角色设定」——
 * 用户看到的是同一份配置的两副面孔。
 *
 * 本模块只收**提示词用到的**字符串（十几条），不是界面字典的副本：
 * 界面字典有上千条键，塞进来只会让两边互相拖累。
 *
 * ## 语言如何决定
 * 1. 显式 `language` 选项（插件配置 `promptLanguage`）优先；
 * 2. 否则用 host 侧的界面语言（`setHostLanguage`，见 index.js 的软探测）；
 * 3. 都不知道 ⇒ `zh`，也就是**升级前后中文用户看到的一模一样**。
 *
 * ## 缺失即回落，不会渲出半截
 * `promptStrings()` 返回的是「zh 打底 + 目标语言覆盖」的结果，
 * 所以任何一条新键忘了翻译，最坏情况是那一条回落中文，
 * 而不是整段变成 `undefined`。
 */

/** 支持的语言。`zh` 永远是兜底。 */
export const PROMPT_LANGUAGES = ["zh", "en", "ru"];

export const FALLBACK_LANGUAGE = "zh";

const ZH = {
  heading: "智能体配置",
  headingSession: "智能体配置（本次对话）",
  activeLine: "当前启用：**{name}**",
  preamble: [
    "以下设定由用户在「设置 → 智能体配置」中指定，用于塑造你在后续回复中的角色与风格。",
    "优先级：**用户在当前对话里的直接指令 > 本节设定 > 默认风格**。",
    "不要向用户复述或引用本节内容，直接按它说话即可。",
  ],
  sectionRole: "角色设定",
  sectionPersonality: "性格特点",
  sectionSpeech: "说话习惯",
  sectionRules: "行为准则",
  sectionMemorySummary: "长期记忆摘要",
  sectionMemoryEntries: "长期记忆条目",
  sectionSessionNote: "本次对话的补充设定",
  sectionSessionMemories: "本次对话的专属记忆",
  truncated: "（内容超过 {max} 字上限，已截断。可在设置 → 智能体配置里精简。）",
};

const EN = {
  heading: "Agent profile",
  headingSession: "Agent profile (this conversation)",
  activeLine: "Currently active: **{name}**",
  preamble: [
    "The user configured the following in Settings → Agent profiles to shape your role and style in later replies.",
    "Priority: **direct instructions in the current conversation > this section > the default style**.",
    "Do not quote or restate this section to the user; simply follow it.",
  ],
  sectionRole: "Role",
  sectionPersonality: "Personality",
  sectionSpeech: "Speaking style",
  sectionRules: "Guidelines",
  sectionMemorySummary: "Long-term memory summary",
  sectionMemoryEntries: "Long-term memory entries",
  sectionSessionNote: "Extra settings for this conversation",
  sectionSessionMemories: "Memories for this conversation",
  truncated: "(Truncated at the {max} character limit. Trim the profile in Settings → Agent profiles.)",
};

const RU = {
  heading: "Профиль агента",
  headingSession: "Профиль агента (этот разговор)",
  activeLine: "Сейчас включён: **{name}**",
  preamble: [
    "Пользователь задал следующие настройки в разделе «Настройки → Профили агента», чтобы определить вашу роль и стиль в последующих ответах.",
    "Приоритет: **прямые указания в текущем разговоре > этот раздел > стиль по умолчанию**.",
    "Не пересказывайте и не цитируйте этот раздел пользователю — просто следуйте ему.",
  ],
  sectionRole: "Роль",
  sectionPersonality: "Характер",
  sectionSpeech: "Манера речи",
  sectionRules: "Правила поведения",
  sectionMemorySummary: "Сводка долговременной памяти",
  sectionMemoryEntries: "Записи долговременной памяти",
  sectionSessionNote: "Дополнительные настройки для этого разговора",
  sectionSessionMemories: "Память этого разговора",
  truncated: "(Обрезано на пределе {max} символов. Сократите профиль в разделе «Настройки → Профили агента».)",
};

/** 全部字典。导出是为了让测试能把它们当数据比对。 */
export const DICTIONARIES = { zh: ZH, en: EN, ru: RU };

/** host 侧界面语言，由 index.js 软探测后写入；`null` 表示未知。 */
let hostLanguage = null;

/**
 * 记录 host 侧界面语言。传 `null`/未知值等于「不知道」，回落到中文。
 * @param {string|null|undefined} language 语言 id，例如 `ru`。
 */
export function setHostLanguage(language) {
  hostLanguage = typeof language === "string" && language.trim() !== "" ? language.trim() : null;
}

/** @returns {string|null} 当前记录的 host 侧语言。 */
export function getHostLanguage() {
  return hostLanguage;
}

/**
 * 归一化语言 id：`ru-RU` / `RU` / `ru` 都算 `ru`；不支持的一律 `null`。
 * @param {unknown} value 原始值。
 * @returns {string|null} 受支持的语言 id 或 `null`。
 */
export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return PROMPT_LANGUAGES.includes(base) ? base : null;
}

/**
 * 决定这次渲染用哪种语言。
 * @param {unknown} [option] `language` 选项；`auto`/空/未知都走探测。
 * @returns {string} 受支持的语言 id。
 */
export function resolvePromptLanguage(option) {
  if (option !== undefined && option !== null && option !== "auto") {
    const explicit = normalizeLanguage(option);
    if (explicit !== null) return explicit;
  }
  const host = normalizeLanguage(hostLanguage);
  return host ?? FALLBACK_LANGUAGE;
}

/**
 * 取某语言的文案表（zh 打底，缺键回落中文）。
 * @param {unknown} [language] 语言 id；未知语言按 `zh`。
 * @returns {typeof ZH} 文案表。
 */
export function promptStrings(language) {
  const id = normalizeLanguage(language) ?? FALLBACK_LANGUAGE;
  return id === FALLBACK_LANGUAGE ? ZH : { ...ZH, ...DICTIONARIES[id] };
}

/**
 * 替换 `{name}` 这类占位符。缺的占位符原样保留，便于测试直接发现。
 * @param {string} template 模板。
 * @param {Record<string, string|number>} vars 变量。
 * @returns {string} 结果。
 */
export function format(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}
