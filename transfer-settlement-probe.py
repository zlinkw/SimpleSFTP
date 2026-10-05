"""Bounded, read-only proof that the staged-transfer protocol has no writers.

No creation, deletion, signalling, or inference from file timestamps. Locks are
held during a complete same-user /proc census; unavailable evidence fails closed.
"""
import fcntl
import json
import os
import stat
import sys

MAX_PIDS = 8192
MAX_COMMAND = 262144
TRANSFER_NAMES = {"tar", "ssh", "scp", "sftp", "sftp-server", "rsync", "gzip", "pigz", "zstd"}


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


def process_census():
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
            command = read_bounded(directory + "/cmdline", MAX_COMMAND)
            name = read_bounded(directory + "/comm", 256).strip().decode("utf-8", "replace")
        except FileNotFoundError:
            continue  # The process exited during the census.
        inspected += 1
        args = command.split(b"\0")
        executable = os.path.basename(args[0].decode("utf-8", "replace")) if args else ""
        if name in TRANSFER_NAMES or executable in TRANSFER_NAMES or any(marker in command for marker in (
                b"simple_sftp_staged_receive", b"SIMPLE_COMPRESSION_WIRE", b"tar --null", b"fpart", b"fpsync")):
            raise RuntimeError("REMOTE_TRANSFER_STILL_ACTIVE")
    return inspected


def verify_idle(root):
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
        count = process_census()
        return {"idle": True, "root": root, "inspectedProcesses": count, "inspectedLocks": len(descriptors)}
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def main():
    try:
        result = verify_idle(sys.argv[1])
    except Exception as error:
        result = {"idle": False, "reason": str(error)[:160]}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
