# artifact-hardlink-publication-20261025 — 单问题契约与计划（Owner: qwen bf1588a2 承接 SFTP 侧）

## 故障与已证事实
- 现场（r61，SE 0.5.412+SimpleSFTP 0.2.109 同实例 PID45980，SE 仓证据 .review/se413-artifact-callers.md）：fpsync 发布 exit1 `ValueError: unsafe publication target`（staged-tar-receive.py receive:464；同契约第二处 :620 chunk 提交）。安装体与源 452872c2/948 仅 CRLF/LF 差异（normalize 同 SHA 40f9e759…），版本失配排除。
- 只读来源（消费项目零写入）：experiments/quality_composition.py:402-406 `pending=.{name}.{uuid}.pending; write_bytes; os.link(pending,target)`；experiments/plans/comparison/text_only.yaml:7/20 result_csv/expectedResults=`{output_dir}/test_results/job_metrics.csv` ⇒ consumer 目标合法存在 st_nlink=2（与 pending 别名共享 inode）。
- 现守卫（两处相同）：目标存在且（非 S_ISREG **或 st_nlink != 1**）→ 拒绝；随后 `os.replace` 仅替换目录项、从不写穿旧 inode ⇒ 合法多链接普通文件被误拒；历史/临时别名保留是 `os.replace` 天然语义。

## 边界（锁定单问题）
只允许：已存在 **S_ISREG 且 st_nlink≥1** 的发布叶子经原 os.replace。保持不动：nlink<1/非 regular/symlink/目录/FIFO/越界 manifest/O_NOFOLLOW 父目录/staging `.part`、journal、lock 的单链接条件/SHA 校验/两代槽/staleReport fail-closed/ACTIVE_TRANSFER/双确认清理/tar464 与 chunk620 同一契约。SE 零改动；不改重试/通知/foreignOnly；不放松任何删除确认。

## 步骤
A（本块，已完成待红）：副本 FF 至 94896331；仅扩 test/stagedSlotLifecycle.fixture.py + 同名 .test.js（同进程、真实生产 argv base64+tar stdin/receiveChunk 通道、Windows→WSL Ubuntu-Codex 项目既有 fixture，timeout 10s 不改；三个独立 identity 子根 tarcase/chunkcase/negcase 隔离两代槽与产物树）。场景：tar 正例（job_metrics.csv v1+`.job_metrics.csv.<uuid>.pending` os.link 对 → 发布 v2 成功、目标新 bytes 新 inode、pending 原 inode/原 bytes、nlink 2→1）；普通单链接对照；chunk 同契约正例；负例（目录目标、symlink 目标拒绝且原对象分毫未动）。0-link 不为假想路径扩 probe（文件系统无法呈现 nlink0 目录项，实现以 st_nlink<1 显式拒绝），理由记录 evidence。
B：原 host 以 Windows 正式 Node 入口对**当前生产守卫未改**跑 `node --test --test-force-exit --test-timeout 20000 test/stagedSlotLifecycle.test.js`，预期唯一新增合法硬链接断言红于 `unsafe publication target`（tar 正例首发；负例/对照/原有用例绿），保留原码与完整日志。
C（红确认后授权）：最小两处守卫 `target.st_nlink != 1` → `target.st_nlink < 1`（含一句注释：目录项原子替换、别名 inode 不写穿）；同测试转绿 + 受影响域；完整 `npm run package`（verify-runtime+test-serial+package-vsix，npm 无 pre/post，test-serial 清单由 host 单一去重展开，旧缓存复用不降验收）；版本下一可用（预期 0.2.110）仅 package/lock 与实际声明同步、host 确认。PR→审核→合并→发行安装走既有闭环，不直推 master。

## 停止条件
FF/遮蔽异常、负例语义需改动既有保护才能通过、红非 464/620 签名、slot/状态污染任何迹象 → 停报父，不自行扩范围或跨仓。

## 当前状态（r64 后）
- B 已完成（r64，原 host Native）：旧码正确红——fixture `published.returncode == 0` actual 1，前置 nlink2/同 inode 通过，真实 receiver 栈帧 661→464 `unsafe publication target`；同批次原生命周期/两代槽用例先绿，chunk/negative 因单红即停未抵达（不冒称已验证）。输入 pre/post 零差异。日志 /host/d/.../host-windows/a981d3a4-d99c-43fd-8ae0-d3f41dba57f5-stdout.log。
- C 已实施并冻结（本块，未提交）：staged-tar-receive.py 仅 tar 发布（现 :464）与 chunk 发布（现 :621）两处 `st_nlink != 1`→`< 1` 各附一行目录项原子替换注释；`not stat.S_ISREG`、except/FD/O_NOFOLLOW/fsync/os.replace 结构全保留；:50 ordinary(.part staging)与 :96 journal manifest 的单链接防护原样未动。版本 0.2.110 仅 package.json 1 处 + package-lock.json 2 处声明同步，依赖零漂移。测试输入沿用 r63b 冻结（fixture 8f5116d1…、test.js 6f280681…，断言/矩阵/超时零改动）。产品与 public docs 输入自此停写，等 Native 完整绿；绿后仅私有材料记录。
- 验收（父裁单一去重集合，host 执行）：先跑受影响 2 staged 文件（同输入未变则结果并入最终覆盖），再 serial-minus-package 集合去掉已跑 2 文件逐项同官方 argv/`--test-reporter=spec`/清 NODE_TEST_CONTEXT/20s/首失败停，最后完整强制 `npm run package`（其 30 文件一轮），按实际身份并集对账，不硬卡固定总数。

## r66 打包合规修正（必要交付范围，build-test-delivery 最小打包合规条款）
- 规范与违规：发行产物仅携带运行闭包+法律通知；r65 实际 VSIX `dc3072…`(220877B) 内 `extension/readme.md`=16302B 完整安装/配置/API/故障排查/开发指南，不能按 README 文件名列合法例外。extension.js grep README/readme/docs 无命中，无运行入口依赖。根因：scripts/package-vsix.js 直接 cwd=项目根调 vsce，pkg.files 白名单含 `readme.md` 条目（大小写不敏感命中源码 README.md）。
- 仅改 scripts/package-vsix.js：保留固定 `.writing` 槽检查、`--replace` 身份防护、spawn 参数（--no-dependencies/--out 绝对 .writing/--allow-missing-repository）、timeout 60000、结束后身份复核与 rename；vsce 改在 `os.tmpdir()` 新建临时组装目录运行——按当前 pkg.files 白名单逐条字节复制（跳过 README 槽）+ package.json，组装目录内生成真最小 readme.md（扩展名+现有 description+有效指南链接 https://github.com/zlinkw/SimpleSFTP#readme）。非目标：源 README.md 不改/不移/不删，不改名/不内嵌/不空壳，不改脚本其它部分、不加框架/泛化兼容、依赖零漂移；组装目录运行后保留不删。注意：源根另有 CHANGELOG.md（不在白名单）；若旧包经 vsce 自动附带而新包不再包含，属运行闭包外文档按政策不入包，以 Native 真实归档清单为准并在审核确认。
- 统计纠正（保留可靠绿，不为纠正重跑）：package.json 的 **package** 脚本=`verify-runtime && test-serial && package-vsix`，实际全 68 文件；此前"build 27+3"表述错误。r65 先跑 2+36 再 package 68 = 真实 106 文件执行、并集 68、38 重复——此前"无重复"声称撤回。此后最终候选只一次完整 `npm run package`，不另跑 38/68 重叠前置。
- 验证：无既有打包单测（父 grep test 中 package-vsix/vsce/README 无对应，installPolicy 仅安装锁），不为小元数据另造测试进程；由 Native 最终完整 package + 真实归档审计（实际读取包内 README 字节断言最小内容与有效指南链接、源码指南保留、全运行文件字节对齐同一冻结候选）作为现成行为验证。Linux 仅 node --check（EXIT=0）与身份核对，不跑产品/pack。
