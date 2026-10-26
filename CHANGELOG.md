# Changelog

## 0.2.111

- 隔离热路径只保留一次写前实时检查：改名前不再完整重读同一批固定清单名，改名后不再复查隔离副本顶层身份。完成依据如实表述为“原子不覆盖 rename 成功 + 移动当时源缺失确认 + 登记成功 + 持久完成回执”，回执不声称隔离副本内容被重新核验。唯一一次 renameat2(RENAME_NOREPLACE)（macOS renamex_np / Windows 无 REPLACE 移动）保持不变，跨设备与缺原语一律明确失败，绝不降级复制。
- 新增隔离完成回执（isolationCompletionProtocol=1）与能力上报 safety.backgroundIsolatedDelete=1（isolate 预览应答逐后端可检，SE 任一后端缺失即走旧降级链）：token/operationId、目标冻结身份、批次名、精确源相对路径与 destination、rename 成功、移动时 sourceMissing、登记成功与该节点移动阶段的执行者事实，随隔离登记、隔离窗口完成记录与 managed-observe 完成回显持久绑定；settle 修复登记不携带这些移动时字段（不得伪造）。登记或回执丢失仍按未知处理，沿用既有 settlement，不自动重发 rename。
- 新增 files.cleanup.isolatedMaintenanceDelete 后台删除入口：参数仅 { token, digest, targets:[{index, relativePath, destination}] }（targets 只做绑定校验），应答 state 仅 accepted/already_accepted/failed 并附可选 operationId，失败带可展示原因；accepted 只表示维护已受理，绝不表述为已删完。只接受已登记隔离 token+冻结摘要，删除集合完全由插件登记记录派生，不接受调用方提供或替换 destination；引擎逐条复核仅登记为 isolated 的 clean_dir/job-<48hex>/… 子树、路径逐条等值、入口身份绑定、安全根/父目录/链接/挂载防护，硬链接只解除隔离副本这一处名字，不删源路径、不碰 clean_dir/.operations 与 MANIFEST，不回滚已隔离产物。生命周期（受理/执行中/完成/失败/未知）持久记录，未知结果只用只读复检消解，绝不重复执行删除，重试不产生第二个删除执行器；引擎零变更事实的拒绝记 failed，其余记 unknown 交只读复检。本入口不带 consumerRoot：仅在插件进程台账内按冻结摘要等值定位，缺失明确报 PREVIEW_EXPIRED 不猜测归属，保留两次确认人工审核链。执行阶段不新增执行者查询，移动阶段的本节点事实即执行者证据。
- 后台维护删除不再长时间占用“传输忙”：经服务端路由登记的维护事实使其不计入阻断计数并走独立受限并发容量池；真实上传、下载、移动与隔离移动继续按写入计忙，隔离准入的保守失败关闭不变。维护行缺显式事实、客户端伪造参数一律无效。
- 兼容：旧 SE 在能力缺失时保持原链（两次确认人工审核、旧回执语义）不变；新 SE 按每个后端 isolate 应答的 safety.backgroundIsolatedDelete=1 逐一判定，任一后端缺失即整体走旧降级链并提示需更新插件。files.cleanup.* 既有请求/响应必填形状、token/journal 结构与确认流程语义未改动，新增字段均为附加，新入口参数不含任何新必填字段，旧 SE 与新插件共存不被打断。

## 0.2.85

- Read current path existence and immutable type without hashing file contents or reading old cleanup receipts. Query matching live tmux cleanup windows directly when requested; local executors use actual in-flight transfers.
- Preserve root, link and type validation. Absence, active execution and failed queries remain separate. Paired with SimpleExperiment 0.5.311; tests use temporary fixtures and isolated tmux only.

## 0.2.84

- File-tree and metadata reads no longer create durable transfer transactions or wait for historical uncertain read receipts. Keep existing writer and download settlement protections.
- Tree/stat probes use a bounded independent capacity pool, so empty directories do not wait behind large transfers or hashing. Provide sync.projectTreeState for a minimal existence/empty-directory check after a failed full read; never turn query or permission failures into absence.
- Enumerate genuine directory progress on stderr; stdout stays JSON. Report existing empty directories separately from missing paths. Include tmp/result while excluding other machine temporary state.
- Regressions use temporary directories, isolated tmux and synthetic endpoints only; no production cleanup, transfer or Agent deployment.

## 0.2.83

- Managed cleanup uses the complete, explicit host/user/port/project root across inspection, review, execution and active status queries. A second saved profile or active server selection no longer rejects a verified SSH alias/IP spelling.
- Retire Hub Agent deployment; keep Worker service ownership and exact tmux window management. Path double confirmation, canonical root/direct parent, fixed type and link protections remain.
- Regression uses synthetic endpoints only; no production transfers, deletion or Agent deployment.

## 0.2.67

- Canonicalize Windows drive and filename spelling aliases before freezing cleanup root/target identities. A lower-case VS Code workspace path no longer falsely reports ROOT_IDENTITY_CHANGED.
- Retain ancestor link/reparse, device, mount, type, fingerprint and direct-parent guards; no case relaxation on case-sensitive platforms. Read-only temporary fixtures only, no production cleanup.

## 0.2.66

- Add read-only frozen cleanup receipt checks and safe missing-target inspection for reconnect review. Checks do not acquire mutation leases, settle audit state or execute file operations.
- Advertise and bind the required readOnlyReceiptCheck safety capability. Changed roots, recreated sources and uncertain deletion receipts remain blocked; confirmed move settlement stays a separate operation.
- Validate temporary fixtures and mock nodes only; no production cleanup.

## 0.2.65

- Protect dirty tracked targets when the workspace is a subdirectory of a Git repository, including Git worktrees. Advertise and bind the required safety capability to cleanup previews.

## 0.2.64

- Add frozen cleanup previews and separate exact-path confirmations, no-overwrite moves to clean_dir, guarded restore and fixed file/directory deletion executors.
- Validate canonical root/parent identity, hashes, handles, dirty tracked targets, mount/link boundaries and manifests; persist receipts, settle interrupted moves and refuse uncertain deletion receipts. Always exclude clean_dir from synchronization.
- Validate only temporary local fixtures and mock Workers; no production cleanup or live installation.

## 0.2.63

- Scope abandoned-transfer exit checks to the original producer and its process descendants. A different live producer's verified child transports no longer block legacy inventory reconciliation. Check creation times to distinguish reused PIDs and collect bounded process ancestry without command lines.
- Retain guards for the live original producer, original descendants, ambiguous or cyclic ancestry, incomplete censuses, remote writers and unverified settlement receipts.
- Add regressions for an old inventory alongside another Worker read, actual Windows login ancestry, PID reuse, live descendants and invalid process evidence.

## 0.2.62

- Allow independent live projectInventory, projectTree and projectFileStats requests for the same Worker/root. Multiple Plan preflight checks and background result scans keep separate operation identities and wait for existing transfer capacity without cancelling each other.
- Keep unknown receipts, older service generations, cancellation settlement, local output downloads and remote writers guarded. Explicit cancellation affects only its operation; reconciliation retains the stable target identity.
- Add regressions for four concurrent Plan checks on two Workers, the inventory API/capacity boundary, isolated cancellation and protected writer/unknown outcomes.

## 0.2.61

- Support verified exit reconciliation for abandoned projectInventory, projectTree and projectFileStats reads. Request identity, persisted read-only status, local owner/transport exit, and durable exit receipts are required; live requests and remote writers remain blocked.
- Advertise the supported reconciliation methods so SimpleExperiment can retain protection when connected to an older plugin.

## 0.2.42

- Added `sync.downloadMappedPaths`: one uncompressed remote tar stream carries every selected source-to-local mapping, then extraction writes each file to its own final path.
- Unsafe paths, symlinks, duplicate destinations, directories, weight files in a metrics batch, and files over the per-file limit are rejected before transfer. `sync.downloadPaths` stays path-identical.

## 0.2.18

- Removed the legacy configurable ignore command, API, state migration, and settings.
- Upload and download selection now use only their dedicated range controls; fixed safety exclusions remain internal.

## 0.2.17

- Replaced the visible ignore-rule entry with separate upload and download ranges in SimpleExperiment. Download ranges browse the remote project and persist selected paths, file types, and size limits per target.
- Remote-to-local sync now downloads only the configured range when one exists; legacy ignore handling remains available internally for existing configurations.

## 0.2.16

- Managed uploads now honor the caller's explicit file-type and size policy. Nested configuration files such as `data/datasets/*/recipe.yaml` are no longer rejected by a second hard-coded allowlist; project-boundary and plugin-state protections remain.

## 0.2.8

- Upload preview and execution now resolve the same server and remote directory. An explicit remote path overrides a saved server root; conflicting explicit paths or a changed target stop the upload before transfer.
- Server names in API requests resolve to saved profiles; unknown names fail instead of falling back to the active server.

## 0.2.7

- Replaced the Windows tar subprocess for managed uploads with a Node UTF-8/PAX tar writer; Chinese and long workspace paths no longer fail with `Can't convert a path to a wchar_t string`.

## 0.2.6

- Replaced large command-line file lists with a NUL-delimited temporary manifest passed to tar, added bounded chunk checksums, nested repository exclusion, and upload statistics.
- Added automatic read-only migration from legacy `zlk_cluster` managed state to `simple_cluster`, including target ignore state; malformed legacy files no longer block uploads.
- Added structured transfer diagnostics for timeout, cancellation, DNS/TCP, SSH authentication, forwarding, permissions, root validation, and other transport failures.
- Refreshed the public user guide and removed personal connection defaults.
