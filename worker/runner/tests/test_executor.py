import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('executor', Path(__file__).resolve().parents[1] / 'execute.py')
executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor)


class Executor(unittest.TestCase):
    def job(self, command):
        return {'protocol': 1, 'network': False, 'kind': 'run', 'job_id': 'test', 'attempt': 1, 'version': 'head', 'snapshot': {'a.txt': {'mode': 0o100644, 'content': 'immutable'}}, 'command': command, 'limits': {'wall_ms': 1000, 'output_bytes': 4096}}

    def test_materialization_and_fixed_secret_free_environment(self):
        result = executor.execute(self.job(['/usr/bin/python3', '-c', 'import os; print(open("a.txt").read()); print(os.getenv("RIO_API_TOKEN")); print(os.getcwd())']))
        self.assertEqual(result['exit_code'], 0)
        self.assertIn('immutable\nNone\n', result['stdout'])
        self.assertFalse(result['timed_out'])

    def test_traversal_and_escaping_symlinks_are_not_materialized(self):
        job = self.job(['/bin/cat', 'a.txt'])
        job['snapshot']['../escape'] = {'mode': 0o100644, 'content': 'bad'}
        with self.assertRaises(AssertionError):
            executor.execute(job)
        job = self.job(['/usr/bin/python3', '-c', 'import os; print(os.path.lexists("link"))'])
        job['snapshot']['link'] = {'mode': 0o120000, 'content': '/etc/passwd'}
        self.assertEqual(executor.execute(job)['stdout'].strip(), 'False')

    def test_timeout_and_output_bounds_kill_process_groups(self):
        job = self.job(['/usr/bin/python3', '-c', 'import time; time.sleep(3)'])
        job['limits']['wall_ms'] = 100
        self.assertTrue(executor.execute(job)['timed_out'])
        job = self.job(['/usr/bin/python3', '-c', 'print("x" * 100000)'])
        result = executor.execute(job)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['stdout']) + len(result['stderr']), 4096)

    def test_network_enabled_protocol_is_rejected_before_spawning(self):
        job = self.job(['/bin/true'])
        job['network'] = True
        with self.assertRaises(AssertionError):
            executor.execute(job)
