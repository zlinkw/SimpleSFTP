import importlib.util
import os
import sys
import types
import unittest
from unittest.mock import patch

# No Linux filesystem or locks are created by this Windows-runnable fixture.
if sys.platform == "win32":
    sys.modules["fcntl"] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None)
spec = importlib.util.spec_from_file_location("probe", os.path.join(os.path.dirname(__file__), "..", "transfer-settlement-probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeSafety(unittest.TestCase):
    def locks(self, busy=False, unsafe=False):
        def opened(name, flags):
            self.assertFalse(flags & os.O_CREAT)
            if name.endswith("00.lock"):
                return 10
            raise FileNotFoundError()
        return [patch.object(probe.os, "O_NOFOLLOW", 0x20000, create=True), patch.object(probe.os, "O_CLOEXEC", 0x80000, create=True),
                patch.object(probe.os, "getuid", return_value=1000, create=True), patch.object(probe.os.path, "realpath", side_effect=lambda path: path),
                patch.object(probe.os.path, "isdir", return_value=True), patch.object(probe.os.path, "isabs", return_value=True), patch.object(probe.os, "open", side_effect=opened),
                patch.object(probe.os, "fstat", return_value=types.SimpleNamespace(st_mode=0o100600, st_nlink=2 if unsafe else 1, st_uid=1000)),
                patch.object(probe.os, "close"), patch.object(probe.fcntl, "flock", side_effect=BlockingIOError() if busy else None),
                patch.object(probe, "process_census", return_value=3)]

    def run_locks(self, **options):
        from contextlib import ExitStack
        with ExitStack() as stack:
            mocks = [stack.enter_context(item) for item in self.locks(**options)]
            try:
                return probe.verify_idle("/projects/example")
            finally:
                mocks[-3].assert_called_once_with(10)

    def test_idle(self):
        self.assertEqual(self.run_locks()["inspectedLocks"], 1)

    def test_busy_slot(self):
        with self.assertRaisesRegex(RuntimeError, "SLOT_BUSY"):
            self.run_locks(busy=True)

    def test_unsafe_lock(self):
        with self.assertRaisesRegex(RuntimeError, "UNSAFE_TRANSFER_SLOT"):
            self.run_locks(unsafe=True)

    def test_symlink_root(self):
        with patch.object(probe.os.path, "realpath", return_value="/other"):
            with self.assertRaisesRegex(RuntimeError, "UNSAFE_TRANSFER_ROOT"):
                probe.verify_idle("/projects/example")

    def census(self, command=b"python3\0train.py\0", mounts=b"", fail=False, count=1):
        def read(name, _limit):
            if name.endswith("mountinfo"):
                return mounts
            if fail:
                raise PermissionError("cannot inspect own process")
            return command if name.endswith("cmdline") else b"python3\n"
        with patch.object(probe, "ancestors", return_value={1}), patch.object(probe.os, "getuid", return_value=1000, create=True), \
                patch.object(probe.os, "listdir", return_value=[str(index + 2) for index in range(count)]), \
                patch.object(probe.os, "stat", return_value=types.SimpleNamespace(st_uid=1000)), patch.object(probe, "read_bounded", side_effect=read):
            return probe.process_census()

    def test_other_training_allowed(self):
        self.assertEqual(self.census(), 1)

    def test_receiver_and_source_pipeline_detected(self):
        for command in (b"python3\0exec(compile(code,'simple_sftp_staged_receive','exec'))\0", b"bash\0tar --null -T -\0", b"ssh\0dest\0"):
            with self.assertRaisesRegex(RuntimeError, "REMOTE_TRANSFER_STILL_ACTIVE"):
                self.census(command=command)

    def test_permission_failure_not_empty_evidence(self):
        with self.assertRaises(PermissionError):
            self.census(fail=True)

    def test_hidden_processes_not_empty_evidence(self):
        with self.assertRaisesRegex(RuntimeError, "PROCESS_CENSUS_UNAVAILABLE"):
            self.census(mounts=b"proc hidepid=4")

    def test_bounded_census(self):
        with self.assertRaisesRegex(RuntimeError, "PROCESS_CENSUS_LIMIT"):
            self.census(count=8193)

    def test_nondumpable_same_user_is_not_mistaken_for_other_user(self):
        with patch.object(probe, "ancestors", return_value={1}), patch.object(probe.os, "getuid", return_value=1000, create=True), \
                patch.object(probe.os, "listdir", return_value=["2"]), patch.object(probe.os, "stat", return_value=types.SimpleNamespace(st_uid=0)), \
                patch.object(probe, "read_bounded", side_effect=[b"proc", b"Name:\ttest\nUid:\t1000\t1000\t1000\t1000\n", PermissionError()]):
            with self.assertRaises(PermissionError):
                probe.process_census()


if __name__ == "__main__":
    unittest.main()
