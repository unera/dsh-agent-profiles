/**
 * Host 接线自测：拿假的 ctx 把 lib/index.js 跑起来，检查它**到底注册了什么**。
 *
 * ## 为什么必须有这个文件
 * 0.2.0 出过一次严重事故：per-agent 段落用 `agentCtx.effect(() => section(...))`
 * 注册，清理函数同步返回 undefined；宿主在 agent 销毁时拿注销器的返回值
 * `.catch()`，于是抛
 *   TypeError: Cannot read properties of undefined (reading 'catch')
 * 记成「agent/disposed listener threw」，表现为**会话不可用、会话从左侧列表消失**。
 *
 * 这类 bug 有三个要命的特点：
 *   1. 只在**销毁**时炸，注册那一刻一切正常；
 *   2. 错误信息里没有一个字提到插件；
 *   3. store/prompt/routes 的单测全都覆盖不到它。
 * 所以必须专门测「注册出来的东西长什么样」——尤其是**清理函数的返回值**。
 *
 * 用法：node test/host-wiring.test.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** 每个用例一份隔离的数据目录，免得互相看到对方写的 profiles.json。 */
function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-wiring-"));
  process.env.DSH_AGENT_PROFILES_DATA = dir;
  return dir;
}

/**
 * 造一个假 ctx 并 apply 一次插件。
 * 记录：注册的路由、tapIndex 变换、所有 effect、所有事件监听、所有 section。
 */
async function boot() {
  const sections = [];
  const listeners = new Map();
  const effects = [];
  const routes = [];
  const taps = [];
  const logs = [];

  /**
   * 假的 systemPrompt。
   *
   * ⚠ **必须模拟「同一层里同名段落会抛错」这条真实行为** ——
   *   否则「注册落错了作用域」这个 bug 在测试里永远显不出来。
   *   它就是这么漏过去的：每对话注入一直静默回落全局，
   *   宿主日志在喊 `already registered`，而测试全绿。
   */
  const makeSystemPrompt = (into, label) => ({
    label,
    section(section) {
      if (into.some((s) => s.name === section.name)) {
        throw new Error(
          `prompt section "${section.name}" is already registered ` +
            `(for a per-agent override, register through that agent's \`agent.ctx\` instead)`,
        );
      }
      into.push(section);
      // 真实实现返回 cordis 的 effect 注销器，同步调用返回 undefined。
      return () => undefined;
    },
  });

  const systemPrompt = makeSystemPrompt(sections, "plugin");

  /**
   * 假的 skills 服务：抓住 provider，并记录 `control.invalidate()` 被调了几次。
   */
  const providers = [];
  const invalidations = { count: 0 };
  const skillsService = {
    registerProvider(create) {
      const control = {
        signal: undefined,
        invalidate: () => {
          invalidations.count += 1;
        },
      };
      providers.push({ provider: create(control), control });
      return () => {};
    },
  };

  const ctx = {
    logger: {
      info: (m) => logs.push(["info", String(m)]),
      warn: (m) => logs.push(["warn", String(m)]),
      error: (m) => logs.push(["error", String(m)]),
    },
    get: (name) => {
      if (name === "systemPrompt") return systemPrompt;
      if (name === "skills") return skillsService;
      return undefined;
    },
    effect(fn) {
      // 记下「回调」和「回调产出的清理函数」两样：
      // 后者必须直接拿来用 —— 再调一次回调等于又注册一遍，
      // 真实宿主会以同名冲突拒绝（测试里也照此模拟）。
      const cleanup = fn();
      effects.push({ fn, cleanup });
      return typeof cleanup === "function" ? cleanup : () => {};
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return () => {};
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
      tapIndex(transform) {
        taps.push(transform);
        return () => {};
      },
    },
  };

  // 用带 query 的 import 拿全新模块实例（模块级状态才不会串味）
  // ⚠ 用 import.meta.url 定位，不用 path.resolve("lib/index.js") —— 后者看的是
  //    **当前工作目录**，从别处跑（CI、任务调度器）就会解析到不存在的位置。
  const url = new URL("../lib/index.js", import.meta.url).href;
  const mod = await import(`${url}?case=${Math.random().toString(36).slice(2)}`);
  mod.apply(ctx);

  return { mod, ctx, systemPrompt, sections, listeners, effects, routes, taps, logs, providers, invalidations };
}

// ── helpers: HTTP routes and section text ───────────────────
//
// The prompt injection is now ONE section whose text resolves the session from
// the assembly context (`{ agent: { id } }`, exactly what `assembleContextFor`
// passes in dsh-agent). No per-agent registration, no shadowing, no reliance on
// `agent/created` timing — so the tests drive the section the same way the host
// does: call `text(context)`.

function makeReq(options = {}) {
  const body = options.body;
  return {
    method: options.method ?? "GET",
    url: options.url ?? "/",
    headers: options.headers ?? { host: "localhost" },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, "utf8");
    },
  };
}
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers !== undefined) this.headers = headers;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      return this;
    },
  };
}
function routeHandler(w, url) {
  const target = String(url).split("?")[0];
  return w.routes.find((r) => r.path === target)?.handler ?? null;
}
async function callApi(w, method, url, body) {
  const handler = routeHandler(w, url);
  if (handler === null) throw new Error("no route handler registered");
  const res = makeRes();
  await handler(
    makeReq({ method, url, body: body === undefined ? undefined : JSON.stringify(body), headers: { host: "localhost", "content-type": "application/json" } }),
    res,
  );
  let parsed = null;
  try {
    parsed = res.body === "" ? null : JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed };
}
async function stateBodyOf(w) {
  const res = await callApi(w, "GET", "/__ap/state");
  return res.body ?? {};
}
async function stateOf(w) {
  const body = await stateBodyOf(w);
  return body.state ?? body;
}
/** Assembly context as the host builds it: `{ agent, scope, signal }`. */
function textFor(w, sessionId) {
  const context = sessionId === null ? {} : { agent: { id: sessionId }, scope: {} };
  return w.sections[0].text(context);
}

// ── ① wiring ────────────────────────────────────────────────
tempDataDir();
{
  const w = await boot();
  eq("registered exactly one prompt section", w.sections.length, 1);
  eq("section name", w.sections[0].name, "agent-profiles:persona");
  check("section order is finite", Number.isFinite(w.sections[0].order), String(w.sections[0].order));
  check("section text is a function", typeof w.sections[0].text === "function");
  eq("no agent/created listener is needed any more", (w.listeners.get("agent/created") ?? []).length, 0);
  eq("six routes", w.routes.length, 6);
  eq("one index tap", w.taps.length, 1);
  check("ready log", w.logs.some(([level, m]) => level === "info" && m.includes("就绪")), JSON.stringify(w.logs));
}

// ── ② effect cleanup must return a thenable (0.2.0 incident) ─
{
  const w = await boot();
  const cleanup = w.effects[0]?.cleanup;
  check("cleanup is a function", typeof cleanup === "function");
  const returned = cleanup();
  const isThenable = returned !== null && typeof returned === "object" && typeof returned.then === "function";
  check("cleanup returns a thenable", isThenable, String(returned));
}

// ── ③ no context → active profile ───────────────────────────
{
  const w = await boot();
  const state = await stateOf(w);
  const active = state.profiles.find((p) => p.id === state.activeId);
  const text = textFor(w, null);
  check("context-less render contains the active profile name", text.includes(active.name), text.slice(0, 200));
}

// ── ④ bound session renders ITS profile, not the active one ──
{
  const w = await boot();
  const state = await stateOf(w);
  const [first, second] = state.profiles;
  check("fixture has at least two profiles", state.profiles.length >= 2, String(state.profiles.length));
  const bound = second.id;
  const res = await callApi(w, "POST", "/__ap/command", {
    op: "session.set",
    sessionId: "session-bound-1",
    patch: { profileId: bound },
  });
  eq("bind accepted", res.status, 200);

  const boundText = textFor(w, "session-bound-1");
  check("bound session renders its own profile", boundText.includes(second.name), boundText.slice(0, 240));
  check("bound session does not render the active profile name", !boundText.includes(first.name), boundText.slice(0, 240));

  // switching the global active profile must not leak into the bound session
  await callApi(w, "POST", "/__ap/command", { op: "profile.activate", id: first.id });
  const afterSwitch = textFor(w, "session-bound-1");
  eq("bound session text is stable across active-profile switches", afterSwitch, boundText);
  const otherText = textFor(w, "session-unbound-1");
  check("unbound session follows the new active profile", otherText.includes(first.name), otherText.slice(0, 240));
}

// ── ⑤ the very first assembly of a brand-new session ────────
//
// The binding is in the store before anything renders (that is the case the
// live bug violated): the section must honour it immediately.
{
  const w = await boot();
  const state = await stateOf(w);
  const target = state.profiles[state.profiles.length - 1];
  await callApi(w, "POST", "/__ap/command", {
    op: "session.set",
    sessionId: "session-brand-new",
    patch: { profileId: target.id },
  });
  const first = textFor(w, "session-brand-new");
  check("first render already uses the binding", first.includes(target.name), first.slice(0, 240));
}

// ── ⑥ per-session note and memories still render ────────────
{
  const w = await boot();
  await callApi(w, "POST", "/__ap/command", {
    op: "session.set",
    sessionId: "session-extras",
    patch: { note: "只看方案，不写代码", memories: [{ text: "проект называется Кеша" }] },
  });
  const text = textFor(w, "session-extras");
  check("session note appears", text.includes("只看方案"), text.slice(0, 300));
  check("session memory appears", text.includes("проект называется Кеша"), text.slice(0, 300));
  const other = textFor(w, "session-other-extras");
  check("other sessions do not see that note", !other.includes("只看方案"), other.slice(0, 200));
}

// ── ⑦ escape hatch: no session scope at all ─────────────────
{
  const w = await boot();
  const state = await stateOf(w);
  const [first, second] = state.profiles;
  await callApi(w, "POST", "/__ap/command", {
    op: "session.set",
    sessionId: "session-escape",
    patch: { profileId: second.id },
  });
  process.env.DSH_AGENT_PROFILES_NO_SESSION_SCOPE = "1";
  try {
    const text = textFor(w, "session-escape");
    check("escape hatch falls back to the active profile", text.includes(first.name), text.slice(0, 200));
    check("escape hatch ignores the binding", !text.includes(second.name), text.slice(0, 200));
  } finally {
    delete process.env.DSH_AGENT_PROFILES_NO_SESSION_SCOPE;
  }
}

// ── ⑧ diagnostics counters actually move ────────────────────
{
  const w = await boot();
  const state = await stateOf(w);
  const second = state.profiles[1];
  await callApi(w, "POST", "/__ap/command", {
    op: "session.set",
    sessionId: "session-diag",
    patch: { profileId: second.id },
  });
  textFor(w, null);
  textFor(w, "session-diag");
  textFor(w, "session-diag");
  const diagBody = await stateBodyOf(w);
  const diag = diagBody?.meta?.diagnostics ?? null;
  check("state exposes diagnostics", diag !== null, "null");
  if (diag !== null) {
    check("rendersGlobal moved", diag.rendersGlobal >= 1, String(diag.rendersGlobal));
    check("rendersSession moved", diag.rendersSession >= 2, String(diag.rendersSession));
    eq("lastSessionId is the session", diag.lastSessionId, "session-diag");
    eq("scopedSessions counts distinct sessions", diag.scopedSessions, 1);
  }
}

// ── report ──────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✖ ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ host wiring: ${passed} checks passed`);
}
