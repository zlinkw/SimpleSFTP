# SimpleSFTP 0.2.101

配套 SimpleExperiment 0.5.386 自动内容比较。`sync.projectInventory` 能力声明 `contentIdentity: 1`；真实哈希与 SQLite 命中均返回校验时的大小、mtime、ctime、device、inode 和 SHA256，便于消费方将摘要绑定本轮索引身份。缓存身份、主动 stat、文件读取前后校验和缺失/未知边界保持原机制。

metadataOnly 同时返回身份及纳秒修改时间/ctime 组成的逐文件版本，兼容没有 Agent 索引的读取，防止毫秒截断误复用。映射下载测试改为等待真实注入 SSH 创建，并在失败时等待旧传输结束，避免 Windows 文件校验较慢时相邻测试污染共享传输钩子；生产下载逻辑未改。

新增真实 Python 夹具：冷读取两文件计算两次，重复读取计算零次，改变一个文件仅计算一次；校验精确文件路径及返回身份。夹具仅在自己创建的临时目录内写入，不修改用户项目、服务器或实际产物。

串行完整回归 46 文件、288 项及 `npm run package` 91 项门禁通过。VSIX 身份、版本、universal 平台、26 个 ZIP 条目、23 个实际运行文件源字节和秘密排除通过。冻结包 `simple-sftp-0.2.101.vsix` 为 174409 bytes，SHA256 `2f62c2833bfddafdefcf79d8599580b859306923c8bb550f338619a61f66be2c`。远端稳定发行与安装回执完成后另记；不自动部署远端 Agent。
