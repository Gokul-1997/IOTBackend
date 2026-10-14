#!/usr/bin/env python3
"""Reference POST-only Program Transfer device agent (Python 3.8+, standard library).

MEXA_URL=https://your-api, MEXA_DEVICE_TOKEN=mxd_..., optional MEXA_CA_FILE.
MEXA_STATE_FILE must be on persistent storage (default /var/lib/mexa/program-agent.state).

FolderController is an explicit TEST fixture: CNC_DIR must already exist and
CNC_ACTIVE_PROGRAM names the fixture's current running program. It never creates
or guesses a controller folder. Real devices must supply a controller adapter
with read_current(path), read(path,name), check_write(path,name), write(path,name,data).
read_current must query the controller's active program, not infer a filename.
This agent writes a program file; it never starts machining.
"""
import argparse
import hashlib
import json
import os
import ssl
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

AGENT_VERSION = '2.0.0'
NETWORK = (urllib.error.URLError, TimeoutError, ConnectionError, OSError)


def checksum(data):
    return hashlib.sha256(data).hexdigest()


class ControllerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def safe_name(name):
    if not isinstance(name, str) or not name or name in ('.', '..') or any(c in name for c in '\\/:\r\n\x00'):
        raise ControllerError('BAD_PROGRAM_NAME', 'The controller returned an invalid program filename.')
    return name


class FolderController:
    """Local-file test adapter only; never substitute a production controller path."""
    def __init__(self, stand_in, active_program=None):
        if not stand_in:
            raise ControllerError('UNSUPPORTED_CONTROLLER', 'Configure a real controller adapter; CNC_DIR enables only the local test fixture.')
        self.stand_in = os.path.realpath(stand_in)
        self.active_program = active_program

    def _dir(self, path):
        if not path or not os.path.isdir(self.stand_in):
            raise ControllerError('PATH_NOT_FOUND', 'The configured controller program folder does not exist.')
        if os.path.realpath(path) != self.stand_in:
            raise ControllerError('PATH_NOT_SUPPORTED', 'The saved machine path must equal CNC_DIR when using the local test adapter.')
        return self.stand_in

    def _file(self, path, name):
        folder = self._dir(path)
        target = os.path.join(folder, safe_name(name))
        if os.path.islink(target):
            raise ControllerError('PATH_NOT_SUPPORTED', 'Symlink program files are not supported by the test adapter.')
        return target

    def read(self, path, name):
        try:
            with open(self._file(path, name), 'rb') as file:
                return file.read()
        except FileNotFoundError:
            return None
        except PermissionError as error:
            raise ControllerError('PATH_NOT_READABLE', 'The controller program cannot be read.') from error

    def read_current(self, path):
        if not self.active_program:
            raise ControllerError('CURRENT_PROGRAM_UNKNOWN', 'The controller adapter must identify the actual running program.')
        name = safe_name(self.active_program)
        data = self.read(path, name)
        if data is None:
            raise ControllerError('PROGRAM_NOT_FOUND', 'The current program reported by the test fixture is missing.')
        return name, data

    def check_write(self, path, name):
        target = self._file(path, name)
        if self.active_program and safe_name(self.active_program).lower() == name.lower():
            raise ControllerError('RUNNING_PROGRAM', 'The selected program is currently running; transfer is blocked.')
        if not os.access(os.path.dirname(target), os.W_OK):
            raise ControllerError('PATH_NOT_WRITABLE', 'The controller program folder is not writable.')

    def write(self, path, name, data):
        self.check_write(path, name)
        target = self._file(path, name)
        temporary = target + '.part-' + uuid.uuid4().hex
        try:
            with open(temporary, 'xb') as file:
                file.write(data); file.flush(); os.fsync(file.fileno())
            os.replace(temporary, target)
            sync_directory(os.path.dirname(target))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class StateStore:
    """Write-ahead command manifest and backup bytes, persisted before any CNC write."""
    def __init__(self, filename):
        self.filename = os.path.abspath(filename)
        self.directory = os.path.dirname(self.filename)

    def load(self):
        try:
            with open(self.filename) as file:
                state = json.load(file)
            if state is not None and (not isinstance(state, dict) or not isinstance(state.get('job'), dict)):
                raise ValueError('invalid manifest')
            if state is not None and (state.get('phase') not in (
                    'NEW', 'READY', 'PRE_BACKUP_PENDING', 'WRITE_READY', 'WRITING', 'BACKUP_PENDING', 'RESULT_PENDING')
                    or not isinstance(state['job'].get('id'), int) or state['job']['id'] <= 0):
                raise ValueError('invalid command phase or number')
            return state
        except FileNotFoundError:
            return None
        except ValueError as error:
            raise ControllerError('STATE_CORRUPT', 'Persistent command state is unreadable; inspect it before touching the controller.') from error

    def save(self, state):
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        temporary = self.filename + '.part-' + uuid.uuid4().hex
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as file:
                json.dump(state, file); file.flush(); os.fsync(file.fileno())
            os.replace(temporary, self.filename)
            sync_directory(self.directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def spool(self, job_id, label, data):
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        filename = os.path.join(self.directory, 'command-%d-%s.bin' % (job_id, label))
        temporary = filename + '.part-' + uuid.uuid4().hex
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as file:
                file.write(data); file.flush(); os.fsync(file.fileno())
            os.replace(temporary, filename); sync_directory(self.directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return filename

    def read_spool(self, filename, expected):
        if os.path.dirname(os.path.abspath(filename)) != self.directory:
            raise ControllerError('STATE_CORRUPT', 'Invalid local command spool path.')
        with open(filename, 'rb') as file:
            data = file.read()
        if checksum(data) != expected:
            raise ControllerError('STATE_CORRUPT', 'Local command bytes do not match their saved checksum.')
        return data

    def clear(self, state):
        # Clearing is durable before old bytes are deleted. Lost cleanup cannot repeat a write.
        self.save(None)
        for field in ('data_file', 'backup_file'):
            filename = state.get(field)
            if filename and os.path.dirname(os.path.abspath(filename)) == self.directory:
                try:
                    os.unlink(filename)
                except FileNotFoundError:
                    pass


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__('%s %s: %s' % (status, code, message))
        self.status, self.code = status, code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Devices use the configured HTTPS API origin. A redirect must never
    # forward a machine token to another host or change a POST into a GET.
    def redirect_request(self, request, file, code, message, headers, url):
        return None


class Api:
    def __init__(self, url, token, ca_file=None):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
            raise ValueError('HTTPS is required outside loopback.')
        if not parsed.hostname or parsed.path not in ('', '/') or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Use a plain API origin without credentials, query or fragment.')
        if not token or any(character.isspace() for character in token):
            raise ValueError('Provide a device token without whitespace.')
        self.base = url.rstrip('/') + '/api/device/v1'
        self.token = token
        self.context = ssl.create_default_context(cafile=ca_file)
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=self.context), NoRedirect())

    def _call(self, path, body=b'{}', headers=None, raw=False, timeout=60):
        request = urllib.request.Request(self.base + path, data=body, method='POST', headers={
            'Authorization': 'Bearer ' + self.token, 'X-Agent-Version': AGENT_VERSION,
            'Content-Type': 'application/json', **(headers or {})})
        try:
            with self.opener.open(request, timeout=timeout) as response:
                data = response.read()
                return (dict(response.headers), data) if raw else json.loads(data or b'{}')
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read() or b'{}')
            except ValueError:
                detail = {}
            if 300 <= error.code < 400:
                raise ApiError(error.code, 'REDIRECT_NOT_ALLOWED', 'Configure the final HTTPS API origin; redirects are refused.')
            raise ApiError(error.code, detail.get('code', 'HTTP_%d' % error.code), detail.get('message', 'API request failed'))

    def next_command(self):
        return self._call('/commands/next')

    def job_file(self, job_id):
        headers, data = self._call('/jobs/%d/file' % job_id, raw=True)
        return {key.lower(): value for key, value in headers.items()}, data

    def result(self, job_id, result):
        return self._call('/jobs/%d/result' % job_id, json.dumps(result).encode())

    def upload(self, data, program_name, job_id, current=True):
        safe_name(program_name)
        boundary = uuid.uuid4().hex
        fields = {'program_name': program_name, 'job_id': str(job_id), 'sha256': checksum(data)}
        if not current:
            fields['type'] = 'BACKUP'
        chunks = []
        for key, value in fields.items():
            chunks.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, key, value)).encode())
        chunks.append(('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\nContent-Type: application/octet-stream\r\n\r\n' % (boundary, program_name.replace('"', '_'))).encode())
        chunks.extend([data, ('\r\n--%s--\r\n' % boundary).encode()])
        return self._call('/backup' if current else '/files', b''.join(chunks),
                          {'Content-Type': 'multipart/form-data; boundary=' + boundary}, timeout=300)


def failed(error):
    return {'status': 'FAILED', 'error_code': getattr(error, 'code', 'CONTROLLER_ERROR'), 'message': str(error)[:1000]}


class Agent:
    def __init__(self, api, controller, store):
        self.api, self.controller, self.store = api, controller, store

    def _result_pending(self, state, result):
        state['phase'], state['result'] = 'RESULT_PENDING', result
        self.store.save(state)

    def resume(self, state):
        job = state['job']
        path, name = job.get('program_path'), job.get('program_name')
        try:
            if state['phase'] == 'WRITING':
                # A controller write may have completed before a crash. Read-back
                # is the only safe reconciliation; never repeat the write blindly.
                actual = self.controller.read(path, name)
                if actual is not None and checksum(actual) == job['file']['sha256']:
                    self._result_pending(state, {'status': 'DONE', 'sha256': job['file']['sha256'], 'verified': True,
                                                 'replaced': state.get('previous_sha256') is not None})
                else:
                    self._result_pending(state, failed(ControllerError('COMMAND_INTERRUPTED', 'The write outcome is uncertain. Inspect the controller before requesting another transfer.')))
            if state['phase'] == 'NEW':
                if job['action'] == 'BACKUP':
                    if job.get('source') != 'CURRENT_RUNNING':
                        raise ControllerError('UNSUPPORTED_COMMAND', 'Backup must request the actual running program.')
                    current_name, data = self.controller.read_current(path)
                    state.update(program_name=safe_name(current_name), sha256=checksum(data),
                                 backup_file=self.store.spool(job['id'], 'current', data), phase='BACKUP_PENDING')
                    self.store.save(state)
                elif job['action'] == 'SEND':
                    safe_name(name)
                    headers, data = self.api.job_file(job['id'])
                    expected = job['file']['sha256']
                    if checksum(data) != expected or len(data) != job['file']['size'] or headers.get('x-sha256', expected) != expected:
                        raise ControllerError('CHECKSUM_MISMATCH', 'Downloaded program size/checksum does not match the command.')
                    state.update(data_file=self.store.spool(job['id'], 'new', data), phase='READY')
                    self.store.save(state)
                else:
                    raise ControllerError('UNSUPPORTED_COMMAND', 'This agent supports SEND and current-program BACKUP commands.')
            if state['phase'] == 'READY':
                self.controller.check_write(path, name)
                old = self.controller.read(path, name)
                state['previous_sha256'] = checksum(old) if old is not None else None
                if old is not None:
                    if not job.get('overwrite'):
                        raise ControllerError('FILE_EXISTS', 'The program already exists. Explicit replacement is required.')
                    state.update(backup_file=self.store.spool(job['id'], 'before-overwrite', old),
                                 backup_sha256=checksum(old), phase='PRE_BACKUP_PENDING')
                    self.store.save(state)
                else:
                    state['phase'] = 'WRITE_READY'; self.store.save(state)
            if state['phase'] == 'PRE_BACKUP_PENDING':
                old = self.store.read_spool(state['backup_file'], state['backup_sha256'])
                saved = self.api.upload(old, name, job['id'], current=False)
                if saved.get('file', {}).get('sha256') != state['backup_sha256']:
                    raise ControllerError('BACKUP_NOT_VERIFIED', 'The server did not confirm the exact pre-overwrite backup checksum.')
                state['phase'] = 'WRITE_READY'; self.store.save(state)
            if state['phase'] == 'WRITE_READY':
                self.controller.check_write(path, name)
                old = self.controller.read(path, name)
                if (checksum(old) if old is not None else None) != state['previous_sha256']:
                    raise ControllerError('PROGRAM_CHANGED', 'The controller program changed while preparing the transfer. Inspect it before requesting another transfer.')
                data = self.store.read_spool(state['data_file'], job['file']['sha256'])
                state['phase'] = 'WRITING'; self.store.save(state)
                self.controller.write(path, name, data)
                actual = self.controller.read(path, name)
                if actual is None or checksum(actual) != job['file']['sha256']:
                    raise ControllerError('WRITE_NOT_VERIFIED', 'Controller read-back does not match the downloaded program.')
                self._result_pending(state, {'status': 'DONE', 'sha256': job['file']['sha256'], 'verified': True,
                                             'replaced': state['previous_sha256'] is not None})
            if state['phase'] == 'BACKUP_PENDING':
                data = self.store.read_spool(state['backup_file'], state['sha256'])
                saved = self.api.upload(data, state['program_name'], job['id'], current=True)
                if saved.get('file', {}).get('sha256') != state['sha256']:
                    raise ControllerError('BACKUP_NOT_VERIFIED', 'The server did not confirm the exact current-program backup checksum.')
                self.store.clear(state)
                return
        except ApiError:
            raise  # Retry the saved HTTP step; never turn a temporary server refusal into another CNC write.
        except NETWORK:
            raise  # Local state stays at its durable phase, including WRITING after an uncertain write.
        except Exception as error:
            self._result_pending(state, failed(error))
        if state['phase'] == 'RESULT_PENDING':
            self.api.result(job['id'], state['result'])
            self.store.clear(state)

    def poll(self):
        pending = self.store.load()
        if pending:
            self.resume(pending)
            return 15
        response = self.api.next_command()
        job = response.get('job')
        if job:
            state = {'job': job, 'phase': 'NEW'}
            self.store.save(state)
            self.resume(state)
        return max(5, min(300, int(response.get('poll_seconds', 15))))


def load_config(filename):
    if filename and os.path.exists(filename):
        with open(filename) as file:
            for line in file:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ.setdefault(key.strip(), value.strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--config', default='/etc/mexa/program-agent.env')
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    load_config(args.config)
    url, token = os.environ.get('MEXA_URL'), os.environ.get('MEXA_DEVICE_TOKEN')
    if not url or not token:
        parser.error('Set MEXA_URL and MEXA_DEVICE_TOKEN.')
    try:
        api = Api(url, token, os.environ.get('MEXA_CA_FILE'))
        controller = FolderController(os.environ.get('CNC_DIR'), os.environ.get('CNC_ACTIVE_PROGRAM'))
    except (ValueError, ControllerError) as error:
        parser.error('%s: %s' % (getattr(error, 'code', 'INVALID_CONFIG'), error))
    agent = Agent(api, controller, StateStore(os.environ.get('MEXA_STATE_FILE', '/var/lib/mexa/program-agent.state')))
    delay = 15
    while True:
        exit_code = 0
        try:
            delay = agent.poll()
        except ApiError as error:
            print('API refused command step: %s %s' % (error.status, error.code), file=sys.stderr)
            if error.status < 500 and error.status not in (408, 429):
                # Expired/conflicting commands require inspection. Keep the
                # manifest, stop, and never repeat a possibly completed write.
                return 2
            delay = min(delay * 2, 300)
            exit_code = 1
        except NETWORK:
            print('Connection/storage failure; persisted command will reconcile before retry.', file=sys.stderr)
            delay = min(delay * 2, 300)
            exit_code = 1
        except ControllerError as error:
            print('%s: %s' % (error.code, error), file=sys.stderr)
            return 2
        if args.once:
            return exit_code
        time.sleep(delay)


if __name__ == '__main__':
    sys.exit(main())
