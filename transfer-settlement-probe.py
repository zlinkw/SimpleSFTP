"""Bounded, read-only proof that the staged-transfer protocol has no writers.

No creation, deletion, signalling, or inference from file timestamps. Locks are
held during a complete same-user /proc census; unavailable evidence fails closed.
"""
import fcntl
import base64
import hashlib
import json
import os
import posixpath
import stat
import sys
import zlib

MAX_PIDS = 8192
MAX_COMMAND = 262144
TRANSFER_NAMES = {"tar", "ssh", "scp", "sftp", "sftp-server", "rsync", "gzip", "pigz", "zstd", "fpart", "fpsync"}
RECEIVER_LOADER = "import base64,zlib,sys; code=zlib.decompress(base64.b64decode(sys.argv[1])); sys.argv=sys.argv[1:]; exec(compile(code,'simple_sftp_staged_receive','exec'))"


class ActiveTransfer(RuntimeError):
    def __init__(self, pid, name, state, scope):
        super().__init__("REMOTE_TRANSFER_STILL_ACTIVE")
        # Never return command lines, embedded manifests, keys or credentials.
        self.blocker = {"pid": pid, "name": name[:32], "state": state, "scope": scope}


def process_identity(directory):
    value = read_bounded(directory + "/stat", 8192)
    fields = value[value.rfind(b")") + 2:].split()
    if len(fields) < 20 or fields[0] not in (b"R", b"S", b"D", b"Z", b"T", b"t", b"X", b"x", b"K", b"W", b"P", b"I"):
        raise RuntimeError("PROCESS_CENSUS_UNAVAILABLE")
    return fields[0].decode("ascii"), int(fields[19])


def ssh_forward_only(args):
    """Prove OpenSSH cannot execute a remote command; ambiguous options block."""
    no_command, index = False, 1
    switches = "1246AaCfgKkNnqsTtVvXxYy"
    valued = "BbcDEeFIiJLlmpQRSWw"
    while index < len(args):
        arg = args[index]
        if arg == "--":
            index += 1
            break
        if not arg.startswith("-") or arg == "-":
            break
        flags, offset = arg[1:], 0
        while offset < len(flags):
            flag = flags[offset]
            if flag in switches:
                no_command = no_command or flag == "N"
                offset += 1
                continue
            if flag in valued or flag == "o":
                value = flags[offset + 1:]
                if not value:
                    index += 1
                    if index >= len(args):
                        return False
                    value = args[index]
                if flag == "S" or (flag == "o" and value.lower().replace(" ", "").startswith(("controlmaster", "controlpath"))):
                    return False  # A multiplex master can serve other commands.
                offset = len(flags)
                continue
            return False
        index += 1
    return no_command and len(args) - index == 1


def inflate_bounded(encoded, window, limit):
    compressed = base64.b64decode(encoded, validate=True)
    decompressor = zlib.decompressobj(window)
    value = decompressor.decompress(compressed, limit + 1)
    if len(value) > limit or not decompressor.eof or decompressor.unused_data:
        raise ValueError("invalid bounded payload")
    return value


def receiver_root(args, receiver_hash):
    # Only the exact packaged Python program is safe to scope by its manifest.
    # Shell/SSH wrappers, changed code and malformed payloads remain ambiguous.
    if len(args) != 5 or not python_name(posixpath.basename(args[0])) or args[1:3] != ["-c", RECEIVER_LOADER]:
        return None
    try:
        code = inflate_bounded(args[3], zlib.MAX_WBITS, 131072)
        if not receiver_hash or hashlib.sha256(code).hexdigest() != receiver_hash:
            return None
        request = json.loads(inflate_bounded(args[4], -zlib.MAX_WBITS, 65536))
        root = request["root"]
        if not isinstance(root, str) or not root.startswith("/") or root == "/" or "\0" in root or posixpath.normpath(root) != root:
            return None
        # The writer canonicalizes the path itself; reject aliased roots here.
        if os.path.realpath(root) != root:
            return None
        return root
    except (ValueError, KeyError, TypeError, zlib.error):
        return None


def roots_overlap(left, right):
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def python_name(name):
    return name == "python" or (name.startswith("python3") and all(char in ".0123456789" for char in name[7:]))


def read_bounded(path, limit):
    with open(path, "rb") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise RuntimeError("PROCESS_CENSUS_LIMIT")
    return value


def ancestors():
    excluded, pid = set(), os.getpid()
    for _ in range(64):
        if pid <= 0 or pid in excluded:
            return excluded
        excluded.add(pid)
        value = read_bounded("/proc/%d/stat" % pid, 8192)
        pid = int(value[value.rfind(b")") + 2:].split()[1])
    raise RuntimeError("PROCESS_ANCESTRY_LIMIT")


def process_census(root, receiver_hash=""):
    # hidepid=4 can conceal a same-user receiver, so this is not full evidence.
    mounts = read_bounded("/proc/self/mountinfo", 1048576)
    if b"hidepid=4" in mounts or b"hidepid=ptraceable" in mounts:
        raise RuntimeError("PROCESS_CENSUS_UNAVAILABLE")
    excluded, uid = ancestors(), os.getuid()
    entries = [entry for entry in os.listdir("/proc") if entry.isdigit()]
    if len(entries) > MAX_PIDS:
        raise RuntimeError("PROCESS_CENSUS_LIMIT")
    inspected = 0
    for entry in entries:
        pid = int(entry)
        if pid in excluded:
            continue
        directory = "/proc/" + entry
        try:
            if os.stat(directory).st_uid != uid:
                # A nondumpable same-user process can have a root-owned /proc
                # directory. Consult real/effective UID before excluding it.
                status = read_bounded(directory + "/status", 16384)
                uid_line = next((line for line in status.splitlines() if line.startswith(b"Uid:")), None)
                if uid_line is None:
                    raise RuntimeError("PROCESS_CENSUS_UNAVAILABLE")
                if uid not in [int(value) for value in uid_line.split()[1:3]]:
                    continue
            before = process_identity(directory)
            command = read_bounded(directory + "/cmdline", MAX_COMMAND)
            name = read_bounded(directory + "/comm", 256).strip().decode("utf-8", "replace")
            after = process_identity(directory)
        except FileNotFoundError:
            continue  # The process exited during the census.
        inspected += 1
        if before[1] != after[1]:
            raise RuntimeError("PROCESS_IDENTITY_CHANGED")
        state = after[0]
        if state in ("Z", "X", "x"):
            continue  # Dead tasks cannot execute or hold a writer descriptor.
        args = command.rstrip(b"\0").decode("utf-8", "replace").split("\0")
        executable = posixpath.basename(args[0]) if args else ""
        # Markers count only in executing interpreters, not grep/log viewers.
        interpreter = name in ("bash", "sh", "dash") or executable in ("bash", "sh", "dash") or python_name(name) or python_name(executable)
        marked = interpreter and "-c" in args and any(marker in command for marker in (
            b"simple_sftp_staged_receive", b"SIMPLE_COMPRESSION_WIRE", b"tar --null", b"fpsync"))
        if name not in TRANSFER_NAMES and executable not in TRANSFER_NAMES and not marked:
            continue
        if executable == "ssh" and ssh_forward_only(args):
            continue
        scoped_root = receiver_root(args, receiver_hash)
        if scoped_root and not roots_overlap(scoped_root, root):
            continue
        raise ActiveTransfer(pid, name, state, "target-root" if scoped_root else "unscoped")
    return inspected


def verify_idle(root, receiver_hash=""):
    if not os.path.isabs(root) or root == "/" or os.path.realpath(root) != root or not os.path.isdir(root):
        raise RuntimeError("UNSAFE_TRANSFER_ROOT")
    descriptors = []
    try:
        for index in range(32):
            lock = os.path.join(root, ".simple-sftp-stage-%02x.lock" % index)
            try:
                descriptor = os.open(lock, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                raise RuntimeError("UNSAFE_TRANSFER_SLOT")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("REMOTE_TRANSFER_SLOT_BUSY")
        count = process_census(root, receiver_hash)
        return {"idle": True, "root": root, "inspectedProcesses": count, "inspectedLocks": len(descriptors)}
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def main():
    try:
        result = verify_idle(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "")
    except Exception as error:
        result = {"idle": False, "reason": str(error)[:160]}
        if isinstance(error, ActiveTransfer):
            result["blocker"] = error.blocker
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
