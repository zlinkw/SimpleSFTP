"use strict";

const SHOW_KEY = "快捷入口.显示底部按钮";
const ITEMS_KEY = "快捷入口.显示的按钮";
const ACTIONS = Object.freeze([
  { label: "选择服务器", command: "simpleSftp.selectServer" },
  { label: "创建或打开项目", command: "simpleSftp.createOrOpen" },
  { label: "远端同步到本地", command: "simpleSftp.syncFromRemote" },
  { label: "上传并标记交接", command: "simpleSftp.markHandoffReady" },
  { label: "设置下载文件范围", command: "simpleSftp.configureDownloadScope" },
]);

function registerQuickAccess(vscode, context) {
  const buttons = new Map();
  const config = () => vscode.workspace.getConfiguration("simpleSftp");
  const enabledItems = () => config().get(ITEMS_KEY, ACTIONS.map(action => action.label));
  function refresh() {
    const enabled = config().get(SHOW_KEY, true);
    const items = enabledItems();
    for (const action of ACTIONS) {
      const button = buttons.get(action.command);
      if (button) {
        if (enabled && items.includes(action.label)) button.show();
        else button.hide();
      }
    }
  }
  async function chooseShortcut() {
    const action = await vscode.window.showQuickPick(ACTIONS.map(item => ({
      label: item.label, description: "设置、修改或移除对应的键盘快捷键", command: item.command,
    })), { title: "SimpleSFTP：设置键盘快捷键", placeHolder: "选择操作后，在快捷键编辑器中录入按键；不会执行该操作", ignoreFocusOut: true });
    if (action) await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "@command:" + action.command);
  }
  async function openSettings() {
    try {
      while (true) {
        const shown = config().get(SHOW_KEY, true);
        const choice = await vscode.window.showQuickPick([
          { label: "底部快捷按钮：" + (shown ? "已开启" : "已关闭"), description: shown ? "点击关闭全部底部按钮，命令和快捷键仍可使用" : "点击开启，按已保存的逐项选择显示", action: "toggle" },
          { label: "选择显示的底部按钮", description: "分别控制服务器、项目、同步、交接和下载范围按钮", action: "items" },
          { label: "设置键盘快捷键", description: "为对应操作录入、修改或移除按键，使用编辑器处理冲突", action: "shortcuts" },
          { label: "打开完整设置", description: "查看中文的底部按钮开关与显示列表", action: "settings" },
        ], { title: "SimpleSFTP：快捷入口与快捷键设置", placeHolder: "设置保存到本机用户级，所有窗口共用；默认显示全部按钮", ignoreFocusOut: true });
        if (!choice) return;
        if (choice.action === "toggle") await config().update(SHOW_KEY, !shown, vscode.ConfigurationTarget.Global);
        else if (choice.action === "items") {
          const items = enabledItems();
          const selected = await vscode.window.showQuickPick(ACTIONS.map(action => ({
            label: action.label, picked: items.includes(action.label),
          })), { title: "SimpleSFTP：选择显示的底部按钮", placeHolder: "勾选需要显示的按钮；全部取消可隐藏全部，确认后保存", canPickMany: true, ignoreFocusOut: true });
          if (selected !== undefined) await config().update(ITEMS_KEY, selected.map(item => item.label), vscode.ConfigurationTarget.Global);
        } else if (choice.action === "shortcuts") {
          await chooseShortcut();
          return;
        } else if (choice.action === "settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "simpleSftp.快捷入口");
          return;
        }
        refresh();
      }
    } catch (error) {
      await vscode.window.showErrorMessage("SimpleSFTP 快捷入口设置失败：" + error.message + "。未成功保存的设置不会生效，可重新打开设置重试。");
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("simpleSftp.openQuickAccessSettings", openSettings),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("simpleSftp.快捷入口")) refresh();
    }),
    { dispose: () => buttons.clear() }
  );
  return {
    track(button, command) { buttons.set(command, button); refresh(); return button; },
  };
}

module.exports = { ACTIONS, SHOW_KEY, ITEMS_KEY, registerQuickAccess };
