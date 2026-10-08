"""仅初始化 GeekDash 的 Linux 数据库技术配置；不创建业务用户。"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--mysql-gid', type=int, required=True)
args = parser.parse_args()
assert os.name == 'posix' and os.geteuid() == 0, '必须使用 Linux 受控维护身份'
assert 0 < args.mysql_gid < 65536, '必须核对固定镜像的 mysql GID'

root = Path('/opt/geekdash')
config = root / 'config'
target = config / 'secrets'
data = Path('/var/lib/geekdash/mysql')
names = ['root.password', 'root-client.cnf', 'bootstrap.sql'] + [f'{scope}_{role}.json' for scope in ('dev', 'test') for role in ('app', 'migrator')]
for path in (root, config, target, data):
    if path.is_symlink():
        raise SystemExit('目标目录不能是软链接')
config.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(config, 0o700)
lock = (config / '.init.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX)
if target.exists():
    if not target.is_dir() or set(p.name for p in target.iterdir()) != set(names):
        raise SystemExit('已有配置不完整；保留原文件，禁止重生成覆盖')
    for name in names:
        path = target / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise SystemExit('已有配置文件无效；停止初始化')
    if not data.is_dir():
        raise SystemExit('已有配置缺少数据目录；停止并核对挂载')
    print(json.dumps({'status': 'reused', 'credentialsOverwritten': False}))
else:
    if data.exists() and any(data.iterdir()):
        raise SystemExit('已有数据但缺少配置；禁止生成另一组密码')
    pending = Path(tempfile.mkdtemp(prefix='.secrets-', dir=config))
    password = secrets.token_hex(32)
    files = {'root.password': password, 'root-client.cnf': f'[client]\nuser=root\npassword={password}\n'}
    sql = ''
    for scope in ('dev', 'test'):
        database = f'geekdash_{scope}'
        sql += f'CREATE DATABASE {database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\n'
        for role in ('app', 'migrator'):
            profile = f'{scope}_{role}'
            user = f'gd_{profile}'
            password = secrets.token_hex(32)
            files[f'{profile}.json'] = json.dumps({'host': 'mysql', 'port': 3306, 'database': database, 'user': user, 'password': password}) + '\n'
            privileges = 'SELECT, INSERT, UPDATE, DELETE'
            if role == 'migrator':
                privileges += ', CREATE, DROP, ALTER, INDEX, REFERENCES'
            sql += f"CREATE USER '{user}'@'%' IDENTIFIED BY '{password}';\nGRANT {privileges} ON {database}.* TO '{user}'@'%';\n"
    files['bootstrap.sql'] = sql
    for name, text in files.items():
        path = pending / name
        path.write_text(text, encoding='utf-8')
        os.chown(path, 0, 1000 if name.endswith('.json') else args.mysql_gid)
        os.chmod(path, 0o640)
    data.mkdir(parents=True, exist_ok=True, mode=0o750)
    pending.rename(target)
    print(json.dumps({'status': 'created', 'files': len(files), 'businessAccountsCreated': 0}))
