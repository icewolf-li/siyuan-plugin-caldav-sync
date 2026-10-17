/** 隔离测试：只访问自己创建的随机端口 CalDAV 服务，思源使用内存 API 桩。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupBrowserDom, loadBuiltPlugin, settle } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".test-multi-server");
execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"),
  "src/core/sync.ts", "--outDir", out, "--module", "commonjs", "--target", "es2020",
  "--moduleResolution", "node", "--skipLibCheck", "--strict", "false"], { cwd: root, stdio: "inherit" });
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
const require = createRequire(import.meta.url);
const { CalStore, keyOf } = require(path.join(out, "store.js"));
const { SyncEngine } = require(path.join(out, "sync.js"));
const { DEFAULT_SETTINGS, creationCalendars, defaultCalendarFor } = require(path.join(out, "types.js"));
const { discoverCalendars } = require(path.join(out, "caldav.js"));
const { itemToNewICS, itemsFromICS } = require(path.join(out, "ics.js"));
const { resetSecretKey } = require(path.join(out, "secret.js"));
const copy = (x) => JSON.parse(JSON.stringify(x));
const xml = (x) => x.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log("  ✓ " + name); }

async function davServer(id) {
  const requests = [], resources = new Map();
  const auth = { username: id, password: id + "-password" };
  const expected = "Basic " + Buffer.from(auth.username + ":" + auth.password).toString("base64");
  const srv = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (status, data = "", headers = {}) => { res.writeHead(status, { "Content-Type": "application/xml", ...headers }); res.end(data); };
    if (req.headers.authorization !== expected) return send(401);
    if (req.method === "PUT") {
      if ((req.url.startsWith("/events/") && /BEGIN:VTODO/.test(body)) || (req.url.startsWith("/tasks/") && /BEGIN:VEVENT/.test(body))) return send(403);
      resources.set(req.url, body); return send(201, "", { ETag: '"version-1"' });
    }
    if (req.method === "DELETE") { resources.delete(req.url); return send(204); }
    const wrap = (s) => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${s}</d:multistatus>`;
    const response = (href, props, status = 200) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 ${status} OK</d:status></d:propstat></d:response>`;
    if (req.method === "PROPFIND") {
      if (/current-user-principal/.test(body)) return send(207, wrap(response("/", "<d:current-user-principal><d:href>/</d:href></d:current-user-principal>")));
      if (/calendar-home-set/.test(body)) return send(207, wrap(response("/", "<c:calendar-home-set><d:href>/</d:href></c:calendar-home-set>")));
      if (req.url === "/") {
        assert.match(body, /supported-calendar-component-set/);
        return send(207, wrap([
          ["events", '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>'],
          ["tasks", "<c:supported-calendar-component-set><c:comp name='VTODO'/></c:supported-calendar-component-set>"],
          ["unknown", ""],
          ["journal", '<c:supported-calendar-component-set><c:comp name="VJOURNAL"/></c:supported-calendar-component-set>']
        ].map(([name, caps]) => response(`/${name}/`, `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${id}-${name}</d:displayname>${caps}`)).join("")));
      }
      return send(207, wrap([...resources.keys()].filter((url) => url.startsWith(req.url)).map((url) => response(url, '<d:getetag>"version-1"</d:getetag>')).join("")));
    }
    if (req.method === "REPORT") {
      if ((req.url === "/events/" && /name="VTODO"/.test(body)) || (req.url === "/tasks/" && /name="VEVENT"/.test(body))) return send(403);
      return send(207, wrap([...resources.entries()].filter(([url]) => url.startsWith(req.url)).map(([url, raw]) => response(url, `<d:getetag>"version-1"</d:getetag><c:calendar-data>${xml(raw)}</c:calendar-data>`)).join("")));
    }
    send(405);
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  return { srv, base, auth, expected, requests, resources, close: () => new Promise((resolve) => { srv.closeAllConnections(); srv.close(resolve); }) };
}

const a = await davServer("alpha"), b = await davServer("beta");
let plugin;
try {
  let acals, bcals;
  await t("发现真实请求能力，区分 VEVENT / VTODO / 未声明 / 其他组件", async () => {
    acals = (await discoverCalendars(a.base, "direct", a.auth)).calendars;
    bcals = (await discoverCalendars(b.base, "direct", b.auth)).calendars;
    assert.deepEqual(acals.map((c) => [c.supportsEvent, c.supportsTodo]), [[true, false], [false, true], [undefined, undefined], [false, false]]);
  });
  await t("发现忽略失败 propstat 中的能力字段，缺失能力保持未知", async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/unknown/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:supported-calendar-component-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
    try {
      const c = (await discoverCalendars(a.base, "direct", a.auth, a.base)).calendars[0];
      assert.equal(c.supportsEvent, undefined); assert.equal(c.supportsTodo, undefined);
    } finally { globalThis.fetch = nativeFetch; }
  });
  await t("旧单服务器数据无损迁移并关联日历，密码仍可正常使用", async () => {
    const old = { settings: { ...copy(DEFAULT_SETTINGS), serverUrl: a.base, ...a.auth, calendars: copy(acals) }, items: [], sync: {} };
    const before = copy(old);
    const writes = [];
    const migrated = new CalStore({ loadData: async () => old, saveData: async (data) => { writes.push(copy(data)); } }); await migrated.load();
    await migrated.persist(); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(migrated.settings.servers[0].password, a.auth.password);
    assert.ok(migrated.settings.calendars.every((c) => c.serverId === "legacy"));
    assert.deepEqual(old, before, "加载迁移不能就地修改原始数据");
    assert.ok(writes.every((data) => (data.settings.servers || []).every((s) => s.password.startsWith("enc:v3:"))), "迁移期间异步保存不得写入明文服务器密码");
  });
  const settings = { ...copy(DEFAULT_SETTINGS), syncIntervalMin: 0,
    servers: [a, b].map((d, i) => ({ id: String(i), name: "Server " + i, serverUrl: d.base, ...d.auth, channel: "direct", calendarPath: "" })),
    calendars: [acals, bcals].flatMap((cals, i) => cals.map((c) => ({ ...c, serverId: String(i), enabled: !/unknown|journal/.test(c.url) }))) };
  settings.defaultEventCalendarUrl = acals[0].url;
  settings.defaultTodoCalendarUrl = bcals[1].url;
  let disk;
  const store = new CalStore({ loadData: async () => undefined, saveData: async (data) => { disk = copy(data); } });
  store.settings = copy(settings);
  const sync = new SyncEngine(store, () => "proxy"); // 必须使用各服务器独立的 direct 通道。
  const mk = (cal, kind = "event") => ({ uid: "same-uid", calendarUrl: cal.url, href: cal.url + "same.ics", kind, summary: "独立条目", allDay: false, start: kind === "event" ? "2026-10-18T10:00:00" : "", end: kind === "event" ? "2026-10-18T11:00:00" : undefined });
  await t("默认路径按类型选择，已禁用或不支持的默认路径自动回退", async () => {
    assert.equal(defaultCalendarFor(settings, "event").url, acals[0].url);
    assert.equal(defaultCalendarFor(settings, "todo").url, bcals[1].url);
    assert.ok(creationCalendars(settings, "todo").every((c) => c.supportsTodo));
    const draft = copy(settings); draft.calendars.find((c) => c.url === bcals[1].url).enabled = false;
    assert.equal(defaultCalendarFor(draft, "todo").url, acals[1].url);
    draft.defaultEventCalendarUrl = acals[1].url;
    assert.equal(defaultCalendarFor(draft, "event").url, acals[0].url);
  });
  await t("多服务器上传、全量拉取和删除分别使用所属账号与通道；重复 UID 共存", async () => {
    await sync.createItem(mk(acals[0])); await sync.createItem(mk(bcals[0])); await sync.createItem(mk(bcals[1], "todo"));
    assert.equal(store.getAll().length, 3);
    assert.ok(a.resources.has("/events/same.ics")); assert.ok(b.resources.has("/tasks/same.ics"));
    assert.ok(!/DTSTART|DUE|DTEND|DURATION/.test(b.resources.get("/tasks/same.ics")));
    const report = await sync.syncAll(); assert.equal(report.ok, true, report.errors.join(";"));
    assert.equal(store.getAll().length, 3);
    assert.ok(a.requests.every((r) => r.auth === a.expected)); assert.ok(b.requests.every((r) => r.auth === b.expected));
    const todo = store.get(keyOf(mk(bcals[1], "todo"))); await sync.removeItem(todo);
    assert.equal(b.resources.has("/tasks/same.ics"), false); assert.equal(a.resources.size, 1);
  });
  await t("一个服务器认证失败时，其他服务器仍可继续同步", async () => {
    store.settings.servers[0].password = "wrong";
    const report = await sync.syncAll(); assert.equal(report.ok, false);
    assert.ok(report.errors.some((x) => /alpha-events/.test(x)));
    store.settings.servers[0].password = a.auth.password;
  });
  await t("跨日历移动先上传目标再删除原件，缓存不残留原日历副本", async () => {
    await sync.removeItem(store.get(keyOf(mk(bcals[0]))));
    const source = copy(store.get(keyOf(mk(acals[0]))));
    const moved = { ...source, calendarUrl: bcals[0].url, href: bcals[0].url + "moved.ics", etag: undefined };
    await sync.updateItem(moved, source);
    assert.equal(a.resources.has("/events/same.ics"), false);
    assert.equal(b.resources.has("/events/moved.ics"), true);
    assert.equal(store.get(keyOf(source)), undefined);
  });
  await t("所有服务器密码加密保存，可重载；坏密文保存时原样保留", async () => {
    await store.persist(); assert.ok(disk.settings.servers.every((s) => s.password.startsWith("enc:v3:")));
    resetSecretKey();
    const reload = new CalStore({ loadData: async () => copy(disk), saveData: async () => {} }); await reload.load();
    assert.equal(reload.settings.servers[1].password, b.auth.password);
    const broken = copy(disk); broken.settings.servers[1].password = "enc:v3:broken";
    let written;
    const bad = new CalStore({ loadData: async () => broken, saveData: async (d) => { written = d; } }); await bad.load(); await bad.persist();
    assert.equal(written.settings.servers[1].password, "enc:v3:broken");
    assert.match(bad.serverCredentialsIssue("1"), /解不开/);
    bad.settings.servers[1].password = "reentered"; await bad.persist(); assert.notEqual(written.settings.servers[1].password, "enc:v3:broken");
  });
  await t("仅到期日和纯日期的 VTODO 往返不新增 DTSTART，提醒关联 DUE", async () => {
    const raw = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:due-only\r\nDUE;VALUE=DATE:20261020\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
    const item = itemsFromICS(raw, bcals[1].url, bcals[1].url + "due.ics")[0];
    assert.equal(item.start, ""); assert.equal(item.allDay, true);
    item.alarms = [{ minutesBefore: 60 }]; const serialized = itemToNewICS(item);
    assert.match(serialized, /DUE;VALUE=DATE:20261020/); assert.doesNotMatch(serialized, /DTSTART|DTEND/); assert.match(serialized, /TRIGGER;RELATED=END/);
  });

  setupBrowserDom();
  // 构建产物在内存思源桩中运行，不连接任何本机思源实例。
  const Mod = loadBuiltPlugin(); const Plugin = Mod.default || Mod;
  plugin = new Plugin({ app: { appId: "isolated-test" }, name: "siyuan-plugin-caldav-sync", i18n: {} }); await plugin.onload();
  plugin.store.settings = copy(settings);
  const dock = document.createElement("div"); document.body.appendChild(dock);
  const custom = { element: dock, data: {} }; globalThis.__syRegistrations.dock[0].init.call(custom, custom);
  const click = (el) => { assert.ok(el, "按钮必须存在"); el.dispatchEvent(new MouseEvent("click", { bubbles: true })); };
  const editor = () => document.querySelector(".caldav-editor");
  const field = (name) => editor().querySelector(`[data-f="${name}"]`);
  const closeEditor = async () => { click(editor().querySelector('[data-action="cancel"]')); await settle(); };
  await t("侧边栏区分新增日程/待办，选择兼容路径；待办默认无日期，可只设置到期日", async () => {
    click(dock.querySelector('[data-action="new-event"]')); assert.equal(field("calendar").value, acals[0].url);
    assert.ok(field("startDate").value && field("endDate").value);
    assert.equal(editor().querySelectorAll("[data-cal-url]").length, 2);
    field("summary").value = "两栏日程"; field("description").value = "日程备注第一行\n第二行";
    click(editor().querySelector('[data-action="save"]')); await settle(8);
    assert.equal(plugin.store.getAll().find((i) => i.summary === "两栏日程").description, "日程备注第一行\n第二行");
    click(dock.querySelector('[data-action="new-todo"]')); assert.equal(field("calendar").value, bcals[1].url);
    for (const name of ["startDate", "startTime", "endDate", "endTime"]) assert.equal(field(name).value, "");
    field("summary").value = "仅到期日的待办"; field("endDate").value = "2026-10-22";
    field("description").value = "待办右栏备注";
    click(editor().querySelector('[data-action="save"]')); await settle(8);
    const item = plugin.store.getAll().find((i) => i.summary === "仅到期日的待办");
    assert.ok(item); assert.equal(item.start, ""); assert.equal(item.end, "2026-10-22"); assert.equal(item.dirty, false);
    assert.equal(item.description, "待办右栏备注");
  });
  await t("侧边栏刷新按钮同步所有服务器，完成后恢复可点击状态", async () => {
    click(dock.querySelector('[data-action="refresh"]')); assert.equal(dock.querySelector('[data-action="refresh"]').disabled, true);
    await plugin.inflight; await settle(); assert.equal(dock.querySelector('[data-action="refresh"]').disabled, false);
  });
  const openSettings = async () => { plugin.openSetting(); await settle(); return document.querySelector(".caldav-settings"); };
  await t("设置页切换/新增/移除服务器和发现日历只修改草稿，取消不影响运行配置", async () => {
    const before = copy(plugin.store.settings), el = await openSettings();
    const select = el.querySelector('[data-s="servers"]'); assert.equal(select.options.length, 2);
    select.value = "1"; select.dispatchEvent(new Event("change"));
    assert.equal(el.querySelector('[data-s="server"]').value, b.base);
    assert.ok([...el.querySelectorAll(".caldav-set-cal")].every((row) => row.dataset.url.startsWith(b.base)));
    click(el.querySelector('[data-action="discover"]')); await settle(8);
    assert.equal(el.querySelectorAll(".caldav-set-cal").length, 4);
    click(el.querySelector('[data-action="add-server"]')); assert.equal(select.options.length, 3);
    click(el.querySelector('[data-action="remove-server"]')); assert.equal(select.options.length, 2);
    click(el.querySelector('[data-action="cancel"]')); await settle(); assert.deepEqual(copy(plugin.store.settings), before);
  });
  await t("保存各服务器配置、默认日程/待办路径，重开后保持选择", async () => {
    const el = await openSettings(); el.querySelector('[data-s="server-name"]').value = "我的服务器 A";
    el.querySelector('[data-s="default-event"]').value = bcals[0].url;
    el.querySelector('[data-s="default-todo"]').value = acals[1].url;
    click(el.querySelector('[data-action="save"]')); await settle(8);
    assert.equal(plugin.store.settings.servers[0].name, "我的服务器 A");
    assert.equal(plugin.store.settings.defaultTodoCalendarUrl, acals[1].url);
    click(dock.querySelector('[data-action="new-todo"]')); assert.equal(field("calendar").value, acals[1].url); await closeEditor();
    const reopened = await openSettings(); assert.equal(reopened.querySelector('[data-s="default-event"]').value, bcals[0].url);
    click(reopened.querySelector('[data-action="cancel"]')); await settle();
  });
  console.log(`[multi-server] ${passed} 项通过（临时 CalDAV 服务 + 内存思源桩）`);
} finally {
  plugin?.onunload();
  await Promise.all([a.close(), b.close()]);
}
