"""仅在无网络、无数据挂载的一次性 Linux 容器中验证初始化边界。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess

assert os.environ.get('GEEKDASH_DISPOSABLE_CONFIG_TEST') == '1'
assert not Path('/opt/geekdash').exists() and not Path('/var/lib/geekdash').exists()
command = ['python3', '/work/deploy/init-server.py', '--mysql-gid', '999']
processes = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(2)]
statuses = []
for process in processes:
    stdout, stderr = process.communicate(timeout=20)
    assert process.returncode == 0, stderr
    statuses.append(json.loads(stdout)['status'])
assert sorted(statuses) == ['created', 'reused']
target = Path('/opt/geekdash/config/secrets')
def snapshot():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in target.iterdir()}
original = snapshot()
assert len(original) == 7
for path in target.iterdir():
    assert path.stat().st_mode & 0o777 == 0o640
    assert path.stat().st_gid == (1000 if path.suffix == '.json' else 999)
assert json.loads(subprocess.check_output(command, text=True))['status'] == 'reused'
assert snapshot() == original

(target / 'dev_app.json').unlink()
remaining = snapshot()
assert subprocess.run(command, capture_output=True).returncode != 0
assert snapshot() == remaining

target.rename(target.parent / 'saved-secrets')
marker = Path('/var/lib/geekdash/mysql/persisted-marker')
marker.write_bytes(b'preserve-existing-data')
assert subprocess.run(command, capture_output=True).returncode != 0
assert not target.exists() and marker.read_bytes() == b'preserve-existing-data'
assert {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (target.parent / 'saved-secrets').iterdir()} == remaining
print(json.dumps({'status': 'passed', 'concurrentInitialization': True, 'repeatDoesNotOverwrite': True, 'partialConfigRejected': True, 'dataWithoutConfigPreserved': True, 'secretPermissions': True}))
