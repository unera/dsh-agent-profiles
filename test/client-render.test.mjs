/**
 * 客户端渲染自测：把 lib/client.js **真的跑起来**，看设置页到底渲染出了什么。
 *
 * ## 为什么需要它
 * 「设置页空白」有几种在界面上长得一模一样的成因：
 *   (a) 组件渲染时抛错 —— 官方机制的后果是**整个插槽条目被清空**；
 *   (b) 组件正常返回，但树是空的（子元素被丢掉、条件分支走了空值）；
 *   (c) 组件卡在「读取中」。
 * 肉眼看不出区别，猜更不行。这个文件是当时定位 (b) 的工具，现在留着防回归。
 *
 * ## 怎么做到不装 React DOM
 * 本机 app 目录里有 react 18.3.1，但**没有 react-dom**，用不了 renderToStaticMarkup。
 * 这里接管 React 18 的 hook 派发器
 * （`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher`）
 * 自己实现 useState/useEffect/useRef，并写了一个极简渲染器：
 * 函数组件过派发器、class 组件实例化后调 render、Fragment 展开、
 * 渲染期抛错走 getDerivedStateFromError。够用来判断「有没有东西、抛没抛错」。
 *
 * 用法：node test/client-render.test.mjs
 */

import fs, { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * 官方 Host 程序目录（`<安装根>/resources/app`）—— 本测试从那里借真的 react。
 *
 * 解析顺序（**不写死本机路径**）：
 *   1. `DSH_APP_DIR` —— 直接给 `<安装根>/resources/app`（最明确）
 *   2. `DSH_INSTALL_DIR` —— 给 `<安装根>`，自动补 `resources/app`
 *   3. 由 `process.execPath` 反推（Electron 跑本文件时就是 DSH 主程序自身）
 *   4. 常见默认安装位置
 *
 * 四步都落空 → 打印一句说明并**以退出码 2 失败**（不静默跳过）。
 */
function resolveAppDir() {
  const explicit = process.env.DSH_APP_DIR;
  if (typeof explicit === "string" && explicit.trim() !== "") return path.resolve(explicit.trim());

  const installDir = process.env.DSH_INSTALL_DIR;
  if (typeof installDir === "string" && installDir.trim() !== "") {
    return path.join(path.resolve(installDir.trim()), "resources", "app");
  }

  const exeDir = path.dirname(path.resolve(process.execPath));
  for (const candidate of [
    path.join(exeDir, "resources", "app"),
    path.join(exeDir, "..", "resources", "app"),
  ]) {
    if (fs.existsSync(path.join(candidate, "index.js"))) return candidate;
  }

  for (const candidate of [
    "C:/Program Files/DSH Desktop/resources/app",
    "C:/Program Files (x86)/DSH Desktop/resources/app",
  ]) {
    if (fs.existsSync(path.join(candidate, "index.js"))) return candidate;
  }

  console.error(
    [
      "找不到官方 Host 程序目录（<安装根>/resources/app），本测试无法运行。",
      "请显式指定后重跑，例如：",
      '  $env:DSH_APP_DIR = "D:/Apps/DSH Desktop/resources/app"',
      "（或在 DSH 里跑：$env:ELECTRON_RUN_AS_NODE=1; & \"<安装根>/DSH Desktop.exe\" test/client-render.test.mjs）",
    ].join("\n"),
  );
  process.exit(2);
}

const APP_DIR = resolveAppDir();
const appRequire = createRequire(path.join(APP_DIR, "index.js"));
const React = appRequire("react");

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

// ── 浏览器环境替身 ──────────────────────────────────────────
globalThis.window = { __ModuleLoader__: null };
const styleEls = [];
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "", remove() {} }),
  head: { appendChild: (el) => styleEls.push(el) },
  body: { appendChild() {}, removeChild() {} },
};

/** 当前场景要用的 fetch；每个场景自己设置。 */
let currentFetch = () => Promise.reject(new Error("fetch not stubbed"));
/**
 * 客户端诊断上报的记录。
 *
 * 为什么拦它：这条通道是我在**真实环境**里唯一的排查手段
 * （客户端 console 进不了宿主日志），所以它自己也得被测。
 */
let diagCalls = [];
/**
 * 真字典 + 当前语言。
 *
 * 为什么要收下来：原来 `locale.register` 是空实现、`bind` 直接 `return key`，
 * 于是所有断言看到的都是 `tt()` 的**中文兜底**（`fallbackOf` → DICT_ZH）——
 * 也就是说这套测试**从来没验过英文界面**。收下插件真正 register 的字典、
 * 再把 `bind` 接到它上面，中英文两条路才都能渲染出来验。
 * 默认仍是 `zh`，所以前面所有场景看到的文字与改造前**逐字相同**。
 */
const localeDicts = {};
let activeLocale = "zh";
/** 宿主语言目录（真的 locale 服务里有 zh / en；ru 由插件 addLanguage 加进来）。 */
const languageCatalog = [
  { id: "zh", label: "中文", fallback: "en" },
  { id: "en", label: "English", fallback: undefined },
];
let addedLanguages = [];
/** 当前语言在真服务里的回退链：active → … → en；目录里没有它时只有它自己。 */
function localeChain(active) {
  const chain = [];
  let current = languageCatalog.find((entry) => entry.id === active);
  while (current !== undefined && chain.includes(current.id) === false) {
    chain.push(current.id);
    const fallback = current.fallback;
    current = fallback === undefined ? undefined : languageCatalog.find((entry) => entry.id === fallback);
  }
  if (chain.length === 0) chain.push(active);
  return chain;
}
globalThis.fetch = (...args) => {
  const url = String(args[0] ?? "");
  if (url.includes("/__ap/diag")) {
    try {
      diagCalls.push(JSON.parse(args[1].body));
    } catch {
      /* 记不下来就算了 */
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
  }
  return currentFetch(...args);
};

// ── hook 派发器 ─────────────────────────────────────────────
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const dispatcherSlot = internals.ReactCurrentDispatcher;

function createHookStore() {
  const cells = [];
  const effects = [];
  let index = 0;

  const dispatcher = {
    useState(initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial;
      return [
        cells[i],
        (value) => {
          cells[i] = typeof value === "function" ? value(cells[i]) : value;
        },
      ];
    },
    useRef(initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = { current: initial };
      return cells[i];
    },
    useEffect(fn, deps) {
      const i = index++;
      const prev = effects[i];
      const changed =
        prev === undefined ||
        deps === undefined ||
        prev.deps === undefined ||
        deps.length !== prev.deps.length ||
        deps.some((d, k) => d !== prev.deps[k]);
      if (changed) {
        try {
          prev?.cleanup?.();
        } catch {
          /* 清理报错不影响渲染 */
        }
        const cleanup = fn();
        effects[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined, fn };
      }
    },
    useLayoutEffect(fn, deps) {
      this.useEffect(fn, deps);
    },
    useMemo(fn) {
      index += 1;
      return fn();
    },
    useCallback(fn) {
      index += 1;
      return fn;
    },
    useReducer(reducer, initial) {
      const i = index++;
      if (!(i in cells)) cells[i] = initial;
      return [cells[i], (action) => { cells[i] = reducer(cells[i], action); }];
    },
    useContext() {
      index += 1;
      return undefined;
    },
    useDebugValue() {},
    useDeferredValue(value) {
      index += 1;
      return value;
    },
    useTransition() {
      index += 1;
      return [false, (fn) => fn()];
    },
    useId() {
      index += 1;
      return ":r0:";
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      index += 1;
      return getSnapshot();
    },
    useInsertionEffect() {},
    useImperativeHandle() {},
  };

  return { begin() { index = 0; }, dispatcher };
}

const instanceStores = new WeakMap();
function callComponent(component, props) {
  let store = instanceStores.get(component);
  if (store === undefined) {
    store = createHookStore();
    instanceStores.set(component, store);
  }
  store.begin();
  dispatcherSlot.current = store.dispatcher;
  try {
    return { ok: true, tree: component(props) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    dispatcherSlot.current = null;
  }
}

function isElement(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.props !== undefined &&
    // ⚠ React.Fragment 的 type 是 **Symbol**，只认 string|function 会把
    //   所有 <Fragment> 判成「不可渲染」，于是又得出「界面是空的」这个错误结论。
    (typeof value.type === "string" || typeof value.type === "function" || typeof value.type === "symbol")
  );
}
function isClassComponent(type) {
  return typeof type === "function" && type.prototype !== undefined && typeof type.prototype.render === "function";
}

/**
 * 极简渲染器。**必须递归**：槽位条目现在是「包装组件 → 错误边界 → 内容」三层，
 * 只看最外层会以为页面是空的 —— 那正是当初漏掉 bug 的原因。
 */
function walk(node, depth, acc) {
  if (node === null || node === undefined || typeof node === "boolean") return acc;
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node);
    acc.textLength += text.length;
    // ⚠ **不要截断**：断言要在这个字符串上做 includes，
    //   截断会让「内容明明在、断言却说没有」——那是测试在骗自己。
    //   打印的时候另外用 .slice() 收窄。
    if (text.trim() !== "" && acc.lines.length < 20000) {
      acc.lines.push(`${"  ".repeat(depth)}"${text}"`);
    }
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, depth, acc);
    return acc;
  }
  if (!isElement(node)) {
    acc.lines.push(`${"  ".repeat(depth)}?unrenderable:${typeof node}`);
    return acc;
  }

  const type = node.type;
  if (type === React.Fragment) {
    walk(node.props.children, depth, acc);
    return acc;
  }

  if (isClassComponent(type)) {
    const instance = new type(node.props);
    instance.props = node.props;
    if (instance.state === undefined) instance.state = {};
    // ⚠ try 必须连**子树的渲染**一起包住：React 里子组件的抛错是在
    //   父组件的协调过程中冒上来的，只包住 instance.render() 什么也接不到。
    const mark = acc.lines.length;
    try {
      const out = instance.render();
      walk(out, depth, acc);
    } catch (error) {
      const derived =
        typeof type.getDerivedStateFromError === "function" ? type.getDerivedStateFromError(error) : null;
      if (derived === null) throw error;
      acc.lines.length = mark; // 丢掉失败那一趟的半截输出
      instance.state = { ...instance.state, ...derived };
      acc.boundaryCaught = String(error && error.message);
      // 忠实模拟 React：边界捕获后也要调 componentDidCatch（我靠它把错误报给宿主日志）
      try {
        if (typeof instance.componentDidCatch === "function") {
          instance.componentDidCatch(error, { componentStack: "" });
        }
      } catch {
        /* 边界自己的上报失败不影响兜底渲染 */
      }
      walk(instance.render(), depth, acc);
    }
    return acc;
  }

  if (typeof type === "function") {
    const result = callComponent(type, node.props);
    if (result.ok !== true) throw result.error;
    walk(result.tree, depth, acc);
    return acc;
  }

  // ⚠ 打印**全部** class，不是只取第一个：
  //   只取第一个会让 `.ap-avatar-fallback`、`.ap-item-sel` 这类
  //   「靠第二个 class 表达状态」的元素在断言里永远看不见。
  const cls =
    node.props.className !== undefined
      ? "." + String(node.props.className).trim().split(/\s+/).join(".")
      : "";
  const extra = [];
  if (node.props.role !== undefined) extra.push(`role=${node.props.role}`);
  if (node.props["aria-checked"] !== undefined) extra.push(`aria-checked=${node.props["aria-checked"]}`);
  if (node.props.type !== undefined) extra.push(`type=${node.props.type}`);
  // data-ap / data-icon 打进轮廓里：「按钮顺序」这类断言只能看文档顺序，
  // 而按钮上的文字是字形，认不出是谁。
  if (node.props["data-ap"] !== undefined) extra.push(`ap=${node.props["data-ap"]}`);
  if (node.props["data-icon"] !== undefined) extra.push(`icon=${node.props["data-icon"]}`);
  if (node.props["data-arrow-direction"] !== undefined) extra.push(`arrow=${node.props["data-arrow-direction"]}`);
  // ⚠ 把 value 也打出来：断言「编辑区里是哪套配置」只能看控件里的值。
  //   用「页面上出现过某段文字」去断言会被左栏的摘要文案骗到 ——
  //   左栏每一条都带角色设定摘要，于是任何角色文本都能在列表里命中。
  if (typeof node.props.value === "string" && node.props.value !== "") {
    extra.push(`value="${node.props.value.slice(0, 40)}"`);
  }
  // src 也打出来：断言「显示的是图片还是回落图标」只能看这个。
  if (typeof node.props.src === "string" && node.props.src !== "") {
    extra.push(`src="${node.props.src.slice(0, 34)}…"`);
  }
  acc.lines.push(`${"  ".repeat(depth)}<${type}${cls}${extra.length > 0 ? ` ${extra.join(" ")}` : ""}>`);
  acc.types.push(type);
  if (typeof acc.match === "function" && acc.match(node.props) === true) acc.matched.push(node.props);
  walk(node.props.children, depth + 1, acc);
  return acc;
}

function outline(node, match) {
  const acc = { lines: [], textLength: 0, types: [], boundaryCaught: null, matched: [], match };
  try {
    walk(node, 0, acc);
  } catch (error) {
    acc.threw = error;
  }
  acc.flat = acc.lines.join("\n");
  return acc;
}

/**
 * 渲染到满足条件为止（或超时）。
 *
 * 为什么不能只 sleep 一个固定时长：`refresh()` 是「fetch → json → setCache →
 * 通知订阅者 → 重渲染」的一条异步链，链上有几跳取决于实现，
 * 用固定 sleep 猜时机就是在测试里赌时序 —— 赌输了会得到
 * 「产品明明是好的、测试却说空白」这种最浪费时间的失败。
 */
async function renderUntil(component, predicate, timeoutMs = 1500, props = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = outline(callComponent(component, props).tree);
  while (!predicate(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = outline(callComponent(component, props).tree);
  }
  return last;
}

// ── 装载客户端模块（每个场景一份全新实例）────────────────────
let loadCount = 0;

/**
 * 每次都用带随机 query 的 import 拿一个**全新模块实例**：
 * 客户端把状态缓存在模块级变量里（一份缓存 + 订阅者集合），
 * 复用同一个实例会让第二个场景读到第一个场景的错误缓存 ——
 * 那验的就不是产品代码，而是测试自己的脏状态。
 */
/**
 * 假的「官方 turn-process 渲染器」。用它来验「顶替 = 包一层」这条路：
 * 我的组件必须把它**原样渲染出来**，而不是自己重写那一行。
 *
 * ⚠ 它**像真官方一样要求 `t`**：真组件第一句就是 `t("message.turnProcess.took")`，
 *   而 `t` 是宿主按注册选项里的 `locale` 注入进 props 的。少了它就会抛
 *   "t is not a function" —— 这正是线上那次「头像出现了、下面那行却坏了」的原因。
 *   假对象必须同样严格，否则测试抓不到这类回归。
 *   `officialShouldThrow` 另行模拟「官方渲染器抛错」。
 */
let officialShouldThrow = false;
function OfficialTurnProcess(props) {
  if (officialShouldThrow === true) throw new Error("官方渲染器炸了（模拟）");
  if (typeof props?.t !== "function") throw new Error("t is not a function");
  return React.createElement("div", { className: "official-turn-process" }, "已完成，用时 5m42s");
}

/**
 * 模拟宿主：**条目声明了 `locale` 才把 `t` 注入 props**。
 * 造 props 时走这个函数，才复现得了真实机制。
 */
function entryProps(reg, base) {
  if (reg?.locale === undefined) return Object.assign({}, base);
  return Object.assign({}, base, { t: (key) => `T:${key}` });
}

async function loadClient(options = {}) {
  const withOfficial = options.withOfficial !== false;
  officialShouldThrow = options.officialThrows === true;
  diagCalls = [];
  addedLanguages = [];
  delete globalThis.__DSH_AGENT_PROFILES_REGISTERED__;
  styleEls.length = 0;
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  loadCount += 1;
  const url = new URL("../lib/client.js", import.meta.url);
  url.searchParams.set("fresh", String(loadCount));
  await import(url.href);
  if (captured === null) throw new Error("客户端模块没有向 __ModuleLoader__ 注册");

  const mod = captured.factory((name) => appRequire(name));
  const registrations = [];
  const effects = [];
  const logs = [];
  /**
   * 假的槽位服务：既要能 register，也要能 `entries(key)` / `subscribe(key, fn)`
   * —— 后者是「取官方渲染器」和「等官方条目出现再接管」用的公开方法。
   */
  const officialEntry = {
    options: { key: "turn-process", priority: 0 },
    component: OfficialTurnProcess,
  };
  const subscribers = [];
  const slotsService = {
    entries(key) {
      if (key !== "conversation.chat.node") return [];
      return withOfficial ? [officialEntry] : [];
    },
    subscribe(key, fn) {
      subscribers.push({ key, fn });
      return () => {};
    },
  };
  if (options.withSubscribe === false) delete slotsService.subscribe;
  const ctx = {
    effect(fn) {
      effects.push(fn);
      const result = fn();
      return typeof result === "function" ? result : () => {};
    },
    get: (name) => (name === "slots" ? slotsService : undefined),
    logger: {
      error: (m) => logs.push(["error", String(m)]),
      warn: (m) => logs.push(["warn", String(m)]),
      info: (m) => logs.push(["info", String(m)]),
    },
    locale: {
      // ⚠ 本插件的注册姿势是**映射表**：`register(NS, { zh, en, ru })`
      //   （与官方 client 插件一致）。两种形态都收：三参写法在别处还在用。
      //   收错形态的后果很隐蔽：语言名被当成字典 → 永远取不到词条 →
      //   整页回落中文兜底，而中文页刚好是默认，没人看得出来。
      register: (ns, localeOrDicts, dict) => {
        if (localeDicts[ns] === undefined) localeDicts[ns] = {};
        const pairs = typeof localeOrDicts === "string"
          ? [[localeOrDicts, dict]]
          : Object.entries(localeOrDicts ?? {});
        for (const [locale, entries] of pairs) localeDicts[ns][locale] = entries;
        return () => {};
      },
      // 真服务：沿当前语言的回退链查词条，查不到再返回 key 本身。
      bind: (ns) => (key) => {
        const d = localeDicts[ns];
        if (d === undefined) return key;
        for (const lang of localeChain(activeLocale)) {
          const value = d[lang]?.[key];
          if (value !== undefined) return value;
        }
        return key;
      },
      getLocale: () => ({ active: activeLocale, locales: languageCatalog.slice(), revision: 0 }),
      // 真服务：登记一种可选语言；重复登记会抛（插件里应该吞掉）。
      addLanguage: (input) => {
        addedLanguages.push(input);
        if (languageCatalog.some((entry) => entry.id === input.id) === false) {
          languageCatalog.push({ id: input.id, label: input.label, fallback: input.fallback });
        }
        return () => {
          const at = languageCatalog.findIndex((entry) => entry.id === input.id);
          if (at !== -1) languageCatalog.splice(at, 1);
        };
      },
    },
    slots: {
      inject(_key, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({
          key: options.name,
          id: options.id,
          order: options.order,
          priority: options.priority,
          entryKey: options.key,
          locale: options.locale,
          component,
        });
        return () => {};
      },
      entries: (key) => slotsService.entries(key),
      subscribe: (key, fn) => slotsService.subscribe(key, fn),
    },
  };
  let applyError = null;
  try {
    mod.apply(ctx);
  } catch (error) {
    applyError = error;
  }
  return {
    mod,
    registrations,
    applyError,
    id: captured.id,
    inject: mod.inject,
    logs,
    effects,
    subscribers,
    diagCalls: () => diagCalls.slice(),
    addedLanguages: () => addedLanguages.slice(),
  };
}

// ── 场景 0：模块契约 + 幂等栅栏 ──────────────────────────────
const first = await loadClient();
eq("模块 id 等于包名", first.id, "dsh-agent-profiles");
eq("apply 不抛错", first.applyError, null, first.applyError === null ? "" : String(first.applyError));
eq("客户端 inject 声明 slots 与 locale", first.inject.join(","), "slots,locale");
eq("注册了 3 个槽位条目", first.registrations.length, 3);
eq("样式挂了一次", styleEls.length, 1);

// 用户看完实际效果后的决定：「回合尾的就不用了」——这里把它钉成断言，
// 免得以后有人「顺手」把回合尾那份加回来。
check(
  "不再注册回合贡献区（turnTail）",
  first.registrations.some((r) => r.key === "conversation.chat.turnTail") === false,
  JSON.stringify(first.registrations.map((r) => r.key)),
);

// 回合头：顶替 conversation.chat.node 的 turn-process 键（官方「已完成 …」那一行）
const headReg = first.registrations.find((r) => r.key === "conversation.chat.node");
check("接管了 conversation.chat.node", headReg !== undefined);
eq("接管的是 turn-process 这个键", headReg?.entryKey, "turn-process");
eq("用更小的 priority 顶替（官方是 0，更小者渲染）", headReg?.priority, -10);
// ⚠ 这条断言直接对应线上那次「头像出现、下面那行变错误提示」：
//   官方的 t 是宿主按 locale 注入的，不声明就拿不到 ⇒ 转发过去必炸。
eq("声明了官方那个 locale 命名空间（否则官方渲染器拿不到 t）", headReg?.locale, "chat");
check("接管时没有告警", first.logs.some(([level]) => level === "warn") === false, JSON.stringify(first.logs));

const settingsReg = first.registrations.find((r) => r.key === "settings.section");
const quickReg = first.registrations.find((r) => r.key === "conversation.input.left");
check("设置页注册在 settings.section（用 id 不是 key）", settingsReg !== undefined);
eq("设置页槽位 id", settingsReg?.id, "agent-profiles");
check("快速切换器注册在 conversation.input.left", quickReg !== undefined);

// 幂等栅栏：不清全局标记再 import 一次，不应重复注册
{
  let capturedAgain = null;
  globalThis.window = { __ModuleLoader__: { load(spec) { capturedAgain = spec; } } };
  const url = new URL("../lib/client.js", import.meta.url);
  url.searchParams.set("fresh", "again");
  await import(url.href);
  eq("重复注入不再注册（幂等栅栏生效）", capturedAgain, null);
}

// ── 场景 1：数据还没到（首帧）────────────────────────────────
{
  const client = await loadClient();
  currentFetch = () => new Promise(() => {}); // 永不落地
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const quick = client.registrations.find((r) => r.key === "conversation.input.left");

  const page = outline(callComponent(reg.component, {}).tree);
  const failure = page.threw;
  check("设置页首帧不抛错", failure === undefined, String(failure?.stack ?? failure));
  check("设置页首帧没被错误边界兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  check("设置页首帧不是空树", page.lines.length > 0, page.flat);
  check("设置页首帧有可见文字", page.textLength > 0, `文字长度 ${page.textLength}`);
  console.log("\n【设置页首帧】\n" + page.flat);

  const sw = outline(callComponent(quick.component, {}).tree);
  check("切换器首帧不抛错", sw.threw === undefined, String(sw.threw?.stack ?? sw.threw));
  check("切换器首帧不是空树", sw.lines.length > 0 && sw.textLength > 0, sw.flat);
  console.log("\n【切换器首帧】\n" + sw.flat);
}

// ── 场景 2：接口返回 3 套配置 ────────────────────────────────
const serverState = {
  version: 1,
  activeId: "p-1",
  profiles: [
    { id: "p-1", name: "通用助手", icon: "🤖", role: "", personality: "", speech: "", rules: "",
      memorySummary: "", injectMemory: true, memories: [], createdAt: 1, updatedAt: 1 },
    { id: "p-2", name: "编程助手", icon: "🧑‍💻", role: "你是资深工程师", personality: "严谨",
      speech: "先结论", rules: "不确定就说不确定", memorySummary: "", injectMemory: true,
      memories: [{ id: "m1", text: "用户用 TS", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
    { id: "p-3", name: "写作教练", icon: "✍️", role: "你是写作教练", personality: "耐心",
      speech: "给改法", rules: "只改让改的部分", memorySummary: "写过一本书", injectMemory: false,
      memories: [], createdAt: 1, updatedAt: 1 },
  ],
};
const serverMeta = {
  dataDir: "C:/tmp", file: "C:/tmp/profiles.json", profileCount: 3, activeId: "p-1",
  activeName: "通用助手", memoryCount: 1, lastError: null, loadedFromDisk: true, promptChars: 128,
  diagnostics: { renders: 7, emptyRenders: 3, lastRenderAt: 1700000000000, lastChars: 0 },
};

{
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, state: serverState, meta: serverMeta }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const quick = client.registrations.find((r) => r.key === "conversation.input.left");

  callComponent(reg.component, {}); // 首帧 → effect 里发出 fetch
  callComponent(quick.component, {});

  // 判据：选择器（.ap-picker）出现即整页就绪 —— 它是数据到达后才渲染的第一块。
  // 锚点取「名称」页的内容：选择器在 draft 还没落地时就已渲染，早一步会读到空表单。
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"));
  check("数据到达后不抛错", page.threw === undefined, String(page.threw?.stack ?? page.threw));
  check("数据到达后没被兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  console.log("\n【数据到达后（截断 80 行）】\n" + page.lines.slice(0, 80).join("\n"));

  const tree = () => callComponent(reg.component, {}).tree;
  const byClass = (cls) => outline(tree(), (p) => p.className === cls).matched;
  const byRole = (role) => outline(tree(), (p) => p.role === role).matched;
  const byAction = (action) => outline(tree(), (p) => p["data-ap"] === action).matched[0];

  check("选择器列出 3 套配置",
    page.flat.includes("通用助手") && page.flat.includes("编程助手") && page.flat.includes("写作教练"),
    page.flat.slice(0, 300));
  const picker = byClass("ap-select ap-picker")[0];
  check("有一个多行 listbox（select + size）", picker !== undefined, page.flat.slice(0, 400));
  eq("listbox 的 size 恒为 3（3 套配置也正好 3 行）", picker?.size, 3);
  eq("listbox 选中当前配置", picker?.value, "p-1");
  check("当前配置在选择器里带「当前」标记", page.flat.includes("通用助手 · 当前"), page.flat.slice(0, 400));
  eq("选择器有 aria-label", picker?.["aria-label"], "配置");

  const acts = outline(tree(), (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-act")).matched;
  eq("六个图标按钮", acts.length, 6);
  eq("按钮顺序: левая колонка (new/duplicate/delete) → правая (import/export/restore)", acts.map((p) => p["data-ap"]).join(","), "new,duplicate,delete,import,export,restore");
  check("每个按钮都有 aria-label 与 title（同一句）", acts.every((p) => typeof p["aria-label"] === "string" && p["aria-label"] !== "" && p.title === p["aria-label"]), JSON.stringify(acts.map((p) => p["aria-label"])));
  eq("删除按钮的 aria-label", byAction("delete")?.["aria-label"], "删除当前配置");

  // 一行: слева new/duplicate/import, в середине селект, справа export/restore/delete.
  const pos = (needle) => page.flat.indexOf(needle);
  check(
    "порядок в DOM: new/duplicate/delete → select → import/export/restore",
    pos("ap=new") < pos("ap=duplicate") && pos("ap=duplicate") < pos("ap=delete")
      && pos("ap=delete") < pos("<select") && pos("<select") < pos("ap=import")
      && pos("ap=import") < pos("ap=export") && pos("ap=export") < pos("ap=restore"),
    [pos("ap=new"), pos("ap=duplicate"), pos("ap=delete"), pos("<select"), pos("ap=import"), pos("ap=export"), pos("ap=restore")].join(","),
  );
  {
    const top = outline(tree(), (p) => p.className === "ap-top").matched[0];
    const kids = (Array.isArray(top?.children) ? top.children : []).filter((child) => child !== null && child !== undefined);
    eq(
      "дети строки: левая колонка → селект → правая колонка → скрытый input",
      kids.map((child) => child.props?.className ?? child.type).join(","),
      "ap-actions ap-actions-left,ap-picker-col,ap-actions ap-actions-right,input",
    );
    eq("левая колонка — три кнопки new/duplicate/delete", outline(kids[0], (p) => p["data-ap"] !== undefined).matched.map((p) => p["data-ap"]).join(","), "new,duplicate,delete");
    eq("правая колонка — три кнопки import/export/restore", outline(kids[2], (p) => p["data-ap"] !== undefined).matched.map((p) => p["data-ap"]).join(","), "import,export,restore");
  }

  // Иконки: удаление — крестик; импорт/экспорт — документ со стрелкой в/из.
  eq("иконка удаления — крестик", byAction("delete")?.children, "✕");
  eq("иконка «新建» прежняя", byAction("new")?.children, "+");
  eq("иконка «复制» прежняя", byAction("duplicate")?.children, "⧉");
  eq("иконка «恢复默认» прежняя", byAction("restore")?.children, "↺");
  const glyphs = outline(tree(), (p) => p["data-icon"] !== undefined).matched;
  eq("две svg-иконки документов", glyphs.length, 2);
  eq("импорт — стрелка внутрь, экспорт — наружу", glyphs.map((p) => `${p["data-icon"]}:${p["data-arrow-direction"]}`).join(","), "import:in,export:out");
  check("стрелки импорта и экспорта — разные path", (() => {
    const paths = outline(tree(), (p) => typeof p.d === "string" && p.d.includes("12.6 2.7")).matched.map((p) => p.d);
    return paths.length === 2 && paths[0] !== paths[1];
  })(), "ожидались два разных path");

  // Тултипы: по наведению и по фокусу, текстом из словаря.
  {
    byAction("import").onMouseEnter();
    const isTip = (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-tip");
    const hovered = outline(tree(), isTip).matched;
    eq("по наведению показывается один тултип", hovered.length, 1);
    eq("текст тултипа — из словаря (tip.import)", hovered[0]?.children, "从 JSON 文件导入配置");
    eq("тултип связан с кнопкой через aria-describedby", byAction("import")?.["aria-describedby"], "ap-tip-import");
    byAction("import").onMouseLeave();
    eq("после ухода курсора тултип исчезает", outline(tree(), isTip).matched.length, 0);
    byAction("delete").onFocus();
    const focused = outline(tree(), isTip).matched;
    eq("по фокусу (клавиатура) тултип тоже показывается", focused.length, 1);
    eq("тултип удаления — из словаря", focused[0]?.children, "删除当前这套配置");
    byAction("delete").onBlur();
    eq("тултип из левой колонки растёт вправо", focused[0]?.className, "ap-tip ap-tip-start");
    eq("после потери фокуса тултип исчезает", outline(tree(), isTip).matched.length, 0);
  }

  const tabs = byRole("tab");
  eq("四个分页", tabs.length, 4);
  eq("分页顺序：名称/角色/记忆/提示词", tabs.map((p) => p.children).join(","), "名称,角色,记忆,提示词");
  eq("默认选中的是第一页", tabs.map((p) => p["aria-selected"]).join(","), "true,false,false,false");

  // 默认页「名称」：身份字段在，角色/记忆/预览的字段不在。
  check("名称页有图标与名称输入框", page.flat.includes("ap-icon-input") && page.flat.includes('value="通用助手"'), page.flat.slice(0, 600));
  check("名称页没有角色/记忆字段", !page.flat.includes("<textarea"), page.flat.slice(0, 600));
  check("名称页有「设为当前配置」的状态按钮", page.flat.includes("当前已启用"), page.flat.slice(0, 800));
  check("页面底部不再有元信息块（说明收进「?」）", page.flat.includes("存储位置") === false && page.flat.includes("注入统计") === false, page.flat.slice(-500));

  // ── 交互：分页 ──
  const tabNode = (label) => outline(tree(), (p) => p.role === "tab" && p.children === label).matched[0];
  const roleTab = tabNode("角色");
  check("能捞到「角色」分页", roleTab !== undefined);
  if (roleTab !== undefined) {
    check("分页带点击处理", typeof roleTab.onClick === "function");
    roleTab.onClick();
    const rolePage = await renderUntil(reg.component, (acc) => acc.flat.includes("性格特点"));
    check("角色页渲染了角色/性格/说话/准则", ["角色设定", "性格特点", "说话习惯", "行为准则"].every((text) => rolePage.flat.includes(text)), rolePage.flat.slice(0, 600));
    check("角色页没有记忆条目与预览", !rolePage.flat.includes("记忆条目") && !rolePage.flat.includes("生成预览"), rolePage.flat.slice(0, 600));
    eq("「角色」分页被选中", outline(tree(), (p) => p.role === "tab").matched.map((p) => p["aria-selected"]).join(","), "false,true,false,false");

    tabNode("记忆").onClick();
    const memPage = await renderUntil(reg.component, (acc) => acc.flat.includes("记忆条目"));
    check("记忆页有注入开关", memPage.flat.includes("将记忆注入到每次会话"), memPage.flat.slice(0, 600));
    check("注入开关是 role=switch 且带 aria-checked", memPage.flat.includes("role=switch") && memPage.flat.includes("aria-checked="), memPage.flat.slice(0, 600));
    check("记忆页有摘要与条目与用量", memPage.flat.includes("长期记忆摘要") && memPage.flat.includes("记忆条目") && memPage.flat.includes("长期记忆占用"), memPage.flat.slice(0, 600));

    tabNode("提示词").onClick();
    const promptPage = await renderUntil(reg.component, (acc) => acc.flat.includes("生成预览"));
    check("提示词页有预览按钮与说明", promptPage.flat.includes("生成预览") && promptPage.flat.includes("注入内容预览"), promptPage.flat.slice(0, 600));
    tabNode("名称").onClick();
    await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"));
  }

  // ── 交互：「?」浮层 ──
  const helpBtn = byClass("ap-help-btn")[0];
  check("页头有「?」按钮", helpBtn !== undefined, page.flat.slice(0, 300));
  eq("「?」默认收起", helpBtn?.["aria-expanded"], "false");
  if (helpBtn !== undefined) {
    helpBtn.onClick();
    const opened = await renderUntil(reg.component, (acc) => acc.flat.includes("存储位置"));
    check("展开后有存储位置与注入统计", opened.flat.includes("C:/tmp/profiles.json") && opened.flat.includes("注入统计"), opened.flat.slice(0, 800));
    check("展开后有对话专属设定计数", opened.flat.includes("对话专属设定"), opened.flat.slice(0, 800));
    const openedBtn = outline(tree(), (p) => p.className === "ap-help-btn").matched[0];
    eq("展开后 aria-expanded=true", openedBtn?.["aria-expanded"], "true");
    openedBtn.onClick();
    const closed = await renderUntil(reg.component, (acc) => acc.flat.includes("存储位置") === false);
    check("再点一次收起", closed.flat.includes("存储位置") === false, closed.flat.slice(-400));
  }

  // ── 交互：删除确认就在按钮条旁边 ──
  const del = byAction("delete");
  check("删除按钮可用（3 套配置）", del?.disabled === false);
  if (del !== undefined) {
    del.onClick();
    const confirming = await renderUntil(reg.component, (acc) => acc.flat.includes("删除「通用助手」"));
    check("确认文案指名要点哪一套", confirming.flat.includes("删除「通用助手」？不可撤销。"), confirming.flat.slice(0, 600));
    const inline = outline(tree(), (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-confirm-inline")).matched;
    eq("确认块只有一块，并且挂在顶部那一行里", inline.length, 1);
    check("确认块 — сразу под строкой (селект не сдвигается)", (() => {
      const pageNode = outline(tree(), (p) => p.className === "ap-page").matched[0];
      const kids = Array.isArray(pageNode?.children) ? pageNode.children.filter((child) => child !== null) : [];
      const classes = kids.map((child) => (child.props && child.props.className) || "");
      const topAt = classes.indexOf("ap-top");
      return topAt !== -1 && classes[topAt + 1] === "ap-confirm-inline";
    })(), JSON.stringify(inline.map((p) => Object.keys(p))));
    const cancel = outline(tree(), (p) => p.className === "ap-btn" && p.children === "取消" && typeof p.onClick === "function").matched[0];
    check("确认块里有「取消」", cancel !== undefined);
    cancel?.onClick();
    const cancelled = await renderUntil(reg.component, (acc) => acc.flat.includes("ap-confirm-inline") === false);
    check("取消后确认块消失", cancelled.flat.includes("ap-confirm-inline") === false);
    check("取消没有删掉配置", cancelled.flat.includes("通用助手") && cancelled.flat.includes("写作教练"));
  }

  // ── 交互：在选择器里换一套配置 ──
  // 静态断言只能证明「渲染出了东西」，证明不了「换了有用」。
  picker.onChange({ target: { value: "p-2" } });
  const page2 = await renderUntil(reg.component, (acc) => acc.flat.includes("设为当前配置"));
  check("换配置后按钮变为「设为当前配置」", page2.flat.includes("设为当前配置"), page2.flat.slice(0, 600));
  eq("选择器跟着换到新配置", outline(tree(), (p) => p.className === "ap-select ap-picker").matched[0]?.value, "p-2");
  tabNode("角色").onClick();
  const page2role = await renderUntil(reg.component, (acc) => acc.flat.includes('value="你是资深工程师"'));
  check("角色页装的是所选配置", page2role.flat.includes('value="你是资深工程师"'), page2role.flat.slice(0, 600));
  tabNode("记忆").onClick();
  const page2mem = await renderUntil(reg.component, (acc) => acc.flat.includes("用户用 TS"));
  check("记忆页带出了该配置的条目", page2mem.flat.includes("用户用 TS"), page2mem.flat.slice(0, 900));
  check("切换后不再显示未保存徽标", !page2mem.flat.includes("有未保存改动"), page2mem.flat.slice(0, 400));
  check("编辑器仍然没被错误边界兜住", page2mem.boundaryCaught === null, String(page2mem.boundaryCaught));
  tabNode("名称").onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"));

  const sw = await renderUntil(quick.component, (acc) => acc.flat.includes("通用助手"));
  check("切换器数据到达后不抛错", sw.threw === undefined, String(sw.threw?.stack ?? sw.threw));
  check("切换器渲染出 select", sw.flat.includes("<select"), sw.flat);
  check("切换器列出 3 套配置", sw.flat.includes("通用助手") && sw.flat.includes("编程助手"), sw.flat);
  console.log("\n【切换器（有数据）】\n" + sw.flat);
}

// ── 场景 3：接口失败 ────────────────────────────────────────
{
  currentFetch = () => Promise.reject(new Error("network down"));
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  callComponent(reg.component, {});
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("读取配置失败"));
  check("失败时不抛错", page.threw === undefined, String(page.threw?.stack ?? page.threw));
  check("失败时没被兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  check("失败时给出可见文字而不是空白", page.textLength > 0, page.flat);
  check("失败时写明了原因", page.flat.includes("network down") || page.flat.includes("读取配置失败"), page.flat);
  console.log("\n【接口失败时】\n" + page.flat);
}

// ── 场景 4：错误边界真的能兜住 ───────────────────────────────
{
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const boundaryType = reg.component({}).type;
  check("槽位条目外层套了错误边界",
    typeof boundaryType?.getDerivedStateFromError === "function", String(boundaryType));

  function Boom() {
    throw new Error("boom-for-test");
  }
  const caught = outline(React.createElement(boundaryType, null, React.createElement(Boom)));
  check("边界捕获了子组件抛错", caught.boundaryCaught === "boom-for-test", String(caught.boundaryCaught));
  check("兜底界面有可读文字（不是又一次空白）", caught.textLength > 0, `${caught.textLength} 字`);
  check("兜底界面给出了原因", caught.flat.includes("boom-for-test"), caught.flat.slice(0, 400));
  check("兜底界面说明配置没坏", caught.flat.includes("不是你的配置坏了"), caught.flat.slice(0, 400));
  console.log("\n【错误边界兜底】\n" + caught.lines.slice(0, 14).join("\n"));

  // 紧凑模式（输入框工具行用）只给一行
  const compact = outline(React.createElement(boundaryType, { compact: true }, React.createElement(Boom)));
  check("紧凑模式也兜住了", compact.boundaryCaught === "boom-for-test");
  check("紧凑模式只有一行文字", compact.lines.length <= 3, compact.flat);
}

// ── 场景 5：本对话控件 + 本对话设定的浮层面板 ───────────────
{
  const SESSION = "session-test-1";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            state: {
              ...serverState,
              sessions: {
                [SESSION]: {
                  profileId: "p-2",
                  note: "这次只讨论方案，先别改代码",
                  memories: [{ id: "sm1", text: "用户这次只要结论", createdAt: 1 }],
                  updatedAt: 1,
                },
              },
            },
            meta: { ...serverMeta, sessionCount: 1, sessionMemoryCount: 1 },
          }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const quick = client.registrations.find((r) => r.key === "conversation.input.left");
  const props = { sessionId: SESSION };

  const sw = await renderUntil(quick.component, (acc) => acc.flat.includes("跟随全局"), 1500, props);
  check("本对话控件不抛错", sw.threw === undefined, String(sw.threw?.stack ?? sw.threw));
  check("本对话控件没被兜住", sw.boundaryCaught === null, String(sw.boundaryCaught));
  check("下拉里有「跟随全局」这一项", sw.flat.includes("跟随全局"), sw.flat);
  check("下拉的值是本对话绑定的配置 p-2", sw.flat.includes('value="p-2"'), sw.flat);
  check("有绑定时按钮标出「本对话」", sw.flat.includes("本对话"), sw.flat);
  console.log("\n【本对话控件】\n" + sw.flat);

  // 打开面板（按钮上带 title，用它把元素捞出来直接点）
  const btn = outline(callComponent(quick.component, props).tree, (p) => p.title === "本对话的智能体设定")
    .matched[0];
  check("找得到打开面板的按钮", btn !== undefined, "按钮不存在");
  check("按钮带点击处理", typeof btn?.onClick === "function");
  btn.onClick();

  // 面板的草稿是在 effect 里初始化的：setState 之后 React 会再渲染一次。
  // 所以这里必须轮询到内容出现，而不是只看点击后的那一帧
  // （只看一帧会得到「读取中…」——那是中间态，不是缺陷）。
  const opened = await renderUntil(
    quick.component,
    (acc) => acc.flat.includes("本对话补充设定"),
    1500,
    props,
  );
  check("面板没抛错", opened.threw === undefined, String(opened.threw?.stack ?? opened.threw));
  check("面板没被兜住", opened.boundaryCaught === null, String(opened.boundaryCaught));
  check("面板渲染出「本对话的智能体」标题", opened.flat.includes("本对话的智能体"), opened.flat);
  check("面板有绑定状态说明", opened.flat.includes("本对话使用"), opened.flat);
  check("面板有补充设定输入框且带出已存内容",
    opened.flat.includes("本对话补充设定") && opened.flat.includes('value="这次只讨论方案，先别改代码"'), opened.flat);
  check("面板有专属记忆区且带出已存条目",
    opened.flat.includes("本对话专属记忆") && opened.flat.includes("用户这次只要结论"), opened.flat);
  check("面板有保存与清除按钮",
    opened.flat.includes("保存到本对话") && opened.flat.includes("清除本对话设定"), opened.flat);
  check("面板显示会话 id（便于排查）", opened.flat.includes(SESSION), opened.flat);
  console.log("\n【本对话面板】\n" + opened.lines.slice(0, 40).join("\n"));
}

// ── 场景 6：头像（设置里显示 / 未设回落 / 加载失败回落 / 助手消息条目）──
{
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const withAvatar = {
    ...serverState,
    profiles: serverState.profiles.map((p) => (p.id === "p-1" ? { ...p, avatar: PNG } : p)),
  };
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, state: withAvatar, meta: serverMeta }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const page = client.registrations.find((r) => r.key === "settings.section");
  const rendered = await renderUntil(page.component, (acc) => acc.flat.includes("上传图片"));
  check("设置页渲染出上传按钮", rendered.flat.includes("上传图片"), rendered.flat.slice(0, 300));
  check("设了头像时渲染 <img>", rendered.flat.includes("ap-avatar") && rendered.flat.includes("src="), rendered.flat);
  check("设了头像时不显示回落图标", !rendered.flat.includes("ap-avatar-fallback"), rendered.flat.slice(0, 400));
  check("头像用 data URL 作为 src", rendered.flat.includes("data:image/png;base64"), rendered.flat.slice(0, 400));
  check("有移除头像按钮", rendered.flat.includes("移除头像"));
  check("写了头像说明（缩放到 512px / 回落规则）",
    rendered.flat.includes("512px") && rendered.flat.includes("破图"), rendered.flat.slice(0, 600));
  console.log("\n【头像（已设置）】\n" + rendered.flat.split("\n").filter((l) => l.includes("avatar") || l.includes("头像") || l.includes("上传")).join("\n"));

  // 加载失败 → 必须回落成 emoji 图标，而且不留破图
  const img = outline(callComponent(page.component, {}).tree, (p) => p.className === "ap-avatar").matched[0];
  check("找得到头像 <img> 元素", img !== undefined);
  check("头像 <img> 带 onError", typeof img?.onError === "function");
  img.onError();
  const afterError = outline(callComponent(page.component, {}).tree);
  check("加载失败后回落到 emoji 图标", afterError.flat.includes("ap-avatar-fallback"), afterError.flat.slice(0, 400));
  check("加载失败后不再渲染 <img>", !afterError.flat.includes("ap-avatar\" src"), afterError.flat.slice(0, 400));
  check("加载失败不算渲染错误（没被错误边界兜住）", afterError.boundaryCaught === null, String(afterError.boundaryCaught));
}

// ── 场景 7：没设头像 + 助手消息条目 ─────────────────────────
{
  const SESSION = "session-avatar-1";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            state: {
              ...serverState,
              sessions: {
                [SESSION]: { profileId: "p-2", note: "", memories: [], updatedAt: 1 },
              },
            },
            meta: serverMeta,
          }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const page = client.registrations.find((r) => r.key === "settings.section");
  const rendered = await renderUntil(page.component, (acc) => acc.flat.includes("上传图片"));
  check("没设头像时显示回落图标", rendered.flat.includes("ap-avatar-fallback"), rendered.flat.slice(0, 400));
  check("没设头像时不渲染 <img>", !rendered.flat.includes("src="), rendered.flat.slice(0, 400));
  check("回落显示的是该配置的 emoji", rendered.flat.includes("🤖"), rendered.flat.slice(0, 400));

  // ── 回合头：必须同时渲染「我的头像+名称」和「官方那一行」──
  const props = { sessionId: SESSION };
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  check("回合头条目已注册", head !== undefined);
  // ⚠ 用 entryProps：模拟宿主按 locale 注入 t，否则官方渲染器会抛 "t is not a function"
  const headRendered = await renderUntil(
    head.component,
    (acc) => acc.flat.includes("已完成"),
    1500,
    entryProps(head, props),
  );
  check("回合头不抛错", headRendered.threw === undefined, String(headRendered.threw?.stack ?? headRendered.threw));
  check("回合头没被错误边界兜住", headRendered.boundaryCaught === null, String(headRendered.boundaryCaught));
  check("回合头渲染出「头像 + 名称」", headRendered.flat.includes("ap-turn-head") && headRendered.flat.includes("编程助手"), headRendered.flat);
  check("回合头带该配置的头像（未设时是图标）", headRendered.flat.includes("ap-avatar"), headRendered.flat);
  // 用户明确要求「头像放大到大约两倍」：22px → 44px，文字尺寸不变。
  // ⚠ 内联 style 不在 outline 的文本里（打印机不输出它）——必须直接取节点读 props，
  //   否则这条断言会因为「打印不出来」而假失败，或者更糟：假通过。
  const headAvatar = outline(callComponent(head.component, entryProps(head, props)).tree, (p) =>
    typeof p.className === "string" && p.className.includes("ap-avatar"),
  ).matched[0];
  eq("回合头头像宽度 44px（用户要求的两倍）", headAvatar?.style?.width, "44px");
  eq("回合头头像高度 44px", headAvatar?.style?.height, "44px");
  // ⚠ 这条是本设计的核心：官方那一行必须**原样**还在，而不是被我重写掉。
  check("官方「已完成 …」那一行原样保留", headRendered.flat.includes("official-turn-process") && headRendered.flat.includes("已完成，用时 5m42s"), headRendered.flat);
  check("我的头排在官方那一行**前面**", headRendered.flat.indexOf("ap-turn-head") < headRendered.flat.indexOf("official-turn-process"), headRendered.flat);
  console.log("\n【回合头（顶替 + 包一层官方）】\n" + headRendered.flat);

  // 没绑定的对话 → 回落全局当前配置（通用助手）
  const other = await renderUntil(head.component, (acc) => acc.flat.includes("通用助手"), 1500, entryProps(head, {
    sessionId: "session-other",
  }));
  check("未绑定的对话回落到全局当前配置", other.flat.includes("通用助手"), other.flat);
}

// ── 场景 8：能力探测 —— 取不到官方渲染器时**不许接管** ────────
{
  // 槽位服务里没有官方 turn-process 条目（例如 ui-chat 还没加载）
  const client = await loadClient({ withOfficial: false });
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  check("取不到官方渲染器时不注册接管", head === undefined, JSON.stringify(client.registrations.map((r) => r.key)));
  // 这时候**不该告警**：还挂着订阅在等官方条目出现（加载顺序兜底），是正常状态。
  check(
    "挂上了等待官方条目的订阅（加载顺序兜底）",
    client.subscribers.some((s) => s.key === "conversation.chat.node"),
    JSON.stringify(client.subscribers),
  );
  check("没有误报告警", client.logs.some(([level]) => level === "warn") === false, JSON.stringify(client.logs));
  // 其余条目不受影响
  check("设置页照常注册", client.registrations.some((r) => r.key === "settings.section"));
  check("回合结尾不再注册（用户要求去掉）", client.registrations.some((r) => r.key === "conversation.chat.turnTail") === false);
}

// ── 场景 8b：连订阅都没有、又取不到官方渲染器 → 必须上报诊断 ──
{
  const client = await loadClient({ withOfficial: false, withSubscribe: false });
  const calls = client.diagCalls();
  check(
    "把「没找到官方渲染器」上报给宿主日志（我没法看页面，只能靠这条）",
    calls.some((c) => String(c.tag).includes("未找到官方渲染器")),
    JSON.stringify(calls),
  );
  check(
    "并且带上了「看到了什么」（entries 的长度与 key 列表）",
    calls.some((c) => String(c.tag).includes("未找到官方渲染器") && String(c.detail).includes("长度=")),
    JSON.stringify(calls),
  );
  check(
    "也上报了「没有订阅能力」",
    calls.some((c) => String(c.tag).includes("没有订阅能力")),
    JSON.stringify(calls),
  );
  check("依然不注册接管", client.registrations.some((r) => r.key === "conversation.chat.node") === false);
}

// ── 场景 8c：诊断通道本身（apply 走完必须报一笔）─────────────
{
  const client = await loadClient();
  check(
    "apply 走完会上报「apply/完成」",
    client.diagCalls().some((c) => c.tag === "apply/完成"),
    JSON.stringify(client.diagCalls()),
  );
  check(
    "接管成功会上报「已接管」",
    client.diagCalls().some((c) => String(c.tag).includes("已接管")),
    JSON.stringify(client.diagCalls()),
  );
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  // ⚠ 必须等**徽标**出现，不能等官方那行 —— 官方那行是同步渲染的，
  //   而徽标要等状态拉回来（effectiveProfile 拿不到配置时返回 null）。
  await renderUntil(head.component, (acc) => acc.flat.includes("ap-turn-head"), 1500, entryProps(head, {
    sessionId: "s-diag",
  }));
  check(
    "徽标真渲染出来时会再报一笔（这是「接管生效」的直接证据）",
    client.diagCalls().some((c) => String(c.tag).includes("徽标已渲染")),
    JSON.stringify(client.diagCalls()),
  );
}

// ── 场景 8d：官方渲染器抛错时，边界必须抓住并上报 ─────────────
{
  const client = await loadClient({ officialThrows: true });
  const head = client.registrations.find((r) => r.key === "conversation.chat.node");
  // ⚠ 这里**故意按宿主的真实机制**给 props（走 entryProps ⇒ 带 t），
  //   再让官方渲染器抛错，验边界能不能抓住并上报。
  const rendered = await renderUntil(
    head.component,
    (acc) => acc.flat.includes("ap-turn-head"),
    1500,
    entryProps(head, { sessionId: "s-boom" }),
  );
  check("官方抛错时我的头像头仍然渲染", rendered.flat.includes("ap-turn-head"), rendered.flat);
  check(
    "边界捕获了官方的抛错（boundaryCaught）",
    String(rendered.boundaryCaught ?? "").includes("官方渲染器炸了"),
    String(rendered.boundaryCaught),
  );
  check(
    "并把错误上报到宿主日志（这是「渲染了但没提交」唯一能看到的证据）",
    client.diagCalls().some((c) => String(c.tag).includes("boundary/捕获") && String(c.detail).includes("官方渲染器炸了")),
    JSON.stringify(client.diagCalls()),
  );
}

// ── 场景 12：英文界面（界面文案跟宿主语言走）─────────────────
// 用户口径：「对模型来说中英文没区别，我要的是**用户在设置里看到的按钮文字
// 是他自己语言的文字**」⇒ 所以必须真的把英文渲染出来看，而不是只数字典里的键。
{
  // ⚠ 数据也用英文：这样「整页一个中文都没有」才能当硬断言用 ——
  //   任何中文都只可能来自**界面文案**（角色模板按钮、字段标签…）。
  const enState = {
    activeId: "p-1",
    profiles: [
      { id: "p-1", name: "General", icon: "🤖", role: "", personality: "", speech: "", rules: "",
        memorySummary: "", injectMemory: true, memories: [], createdAt: 1, updatedAt: 1 },
      { id: "p-2", name: "Engineer", icon: "🧑‍💻", role: "You are a senior engineer", personality: "Rigorous",
        speech: "Conclusion first", rules: "Say when you are unsure", memorySummary: "", injectMemory: true,
        memories: [{ id: "m1", text: "The user works in TS", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
      { id: "p-3", name: "Coach", icon: "✍️", role: "You are a writing coach", personality: "Patient",
        speech: "Give the fix", rules: "Only change what was asked", memorySummary: "Wrote a book", injectMemory: false,
        memories: [], createdAt: 1, updatedAt: 1 },
    ],
  };
  const enMeta = {
    dataDir: "C:/tmp", file: "C:/tmp/profiles.json", profileCount: 3, activeId: "p-1",
    activeName: "General", memoryCount: 1, lastError: null, loadedFromDisk: true, promptChars: 128,
    diagnostics: { renders: 7, emptyRenders: 3, lastRenderAt: 1700000000000, lastChars: 0 },
  };
  activeLocale = "en";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: enState, meta: enMeta }) });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  console.log("\n【英文界面（截断 60 行）】\n" + page.lines.slice(0, 60).join("\n"));

  check("英文界面没被错误边界兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  check("英文页整页**一个中文都没有**", !/[\u4e00-\u9fff]/u.test(page.flat), page.flat.slice(0, 500));
  eq("英文分页标题", outline(callComponent(reg.component, {}).tree, (p) => p.role === "tab").matched.map((p) => p.children).join(","), "Name,Role,Memory,Prompt");
  eq(
    "英文图标按钮的 aria-label",
    outline(callComponent(reg.component, {}).tree, (p) => p["data-ap"] !== undefined).matched.map((p) => p["aria-label"]).join("|"),
    "New profile|Duplicate current profile|Delete current profile|Import profiles|Export profiles|Restore default profiles",
  );
  // 「?」里的注入统计（以前在页面底部，现在收进浮层）。
  outline(callComponent(reg.component, {}).tree, (p) => p.className === "ap-help-btn").matched[0].onClick();
  const withHelp = await renderUntil(reg.component, (acc) => acc.flat.includes("Injection:"));
  check("英文页有英文的注入统计行", withHelp.flat.includes("Injection:"), withHelp.flat.slice(0, 500));
  outline(callComponent(reg.component, {}).tree, (p) => p.className === "ap-help-btn").matched[0].onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("Injection:") === false);

  // 模板按钮在「Role」页上。
  outline(callComponent(reg.component, {}).tree, (p) => p.role === "tab" && p.children === "Role").matched[0].onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("Personality"));

  // 6 个角色模板按钮：改造前是硬编码中文（label / role 都写死在 ROLE_TEMPLATES 里）。
  const CHIPS = ["Engineering", "Writing coach", "Translation", "Product manager", "Data analysis", "Study partner"];
  const chipLabels = outline(callComponent(reg.component, {}).tree, (p) => p.className === "ap-chip").matched.map(
    (p) => p.children,
  );
  console.log(`   模板按钮实际文字：${JSON.stringify(chipLabels)}`);
  check(
    `6 个模板按钮全是英文（${CHIPS.join(" / ")}）`,
    JSON.stringify(chipLabels) === JSON.stringify(CHIPS),
    JSON.stringify(chipLabels),
  );
  check("模板按钮里没有中文", !chipLabels.some((l) => /[\u4e00-\u9fff]/u.test(String(l))), JSON.stringify(chipLabels));

  // 点一个模板：填进「角色设定」的正文也必须是英文。
  const engineer = outline(
    callComponent(reg.component, {}).tree,
    (p) => p.className === "ap-chip" && p.children === "Engineering",
  ).matched[0];
  check("能捞到 Engineering 这个模板按钮", engineer !== undefined);
  if (engineer !== undefined) {
    check("该模板按钮带点击处理", typeof engineer.onClick === "function");
    engineer.onClick();
    const after = await renderUntil(reg.component, (acc) => acc.flat.includes("You are a senior software engineer"), 1500);
    check(
      "点模板后「角色设定」里填的是英文正文",
      after.flat.includes('value="You are a senior software engineer'),
      after.flat.slice(-900),
    );
  }

  // 渲染失败时的紧凑提示：`boundary.compactTitle` 曾经是英文字典里唯一缺的键，
  // 缺了就会漏出中文兜底（审计报告第 1 层「唯一的真缺口」）。
  const Boom2 = function Boom2() {
    throw new Error("boom-for-i18n");
  };
  const boundaryType = reg.component({}).type;
  const compactMatch = outline(
    React.createElement(boundaryType, { compact: true }, React.createElement(Boom2)),
    (p) => typeof p.title === "string" && p.title.includes("plugin defect"),
  ).matched;
  check("紧凑错误提示用的是英文词条（boundary.compactTitle 不再回落中文）", compactMatch.length === 1, JSON.stringify(compactMatch.map((p) => p.title)));
  const compactAny = outline(
    React.createElement(boundaryType, { compact: true }, React.createElement(Boom2)),
    (p) => typeof p.title === "string",
  ).matched;
  check(
    "紧凑错误提示里没有中文",
    compactAny.length > 0 && compactAny.every((p) => !/[\u4e00-\u9fff]/u.test(p.title)),
    JSON.stringify(compactAny.map((p) => p.title)),
  );
  activeLocale = "zh";
}

// ── 场景 13：俄语界面 + 语言注册接上了宿主 ───────────────────
// 口径和英文那条一样：数据用俄语/英语，这样「整页没有 CJK」才是硬断言 ——
// 任何中文都只可能来自界面文案。
{
  const ruState = {
    activeId: "p-1",
    profiles: [
      { id: "p-1", name: "Общий", icon: "🤖", role: "", personality: "", speech: "", rules: "",
        memorySummary: "", injectMemory: true, memories: [], createdAt: 1, updatedAt: 1 },
      { id: "p-2", name: "Инженер", icon: "🧑‍💻", role: "Ты инженер", personality: "Строго",
        speech: "Сначала вывод", rules: "Не выдумывать", memorySummary: "", injectMemory: true,
        memories: [{ id: "m1", text: "Пользователь пишет на TS", createdAt: 1 }], createdAt: 1, updatedAt: 1 },
    ],
  };
  const ruMeta = {
    dataDir: "/tmp", file: "/tmp/profiles.json", profileCount: 2, activeId: "p-1",
    activeName: "Общий", memoryCount: 1, lastError: null, loadedFromDisk: true, promptChars: 12,
    diagnostics: { renders: 1, emptyRenders: 0, lastRenderAt: 1700000000000, lastChars: 0 },
  };
  activeLocale = "ru";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: ruState, meta: ruMeta }) });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  eq("宿主目录里出现了 ru", client.addedLanguages().some((entry) => entry.id === "ru"), true);
  eq("ru 的回退语言是 en", client.addedLanguages().find((entry) => entry.id === "ru")?.fallback, "en");
  eq("三本字典都注册了", Object.keys(localeDicts["dsh-agent-profiles"] ?? {}).sort().join(","), "en,ru,zh");

  const reg = client.registrations.find((r) => r.key === "settings.section");
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  console.log("\n【俄语界面（截断 40 行）】\n" + page.lines.slice(0, 40).join("\n"));

  check("俄语界面没被错误边界兜住", page.boundaryCaught === null, String(page.boundaryCaught));
  check("俄语页整页一个 CJK 都没有", !/[\u3000-\u303f\u4e00-\u9fff\uff01-\uff60]/u.test(page.flat), page.flat.slice(0, 400));
  eq("俄语分页标题", outline(callComponent(reg.component, {}).tree, (p) => p.role === "tab").matched.map((p) => p.children).join(","), "Имя,Роль,Память,Промпт");
  eq(
    "俄语图标按钮的 aria-label",
    outline(callComponent(reg.component, {}).tree, (p) => p["data-ap"] !== undefined).matched.map((p) => p["aria-label"]).join("|"),
    "Новый профиль|Дублировать профиль|Удалить профиль|Импортировать профили|Экспортировать профили|Восстановить профили по умолчанию",
  );
  for (const needle of ["Профили", "Имя"]) {
    check(`俄语页有「${needle}」`, page.flat.includes(needle), page.flat.slice(0, 600));
  }
  outline(callComponent(reg.component, {}).tree, (p) => p.role === "tab" && p.children === "Роль").matched[0].onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("Характер"));
  const ruChips = outline(callComponent(reg.component, {}).tree, (p) => p.className === "ap-chip").matched
    .map((p) => p.children);
  check("6 个模板按钮都是俄语", JSON.stringify(ruChips) === JSON.stringify([
    "Инженер", "Редактор", "Переводчик", "Продакт-менеджер", "Аналитик данных", "Партнёр по учёбе",
  ]), JSON.stringify(ruChips));
  activeLocale = "zh";
}

// ── 场景 14：语言不认识 → 回落中文，不是空串、不是键名 ────────
{
  activeLocale = "de-DE";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, state: serverState, meta: serverMeta }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  check("未知语言不抛错", page.threw === undefined, String(page.threw?.stack ?? page.threw));
  check("未知语言回落中文界面", page.flat.includes("配置列表") && page.flat.includes("名称"), page.flat.slice(0, 400));
  eq("未知语言的分页标题是中文", outline(callComponent(reg.component, {}).tree, (p) => p.role === "tab").matched.map((p) => p.children).join(","), "名称,角色,记忆,提示词");
  eq(
    "未知语言的图标按钮 aria-label 是中文",
    outline(callComponent(reg.component, {}).tree, (p) => p["data-ap"] !== undefined).matched.map((p) => p["aria-label"]).join("|"),
    "新建配置|复制当前配置|删除当前配置|导入配置|导出配置|恢复默认配置",
  );
  check(
    "未知语言页面上没有裸键名（说明走的不是 bind 的 key 兜底）",
    ["list.title", "editor.save", "field.role", "tab.name"].every((key) => page.flat.includes(key) === false),
    page.flat.slice(0, 400),
  );
  check("未知语言页面没有空的标签", page.flat.includes('"名称"') && page.flat.includes('"配置列表"'));
  activeLocale = "zh";
}

// ── 场景 15：切语言不丢正在编辑的内容 ───────────────────────
// 语言是宿主侧的开关，但草稿在组件的 state 里。切语言只该换文案，
// 不该把用户刚敲进去的字清掉 —— 这一点只有真的改一次值再重渲染才验得到。
{
  activeLocale = "zh";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, state: serverState, meta: serverMeta }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  // 文本框在「角色」页上：先切过去，再验「切语言不丢内容」。
  outline(callComponent(reg.component, {}).tree, (p) => p.role === "tab" && p.children === "角色").matched[0].onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("性格特点"));

  const roleField = outline(callComponent(reg.component, {}).tree, (p) => p.className === "ap-textarea").matched[0];
  check("找到「角色设定」的文本框", roleField !== undefined);
  if (roleField !== undefined) {
    roleField.onChange({ target: { value: "Проверка переключения языка" } });
    const zhAfter = await renderUntil(reg.component, (acc) => acc.flat.includes("Проверка переключения языка"));
    check("中文界面里刚输入的值在", zhAfter.flat.includes('value="Проверка переключения языка"'));

    activeLocale = "ru";
    const ruAfter = await renderUntil(reg.component, (acc) => acc.flat.includes('value="Проверка переключения языка"'));
    check("切到俄语后输入的值还在", ruAfter.flat.includes('value="Проверка переключения языка"'), ruAfter.flat.slice(0, 500));
    check("切到俄语后标签跟着变了", ruAfter.flat.includes('"Роль"'), ruAfter.flat.slice(0, 400));
    // ⚠ 数据本身是中文的（serverState），所以这里只断言**界面标签**换了语言。
    check(
      "切到俄语后中文界面标签消失了",
      ruAfter.flat.includes('"角色设定"') === false && ruAfter.flat.includes('"名称"') === false,
      ruAfter.flat.slice(0, 400),
    );
    check("切语言后组件仍然没被错误边界兜住", ruAfter.boundaryCaught === null, String(ruAfter.boundaryCaught));
    activeLocale = "zh";
  }
}

// ── 场景 16：版面本身（列表一栏、六个字形按钮、四个分页、无页脚说明）──
// 这一组是**结构断言**，不看文案：评审要能一眼看出「布局改成什么样了」，
// 而不是从截图里猜。要求写在这里，改布局的人必须连断言一起改。
{
  activeLocale = "zh";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({
        json: () => Promise.resolve({ ok: true, state: serverState, meta: serverMeta }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  const page = await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  const tree = () => callComponent(reg.component, {}).tree;

  // ① 恰好一个配置选择器，固定三行高（不是一列卡片，也不随配置数量长高）。
  const selects = outline(tree(), (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-picker")).matched;
  eq("设置页只有一个配置 listbox", selects.length, 1);
  eq("listbox 固定三行（size === 3）", selects[0]?.size, 3);
  check("listbox 里没有第二套列表控件", page.flat.includes(".ap-list") === false && page.flat.includes(".ap-item") === false, page.flat.slice(0, 300));

  // ② 六个图标按钮，每个都有 title + aria-label；иконки — 4 глифа + 2 svg.
  const acts = outline(tree(), (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-act")).matched;
  eq("六个图标按钮", acts.length, 6);
  check(
    "每个按钮都有 title 与 aria-label（且两者相同）",
    acts.every((p) => typeof p.title === "string" && p.title !== "" && p["aria-label"] === p.title),
    JSON.stringify(acts.map((p) => [p.title, p["aria-label"]])),
  );
  check(
    "на кнопках только иконки: 4 глифа + 2 svg-документа",
    acts.filter((p) => typeof p.children === "string").length === 4
      && acts.filter((p) => typeof p.children === "object" && p.children !== null).length === 2,
    JSON.stringify(acts.map((p) => (typeof p.children === "string" ? p.children : "svg"))),
  );

  // ③ 四个分页，顺序固定，默认第一个。
  const tabs = outline(tree(), (p) => p.role === "tab").matched;
  eq("四个分页", tabs.length, 4);
  eq("分页顺序：名称 → 角色 → 记忆 → 提示词", tabs.map((p) => p.children).join(">"), "名称>角色>记忆>提示词");
  eq("默认选中第一个分页", tabs[0]?.["aria-selected"], "true");
  eq("其他分页都没被选中", tabs.slice(1).map((p) => p["aria-selected"]).join(","), "false,false,false");

  // ④ 页面底部没有说明块：元信息只在「?」展开后出现。
  eq("默认状态下页面上没有元信息块", outline(tree(), (p) => typeof p.className === "string" && p.className.includes("ap-meta")).matched.length, 0);
  check("说明按钮在页头", outline(tree(), (p) => p.className === "ap-help-btn").matched.length === 1);
  check("页面上没有页脚说明文字", page.flat.includes("存储位置") === false && page.flat.includes("注入统计") === false, page.flat.slice(-400));

  // ⑤ 编辑区分页各自带哪些字段（集合，不是顺序）。
  const openTab = (label) => outline(tree(), (p) => p.role === "tab" && p.children === label).matched[0].onClick();
  const labelsNow = () => outline(tree(), (p) => p.className === "ap-label").matched
    .map((p) => p.children)
    .filter((child) => typeof child === "string");
  eq("名称页没有角色/记忆的字段标签", labelsNow().join("|"), "配置列表");
  check("名称页里有图标与名称输入框", page.flat.includes("ap-icon-input") && page.flat.includes('value="通用助手"'));
  openTab("角色");
  await renderUntil(reg.component, (acc) => acc.flat.includes("性格特点"));
  eq("角色页的字段", labelsNow().join("|"), "配置列表|角色设定|性格特点|说话习惯|行为准则");
  openTab("记忆");
  await renderUntil(reg.component, (acc) => acc.flat.includes("记忆条目"));
  eq("记忆页的字段", labelsNow().join("|"), "配置列表|将记忆注入到每次会话|长期记忆摘要|记忆条目");
  openTab("提示词");
  await renderUntil(reg.component, (acc) => acc.flat.includes("注入内容预览"));
  eq("提示词页只有预览", labelsNow().join("|"), "配置列表");
  check("提示词页有预览按钮", page.flat.length > 0);
}

// ── 场景 17：删除的完整来回（确认 → 取消 / 确认 → 真的发命令）────
// 版面只决定「确认块画在哪」，行为仍是：取消什么都不发，确认才发一次
// `profile.delete`。这两条分开验，否则「画出来了」会被当成「删掉了」。
{
  const sent = [];
  const twoProfiles = {
    activeId: "p-1",
    profiles: serverState.profiles.slice(0, 2),
  };
  currentFetch = (url, options) => {
    const text = String(url);
    if (text.includes("/__ap/state")) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: twoProfiles, meta: serverMeta }) });
    }
    if (text.includes("/__ap/command")) {
      const op = JSON.parse(options.body);
      sent.push(op);
      if (op.op === "profile.delete") {
        return Promise.resolve({
          json: () => Promise.resolve({
            ok: true,
            state: { activeId: "p-2", profiles: [twoProfiles.profiles[1]] },
            meta: serverMeta,
          }),
        });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: twoProfiles, meta: serverMeta }) });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  const tree = () => callComponent(reg.component, {}).tree;
  const byAction = (action) => outline(tree(), (p) => p["data-ap"] === action).matched[0];

  // ① 取消：确认块消失，什么都没发。
  byAction("delete").onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-confirm-inline"));
  outline(tree(), (p) => p.className === "ap-btn" && p.children === "取消").matched[0].onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-confirm-inline") === false);
  eq("取消删除没有发出任何命令", sent.length, 0);

  // ② 确认：发一次 profile.delete，删的就是当前选中的那套。
  byAction("delete").onClick();
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-confirm-inline"));
  const confirmNode = outline(tree(), (p) => p.className === "ap-btn ap-btn-primary" && p.children === "删除").matched[0];
  check("确认块里的动作按钮是「删除」", confirmNode !== undefined, JSON.stringify(outline(tree(), (p) => p.className === "ap-btn").matched.map((p) => p.children)));
  confirmNode?.onClick();
  // 判据要等**状态回填**：确认块在点下去的那一刻就消失，删除结果还要等一轮 fetch。
  const after = await renderUntil(reg.component, (acc) => acc.flat.includes("通用助手") === false, 2500);
  eq("只发了一条命令", sent.length, 1);
  eq("命令就是删除那套配置", JSON.stringify(sent[0]), JSON.stringify({ op: "profile.delete", id: "p-1" }));
  check("删完确认块没了", after.flat.includes("ap-confirm-inline") === false);
  check("删掉的配置不再出现在选择器里", after.flat.includes("通用助手") === false, after.flat.slice(0, 400));
  check("删除后没有被错误边界兜住", after.boundaryCaught === null, String(after.boundaryCaught));
}

// ── 场景 18：фиксированные три строки и подсказки на трёх языках ──
// Требование пользователя: селект **не растёт** при большом числе профилей,
// у каждой кнопки есть подсказка текстом из словаря, а порядок кнопок в строке
// один и тот же независимо от языка.
{
  const manyProfiles = Array.from({ length: 8 }, (_, index) => ({
    id: `p-${index + 1}`,
    name: index === 0 ? "Первый" : `Профиль ${index + 1}`,
    icon: "🤖",
    role: "",
    personality: "",
    speech: "",
    rules: "",
    memorySummary: "",
    injectMemory: true,
    memories: [],
    createdAt: 1,
    updatedAt: 1,
  }));

  const TIPS = {
    zh: {
      new: "新建一套配置",
      duplicate: "复制当前这套配置",
      import: "从 JSON 文件导入配置",
      export: "把全部配置导出为 JSON 文件",
      restore: "把当前这套配置的字段恢复成默认值",
      delete: "删除当前这套配置",
    },
    en: {
      new: "Create a new profile",
      duplicate: "Copy the current profile",
      import: "Import profiles from a JSON file",
      export: "Export every profile to a JSON file",
      restore: "Reset the current profile's fields to their defaults",
      delete: "Delete the current profile",
    },
    ru: {
      new: "Создать новый профиль",
      duplicate: "Скопировать текущий профиль",
      import: "Импортировать профили из файла JSON",
      export: "Экспортировать все профили в файл JSON",
      restore: "Сбросить поля текущего профиля к значениям по умолчанию",
      delete: "Удалить текущий профиль",
    },
  };
  const ORDER = ["new", "duplicate", "delete", "import", "export", "restore"];

  for (const lang of ["zh", "en", "ru"]) {
    activeLocale = lang;
    const state = { activeId: "p-1", profiles: manyProfiles };
    currentFetch = (url) => {
      if (String(url).includes("/__ap/state")) {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, state, meta: serverMeta }) });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    };
    const client = await loadClient();
    const reg = client.registrations.find((r) => r.key === "settings.section");
    await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
    const tree = () => callComponent(reg.component, {}).tree;

    // ⚠ ищем именно <select>: у обёртки .ap-picker-col тоже есть "ap-picker" в классе.
    const picker = outline(tree(), (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-picker")).matched[0];
    eq(`${lang}: 8 профилей — size всё равно 3 (не растёт)`, picker?.size, 3);
    eq(`${lang}: в селекте все 8 профилей`, picker?.children?.length, 8);

    eq(
      `${lang}: порядок кнопок в строке`,
      outline(tree(), (p) => p["data-ap"] !== undefined).matched.map((p) => p["data-ap"]).join(","),
      ORDER.join(","),
    );

    const isTip = (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-tip");
    for (const action of ORDER) {
      const btn = () => outline(tree(), (p) => p["data-ap"] === action).matched[0];
      btn().onMouseEnter();
      const tips = outline(tree(), isTip).matched;
      eq(`${lang}: подсказка «${action}» — одна и из словаря`, tips.length === 1 ? tips[0].children : `tips=${tips.length}`, TIPS[lang][action]);
      eq(`${lang}: aria-describedby у «${action}»`, btn()["aria-describedby"], `ap-tip-${action}`);
      btn().onMouseLeave();
      eq(`${lang}: после ухода курсора подсказок нет (${action})`, outline(tree(), isTip).matched.length, 0);
    }

    if (lang !== "zh") {
      const allTips = ORDER.map((action) => TIPS[lang][action]).join(" ");
      check(`${lang}: подсказки без CJK`, !/[\u3000-\u303f\u4e00-\u9fff\uff01-\uff60]/u.test(allTips), allTips);
    }
  }

  // 1 профиль — высота всё равно как под три строки (форма не прыгает).
  activeLocale = "zh";
  const single = { activeId: "p-1", profiles: [manyProfiles[0]] };
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: single, meta: serverMeta }) });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  const picker = outline(callComponent(reg.component, {}).tree, (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-picker")).matched[0];
  eq("один профиль — size тоже 3", picker?.size, 3);
  const del = outline(callComponent(reg.component, {}).tree, (p) => p["data-ap"] === "delete").matched[0];
  eq("последний профиль удалить нельзя", del?.disabled, true);
}

// ── 场景 19：колонки ровно в высоту селекта (по стилям, не по пикселям) ──
// Пиксели мерить нечем и незачем: важно, что высота строки задана **одной
// переменной** и что обе колонки (селект и кнопки) берут её же, а три кнопки
// делят её поровну. Это и есть «низ колонки совпадает с низом селекта».
{
  // исходник читаем относительно этого файла: тест не должен зависеть от cwd
  const css = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const rule = (selector) => {
    const at = css.indexOf(selector + " {");
    if (at === -1) return "";
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  };

  const top = rule(".ap-top");
  check("строка объявляет высоту строки одной переменной --ap-row-h", /--ap-row-h:\s*[\d.]+em/u.test(top), top);
  check("строка объявляет фиксированную ширину колонки --ap-col-w", /--ap-col-w:\s*[\d.]+px/u.test(top), top);

  const picker = rule(".ap-picker");
  check("селект берёт высоту из --ap-row-h", picker.includes("height: var(--ap-row-h)"), picker);
  check("селект скроллит внутри, а не растёт", picker.includes("overflow-y: auto"), picker);

  const actions = rule(".ap-actions");
  check("колонка кнопок берёт ту же высоту --ap-row-h", actions.includes("height: var(--ap-row-h)"), actions);
  check("колонка кнопок фиксированной ширины --ap-col-w", actions.includes("width: var(--ap-col-w)"), actions);
  check("колонка — вертикальный flex", actions.includes("flex-direction: column"), actions);

  const wrap = rule(".ap-act-wrap");
  check("три кнопки делят высоту поровну (flex: 1 1 0)", wrap.includes("flex: 1 1 0"), wrap);
  const act = rule(".ap-act");
  check("кнопка растягивается на свою треть (height: 100%)", act.includes("height: 100%"), act);
  check("кнопка на всю ширину колонки", act.includes("width: 100%"), act);

  check("левая колонка растёт вправо (start)", rule(".ap-tip-start").includes("left: 0") && rule(".ap-tip-start").includes("right: auto"), rule(".ap-tip-start"));
  check("правая колонка растёт влево (end)", rule(".ap-tip-end").includes("right: 0") && rule(".ap-tip-end").includes("left: auto"), rule(".ap-tip-end"));
  check("подтверждение удаления стоит ниже строки, а не внутри неё", rule(".ap-confirm-inline").includes("margin-top"), rule(".ap-confirm-inline"));
}

// ── 场景 20：сторона тултипов и равенство колонок в DOM ──
{
  activeLocale = "zh";
  currentFetch = (url) => {
    if (String(url).includes("/__ap/state")) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: serverState, meta: serverMeta }) });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  const tree = () => callComponent(reg.component, {}).tree;
  const byAction = (action) => outline(tree(), (p) => p["data-ap"] === action).matched[0];
  const isTip = (p) => typeof p.className === "string" && p.className.split(" ").includes("ap-tip");

  byAction("new").onMouseEnter();
  eq("левая колонка: подсказка у левого края", outline(tree(), isTip).matched[0]?.className, "ap-tip ap-tip-start");
  byAction("new").onMouseLeave();

  byAction("export").onMouseEnter();
  eq("правая колонка: подсказка у правого края", outline(tree(), isTip).matched[0]?.className, "ap-tip ap-tip-end");
  byAction("export").onMouseLeave();

  // Дерево здесь начинается с компонента-обёртки (класс), поэтому обход
  // по узлам до колонок не доходит — считаем по плоскому отпечатку страницы.
  const flat = outline(tree(), () => false).flat;
  const leftAt = flat.indexOf(".ap-actions.ap-actions-left");
  const selectAt = flat.indexOf("<select");
  const rightAt = flat.indexOf(".ap-actions.ap-actions-right");
  check("две колонки: слева и справа от селекта", leftAt !== -1 && rightAt !== -1 && leftAt < selectAt && selectAt < rightAt, [leftAt, selectAt, rightAt].join(","));
  const wraps = (from, to) => flat.slice(from, to).match(/ap-act-wrap/g)?.length ?? 0;
  eq("в левой колонке три кнопки", wraps(leftAt, selectAt), 3);
  eq("в правой колонке три кнопки", wraps(rightAt), 3);
}

// ── 场景 21：кнопка «обновить» сбрасывает только текущий профиль ──
// Смысл кнопки изменился: раньше она сносила все配置 и привязки диалогов,
// теперь — только поля выбранной конфигурации. Проверяем и текст, и запрос.
{
  const sent = [];
  const state = {
    activeId: "p-1",
    profiles: serverState.profiles.map((profile) => Object.assign({}, profile)),
  };
  currentFetch = (url, options) => {
    const text = String(url);
    if (text.includes("/__ap/state")) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state, meta: serverMeta }) });
    }
    if (text.includes("/__ap/command")) {
      const op = JSON.parse(options.body);
      sent.push(op);
      if (op.op === "state.restoreDefaults") {
        // сервер вернёт ту же конфигурацию с другими полями; id тот же
        state.profiles[0] = Object.assign({}, state.profiles[0], { name: "通用助手", role: "默认角色" });
      }
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, state, meta: serverMeta }) });
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  activeLocale = "zh";
  const client = await loadClient();
  const reg = client.registrations.find((r) => r.key === "settings.section");
  await renderUntil(reg.component, (acc) => acc.flat.includes("ap-icon-input"), 2500);
  const tree = () => callComponent(reg.component, {}).tree;
  const byAction = (action) => outline(tree(), (p) => p["data-ap"] === action).matched[0];

  byAction("restore").onClick();
  const confirming = await renderUntil(reg.component, (acc) => acc.flat.includes("恢复成默认值"));
  check("подтверждение называет профиль", confirming.flat.includes("把「通用助手」这套配置的字段恢复成默认值？"), confirming.flat.slice(0, 600));
  check("в подтверждении нет «все конфигурации»", !/全部配置|所有配置|替换/.test(confirming.flat), confirming.flat.slice(0, 600));
  check("подтверждение говорит, что сам профиль остаётся", confirming.flat.includes("配置本身留着"), confirming.flat.slice(0, 600));
  const yes = outline(tree(), (p) => p.className === "ap-btn ap-btn-primary" && p.children === "是的，重置").matched[0];
  check("кнопка действия — «是的，重置»", yes !== undefined, JSON.stringify(outline(tree(), (p) => p.className === "ap-btn").matched.map((p) => p.children)));

  yes?.onClick();
  // ⚠ ждём именно уведомление: фраза «恢复成默认值» есть и в подтверждении,
  //   и в уведомлении, поэтому «фразы нет» как критерий не годится.
  const done = await renderUntil(reg.component, (acc) => acc.flat.includes("已把「通用助手」的字段恢复成默认值。"), 2500);
  eq("ушёл один запрос", sent.length, 1);
  eq("сброс идёт по id профиля и с языком", JSON.stringify(sent[0]), JSON.stringify({ op: "state.restoreDefaults", id: "p-1", lang: "zh" }));
  check("уведомление содержит имя профиля", done.flat.includes("已把「通用助手」的字段恢复成默认值。"), done.flat.slice(0, 800));
  check("уведомление не говорит «все конфигурации»", !/全部配置|所有配置/.test(done.flat), done.flat.slice(0, 800));
  check("все три配置 на месте", done.flat.includes("通用助手") && done.flat.includes("编程助手") && done.flat.includes("写作教练"), done.flat.slice(0, 400));
  eq("выбор остался на сброшенном профиле", outline(tree(), (p) => p.className === "ap-select ap-picker").matched[0]?.value, "p-1");
  check("после сброса нет «несохранённых изменений»", !done.flat.includes("有未保存改动"), done.flat.slice(0, 400));
}

// ── 结果 ────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`\nOK — ${passed} 项断言全部通过`);
  process.exit(0);
}
console.log(`\nFAIL — ${passed} 项通过，${failures.length} 项失败：`);
for (const line of failures) console.log(`  ✗ ${line}`);
process.exit(1);
