# Changelog

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
