# Changelog

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
