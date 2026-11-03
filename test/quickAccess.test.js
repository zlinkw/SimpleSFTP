const assert = require("node:assert/strict");
const test = require("node:test");
const { ACTIONS, SHOW_KEY, ITEMS_KEY, registerQuickAccess } = require("../quick-access");
const pkg = require("../package.json");

function fixture(answers = [], initial = {}, failSave = false) {
  const values = new Map(Object.entries(initial)), writes = [], executed = [], prompts = [], errors = [], commands = new Map();
  let listener;
  const context = { subscriptions: [] };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: namespace => {
        assert.equal(namespace, "simpleSftp");
        return {
          get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
          update: async (key, value, target) => {
            if (failSave) throw new Error("写入被拒绝");
            writes.push({ key, value, target }); values.set(key, value);
          },
        };
      },
      onDidChangeConfiguration: fn => { listener = fn; return { dispose() {} }; },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (...args) => executed.push(args),
    },
    window: {
      showQuickPick: async (items, options) => {
        prompts.push({ items, options });
        const answer = answers.shift();
        return typeof answer === "function" ? answer(items, options) : answer;
      },
      showErrorMessage: async text => errors.push(text),
    },
  };
  const controller = registerQuickAccess(vscode, context);
  const buttons = ACTIONS.map(action => {
    const button = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; } };
    controller.track(button, action.command); return button;
  });
  return { values, writes, executed, prompts, errors, buttons, context,
    changed: () => listener({ affectsConfiguration: key => key === "simpleSftp.快捷入口" }),
    open: () => commands.get("simpleSftp.openQuickAccessSettings")() };
}

test("all five existing buttons default on and respond to user settings without changing commands", () => {
  const f = fixture();
  assert.deepEqual(ACTIONS.map(action => action.command), ["simpleSftp.selectServer", "simpleSftp.createOrOpen", "simpleSftp.syncFromRemote", "simpleSftp.markHandoffReady", "simpleSftp.configureDownloadScope"]);
  assert.equal(f.buttons.every(button => button.visible), true);
  f.values.set(SHOW_KEY, false); f.changed();
  assert.equal(f.buttons.some(button => button.visible), false);
  f.values.set(ITEMS_KEY, ["创建或打开项目"]); f.values.set(SHOW_KEY, true); f.changed();
  assert.deepEqual(f.buttons.map(button => button.visible), [false, true, false, false, false]);
  f.values.set(ITEMS_KEY, []); f.changed();
  assert.equal(f.buttons.some(button => button.visible), false);
  assert.deepEqual(f.executed, []);
});

test("settings can hide all buttons and later restore the saved individual selection", async () => {
  const f = fixture([items => items.find(item => item.action === "toggle"), undefined], { [ITEMS_KEY]: ["选择服务器"] });
  await f.open();
  assert.deepEqual(f.writes, [{ key: SHOW_KEY, value: false, target: 1 }]);
  assert.equal(f.buttons.some(button => button.visible), false);
  f.values.set(SHOW_KEY, true); f.changed();
  assert.deepEqual(f.buttons.map(button => button.visible), [true, false, false, false, false]);
});

test("individual selection saves Chinese options globally; cancelling does not save and empty selection is valid", async () => {
  for (const selected of [undefined, [], [{ label: "远端同步到本地" }]]) {
    const f = fixture([items => items.find(item => item.action === "items"), selected, undefined]);
    await f.open();
    assert.equal(f.prompts[1].options.canPickMany, true);
    assert.equal(f.prompts[1].items.every(item => item.picked), true);
    assert.deepEqual(f.writes, selected === undefined ? [] : [{ key: ITEMS_KEY, value: selected.map(item => item.label), target: 1 }]);
  }
});

test("each shortcut opens only the native editor filtered to the exact existing command", async () => {
  for (const action of ACTIONS) {
    const f = fixture([items => items.find(item => item.action === "shortcuts"), items => items.find(item => item.command === action.command), undefined]);
    await f.open();
    assert.deepEqual(f.executed, [["workbench.action.openGlobalKeybindings", "@command:" + action.command]]);
    assert.equal(f.prompts.length, 2, "keyboard editor must keep focus without reopening the settings picker");
    assert.deepEqual(f.writes, []);
    assert.match(f.prompts[1].options.placeHolder, /不会执行/);
  }
  const cancelled = fixture([items => items.find(item => item.action === "shortcuts"), undefined, undefined]);
  await cancelled.open(); assert.deepEqual(cancelled.executed, []);
});

test("save errors are visible and leave the prior display setting intact", async () => {
  const f = fixture([items => items.find(item => item.action === "toggle")], {}, true);
  await f.open(); assert.deepEqual(f.writes, []);
  assert.equal(f.buttons.every(button => button.visible), true);
  assert.match(f.errors[0], /设置失败：写入被拒绝/);
});

test("settings labels, values and navigation are Chinese and remain available with hidden buttons", async () => {
  const properties = pkg.contributes.configuration.properties;
  assert.equal(properties["simpleSftp." + SHOW_KEY].default, true);
  assert.deepEqual(properties["simpleSftp." + ITEMS_KEY].default, ACTIONS.map(action => action.label));
  for (const key of [SHOW_KEY, ITEMS_KEY]) {
    assert.match(key, /[\u4e00-\u9fff]/);
    assert.equal(properties["simpleSftp." + key].scope, "application");
    assert.match(properties["simpleSftp." + key].description, /[\u4e00-\u9fff]/);
  }
  const f = fixture([items => items.find(item => item.action === "settings")], { [SHOW_KEY]: false });
  await f.open();
  assert.deepEqual(f.executed, [["workbench.action.openSettings", "simpleSftp.快捷入口"]]);
  assert.equal(f.prompts[0].items.every(item => /[\u4e00-\u9fff]/.test(item.label + item.description)), true);
  assert.ok(pkg.contributes.commands.some(item => item.command === "simpleSftp.openQuickAccessSettings" && item.title.includes("快捷入口与快捷键设置")));
  assert.ok(pkg.files.includes("quick-access.js"));
});
