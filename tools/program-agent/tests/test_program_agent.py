"""Offline device protocol tests. No .env, network, real controller or database."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error

SPEC = importlib.util.spec_from_file_location('program_agent', Path(__file__).parents[1] / 'program_agent.py')
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)
NEW = b'%\nO1234\nG0 X10\nM30\n%\n'
OLD = b'%\nO1234\nG0 X5\nM30\n%\n'


class FakeController:
    def __init__(self):
        self.files = {}
        self.current = ('O2000.nc', OLD)
        self.writes = self.current_reads = 0
        self.interrupt = None
        self.active = None

    def read(self, path, name):
        return self.files.get(name)

    def read_current(self, path):
        self.current_reads += 1
        return self.current

    def check_write(self, path, name):
        if self.active == name:
            raise agent.ControllerError('RUNNING_PROGRAM', 'The program is running.')

    def write(self, path, name, data):
        self.writes += 1
        if self.interrupt == 'before':
            raise OSError('power lost before controller write')
        self.files[name] = data
        if self.interrupt == 'after':
            raise OSError('connection lost after controller write')


class FakeApi:
    def __init__(self, job):
        self.job = job
        self.download = NEW
        self.results = []
        self.uploads = []
        self.polls = 0
        self.finished = False
        self.lose_result = self.lose_upload = False
        self.after_upload = None

    def next_command(self):
        self.polls += 1
        return {'job': None if self.finished else self.job, 'poll_seconds': 15}

    def job_file(self, job_id):
        return {'x-sha256': agent.checksum(self.download)}, self.download

    def result(self, job_id, result):
        self.results.append((job_id, result.copy()))
        self.finished = True
        if self.lose_result:
            self.lose_result = False
            raise urllib.error.URLError('result committed, reply lost')
        return {'job': {'id': job_id, 'status': result['status']}}

    def upload(self, data, name, job_id, current=True):
        self.uploads.append((bytes(data), name, job_id, current))
        if self.after_upload:
            self.after_upload()
        if current:
            self.finished = True
        if self.lose_upload:
            self.lose_upload = False
            raise urllib.error.URLError('upload reply lost')
        return {'file': {'sha256': agent.checksum(data)}}


class DurableCommands(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='cnc-agent-offline-')
        self.addCleanup(self.directory.cleanup)
        self.store = agent.StateStore(os.path.join(self.directory.name, 'state.json'))
        self.controller = FakeController()

    def create(self, action='SEND', **extra):
        job = {'id': 7, 'action': action, 'program_path': '//CNC_MEM/USER/PATH1/',
               'program_name': 'O1234.nc' if action == 'SEND' else None,
               'file': {'sha256': agent.checksum(NEW), 'size': len(NEW)} if action == 'SEND' else None,
               'source': 'CURRENT_RUNNING' if action == 'BACKUP' else None, 'overwrite': False, **extra}
        api = FakeApi(job)
        return api, agent.Agent(api, self.controller, self.store)

    def test_send_only_reports_success_after_controller_read_back(self):
        api, device = self.create()
        device.poll()
        self.assertEqual(self.controller.files['O1234.nc'], NEW)
        self.assertEqual(self.controller.writes, 1)
        self.assertEqual(api.results, [(7, {'status': 'DONE', 'sha256': agent.checksum(NEW), 'verified': True, 'replaced': False})])
        self.assertIsNone(self.store.load())
        self.assertEqual(list(Path(self.directory.name).glob('command-*')), [])

    def test_lost_result_reply_retries_result_without_another_cnc_write(self):
        api, device = self.create()
        api.lose_result = True
        with self.assertRaises(urllib.error.URLError):
            device.poll()
        self.assertEqual(self.store.load()['phase'], 'RESULT_PENDING')
        restarted = agent.Agent(api, self.controller, agent.StateStore(self.store.filename))
        restarted.poll()
        self.assertEqual(self.controller.writes, 1)
        self.assertFalse(api.results[-1][1]['replaced'])
        self.assertEqual(api.polls, 1)
        self.assertEqual(len(api.results), 2)
        self.assertEqual(api.results[0], api.results[1])

    def test_interrupted_completed_write_is_reconciled_by_read_back(self):
        api, device = self.create()
        self.controller.interrupt = 'after'
        with self.assertRaises(OSError):
            device.poll()
        self.assertEqual(self.store.load()['phase'], 'WRITING')
        device.poll()
        self.assertEqual(self.controller.writes, 1)
        self.assertEqual(api.results[-1][1]['status'], 'DONE')
        self.assertTrue(api.results[-1][1]['verified'])

    def test_uncertain_write_never_blindly_repeats(self):
        api, device = self.create()
        self.controller.interrupt = 'before'
        with self.assertRaises(OSError):
            device.poll()
        device.poll()
        self.assertEqual(self.controller.writes, 1)
        self.assertEqual(api.results[-1][1]['error_code'], 'COMMAND_INTERRUPTED')
        self.assertNotIn('O1234.nc', self.controller.files)

    def test_current_backup_queries_actual_current_program_each_command(self):
        api, device = self.create('BACKUP')
        device.poll()
        self.assertEqual(api.uploads, [(OLD, 'O2000.nc', 7, True)])
        self.controller.current = ('O3000.nc', NEW)
        api.job = {**api.job, 'id': 8}
        api.finished = False
        device.poll()
        self.assertEqual(api.uploads[-1], (NEW, 'O3000.nc', 8, True))
        self.assertEqual(self.controller.current_reads, 2)
        self.assertEqual(self.controller.writes, 0)

    def test_lost_backup_reply_retries_identical_saved_bytes(self):
        api, device = self.create('BACKUP')
        api.lose_upload = True
        with self.assertRaises(urllib.error.URLError):
            device.poll()
        self.assertEqual(self.store.load()['phase'], 'BACKUP_PENDING')
        self.controller.current = ('O3000.nc', NEW)
        device.poll()
        self.assertEqual(self.controller.current_reads, 1)
        self.assertEqual(api.uploads, [(OLD, 'O2000.nc', 7, True)] * 2)
        self.assertIsNone(self.store.load())

    def test_existing_program_requires_explicit_overwrite(self):
        api, device = self.create()
        self.controller.files['O1234.nc'] = OLD
        device.poll()
        self.assertEqual(self.controller.writes, 0)
        self.assertEqual(api.uploads, [])
        self.assertEqual(api.results[-1][1]['error_code'], 'FILE_EXISTS')

    def test_overwrite_waits_for_saved_backup_before_any_write(self):
        api, device = self.create(overwrite=True)
        self.controller.files['O1234.nc'] = OLD
        api.lose_upload = True
        with self.assertRaises(urllib.error.URLError):
            device.poll()
        self.assertEqual(self.controller.writes, 0)
        self.assertEqual(self.store.load()['phase'], 'PRE_BACKUP_PENDING')
        device.poll()
        self.assertEqual(api.uploads, [(OLD, 'O1234.nc', 7, False)] * 2)
        self.assertEqual(self.controller.writes, 1)
        self.assertTrue(api.results[-1][1]['replaced'])

    def test_unverified_server_backup_cannot_allow_controller_replacement(self):
        api, device = self.create(overwrite=True)
        self.controller.files['O1234.nc'] = OLD
        api.upload = lambda *args, **kwargs: {'file': {'sha256': 'different-checksum'}}
        device.poll()
        self.assertEqual(self.controller.writes, 0)
        self.assertEqual(api.results[-1][1]['error_code'], 'BACKUP_NOT_VERIFIED')

    def test_program_changed_after_backup_blocks_the_write(self):
        api, device = self.create(overwrite=True)
        self.controller.files['O1234.nc'] = OLD
        api.after_upload = lambda: self.controller.files.update({'O1234.nc': b'operator changed program'})
        device.poll()
        self.assertEqual(self.controller.writes, 0)
        self.assertEqual(api.results[-1][1]['error_code'], 'PROGRAM_CHANGED')

    def test_running_program_is_never_overwritten(self):
        api, device = self.create(overwrite=True)
        self.controller.active = 'O1234.nc'
        device.poll()
        self.assertEqual(api.results[-1][1]['error_code'], 'RUNNING_PROGRAM')
        self.assertEqual(self.controller.writes, 0)

    def test_checksum_error_cannot_reach_controller_write(self):
        api, device = self.create()
        api.download = b'wrong file bytes'
        device.poll()
        self.assertEqual(api.results[-1][1]['error_code'], 'CHECKSUM_MISMATCH')
        self.assertEqual(self.controller.writes, 0)

    def test_corrupt_manifest_fails_closed_before_poll_or_write(self):
        api, device = self.create()
        Path(self.store.filename).write_text('{"job":{"id":7},"phase":"UNKNOWN"}')
        with self.assertRaisesRegex(agent.ControllerError, 'Persistent command state'):
            device.poll()
        self.assertEqual(api.polls, 0)
        self.assertEqual(self.controller.writes, 0)

    def test_corrupt_spool_is_reported_without_touching_the_controller(self):
        api, device = self.create()
        spool = self.store.spool(7, 'new', b'changed local bytes')
        self.store.save({'job': api.job, 'phase': 'WRITE_READY', 'previous_sha256': None, 'data_file': spool})
        device.poll()
        self.assertEqual(api.results[-1][1]['error_code'], 'STATE_CORRUPT')
        self.assertEqual(self.controller.writes, 0)

    def test_backup_requires_current_running_source(self):
        api, device = self.create('BACKUP', source='LATEST_FILE')
        device.poll()
        self.assertEqual(api.results[-1][1]['error_code'], 'UNSUPPORTED_COMMAND')
        self.assertEqual(self.controller.current_reads, 0)


class FolderFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='cnc-folder-fixture-')
        self.addCleanup(self.directory.cleanup)

    def test_bad_machine_path_is_reported_and_never_created(self):
        fixture = agent.FolderController(self.directory.name, 'O1.nc')
        wrong = os.path.join(self.directory.name, 'wrong-path')
        with self.assertRaises(agent.ControllerError) as error:
            fixture.write(wrong, 'O2.nc', NEW)
        self.assertEqual(error.exception.code, 'PATH_NOT_SUPPORTED')
        self.assertFalse(os.path.exists(wrong))
        self.assertEqual(os.listdir(self.directory.name), [])

    def test_missing_fixture_folder_is_never_created(self):
        missing = os.path.join(self.directory.name, 'missing')
        fixture = agent.FolderController(missing, 'O1.nc')
        with self.assertRaises(agent.ControllerError) as error:
            fixture.write(missing, 'O2.nc', NEW)
        self.assertEqual(error.exception.code, 'PATH_NOT_FOUND')
        self.assertFalse(os.path.exists(missing))

    def test_backup_requires_explicit_active_filename_and_never_picks_first_file(self):
        Path(self.directory.name, 'O1.nc').write_bytes(OLD)
        Path(self.directory.name, 'O2.nc').write_bytes(NEW)
        fixture = agent.FolderController(self.directory.name)
        with self.assertRaises(agent.ControllerError) as error:
            fixture.read_current(self.directory.name)
        self.assertEqual(error.exception.code, 'CURRENT_PROGRAM_UNKNOWN')
        fixture.active_program = 'O2.nc'
        self.assertEqual(fixture.read_current(self.directory.name), ('O2.nc', NEW))

    def test_symlink_and_traversal_cannot_escape_fixture(self):
        fixture = agent.FolderController(self.directory.name, 'O1.nc')
        Path(self.directory.name, 'O2.nc').symlink_to('/etc/hosts')
        with self.assertRaises(agent.ControllerError) as error:
            fixture.read(self.directory.name, 'O2.nc')
        self.assertEqual(error.exception.code, 'PATH_NOT_SUPPORTED')
        with self.assertRaises(agent.ControllerError):
            fixture.write(self.directory.name, '../O2.nc', NEW)


class PostOnlyApi(unittest.TestCase):
    def test_https_is_required_except_explicit_loopback(self):
        for url in ('http://controller.example', 'ftp://controller.example', 'https://api.example/path',
                    'https://user:secret@api.example', 'https://api.example?token=secret'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                agent.Api(url, 'mxd_fixture')
        self.assertEqual(agent.Api('http://127.0.0.1:3000', 'mxd_fixture').base,
                         'http://127.0.0.1:3000/api/device/v1')

    def test_command_file_result_and_backup_all_use_post(self):
        api = agent.Api('https://api.example', 'mxd_fixture')
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{}'
        response.headers = {'X-Sha256': 'checksum'}
        with mock.patch.object(api.opener, 'open', return_value=response) as opened:
            api.next_command()
            api.job_file(7)
            api.result(7, {'status': 'DONE', 'verified': True, 'sha256': 'checksum'})
            api.upload(OLD, 'O2000.nc', 7)
        requests = [call.args[0] for call in opened.call_args_list]
        self.assertEqual([request.get_method() for request in requests], ['POST'] * 4)
        self.assertEqual([request.full_url for request in requests], [
            'https://api.example/api/device/v1/commands/next', 'https://api.example/api/device/v1/jobs/7/file',
            'https://api.example/api/device/v1/jobs/7/result', 'https://api.example/api/device/v1/backup'])
        self.assertIn(b'name="job_id"\r\n\r\n7', requests[-1].data)
        self.assertIn(b'name="program_name"\r\n\r\nO2000.nc', requests[-1].data)
        self.assertIn(agent.checksum(OLD).encode(), requests[-1].data)
        self.assertNotIn(b'name="type"', requests[-1].data)

    def test_structured_http_errors_preserve_device_error_code(self):
        api = agent.Api('https://api.example', 'mxd_fixture')
        error = urllib.error.HTTPError('https://api.example', 409, 'Conflict', {},
                                      io.BytesIO(json.dumps({'code': 'DEVICE_TIMEOUT', 'message': 'Expired'}).encode()))
        with mock.patch.object(api.opener, 'open', side_effect=error), self.assertRaises(agent.ApiError) as caught:
            api.next_command()
        self.assertEqual((caught.exception.status, caught.exception.code), (409, 'DEVICE_TIMEOUT'))

    def test_redirects_never_forward_device_token_or_downgrade_post(self):
        request = agent.urllib.request.Request('https://api.example', data=b'{}', method='POST',
                                               headers={'Authorization': 'Bearer mxd_fixture'})
        self.assertIsNone(agent.NoRedirect().redirect_request(request, None, 302, 'Found', {}, 'https://other.example'))
        api = agent.Api('https://api.example', 'mxd_fixture')
        error = urllib.error.HTTPError('https://api.example', 302, 'Found', {}, io.BytesIO(b''))
        with mock.patch.object(api.opener, 'open', side_effect=error), self.assertRaises(agent.ApiError) as caught:
            api.next_command()
        self.assertEqual(caught.exception.code, 'REDIRECT_NOT_ALLOWED')

    def test_once_reports_temporary_failure_as_nonzero_for_device_diagnostics(self):
        with tempfile.TemporaryDirectory(prefix='cnc-agent-cli-') as directory:
            environment = {'MEXA_URL': 'https://api.example', 'MEXA_DEVICE_TOKEN': 'mxd_fixture',
                           'CNC_DIR': directory, 'CNC_ACTIVE_PROGRAM': 'O1.nc',
                           'MEXA_STATE_FILE': os.path.join(directory, 'state.json')}
            with mock.patch.dict(os.environ, environment, clear=True), \
                    mock.patch('sys.argv', ['program_agent.py', '--once', '--config', os.path.join(directory, 'missing.env')]), \
                    mock.patch.object(agent, 'Api'), \
                    mock.patch.object(agent.Agent, 'poll', side_effect=urllib.error.URLError('fixture offline')), \
                    mock.patch('sys.stderr', new=io.StringIO()):
                self.assertEqual(agent.main(), 1)


if __name__ == '__main__':
    unittest.main()
