# 受管清理的主动核实

`files.cleanup.preview` 显式选择 `observationMode: managed_tmux` 后，远端操作由精确 operationId 绑定的独立 tmux 窗口执行；本机操作按实际文件系统核实。
默认文件操作兼容行为不变。预览不部署执行器或写操作日志；原路径、类型、内容、安全根和父目录保护及删除双确认保留。

`check/status/verify` 读取实际窗口及源/目标，不依赖执行响应或已保存的 completed/executing 状态。源已不存在且执行器结束的已授权删除可标为目标已清除，不声称一定由本次请求删除。移动还核对目标身份及内容；源被重建或目标变化须重新预览。

执行时仅在安全根 clean_dir/.operations/managed 下保留不可变确认输入与所用执行器代码，供审计；不将其作为活动状态。没有 PID 或 /proc 句柄扫描。精确父目录切换和 ./直接子项删除规则仍由原执行器执行。

清理检查附带所选产物目录内清单的最小关联字段和 SHA256；只读检查不复制权重或原始指标到本机。

验证：cleanupManaged.test.js 在隔离真实 tmux 和临时 CPU 夹具中验证丢失响应、移动、删除、源重建及清单关联；cleanupFiles.test.js 和 npm run build 保持默认行为回归。
未连接生产服务器，未清理研究资产。配套版本与发行在完整集成交付时确定。
