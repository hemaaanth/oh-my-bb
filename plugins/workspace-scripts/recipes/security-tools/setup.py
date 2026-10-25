import fcntl, hashlib, io, json, os, pathlib, platform, shutil, subprocess, sys, tarfile, tempfile, urllib.request, zipfile

recipe_dir = pathlib.Path(__file__).resolve().parent
lock = json.loads((recipe_dir / 'versions.json').read_text())
if platform.system() != 'Linux':
    raise SystemExit('Security tools recipe requires Linux')
arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
if not arch:
    raise SystemExit('Unsupported Linux architecture')
revision = hashlib.sha256(json.dumps(lock, sort_keys=True).encode()).hexdigest()[:16]
base = pathlib.Path.home() / '.local/share/bb/security-tools'
base.mkdir(parents=True, exist_ok=True)
root = base / revision
bin_dir = root / 'bin'
templates = root / 'templates'
# Independent host workers and concurrent agent turns share the same lock.
with (base / 'install.lock').open('w') as install_lock:
    fcntl.flock(install_lock, fcntl.LOCK_EX)
    bin_dir.mkdir(parents=True, exist_ok=True)
    required = [bin_dir / name for name in [*lock['tools'], 'semgrep']]
    ready = root / 'ready'
    if not (ready.exists() and all(p.is_file() and os.access(p, os.X_OK) for p in required) and templates.is_dir()):
        ready.unlink(missing_ok=True)
        def download(asset, destination):
            request = urllib.request.Request(asset['url'], headers={'User-Agent': 'BB-security-tools'})
            digest = hashlib.sha256()
            with urllib.request.urlopen(request, timeout=60) as response, destination.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != asset['sha256']:
                raise RuntimeError('Download checksum mismatch: ' + asset['url'])

        with tempfile.TemporaryDirectory(dir=root) as scratch:
            scratch = pathlib.Path(scratch)
            for name, tool in lock['tools'].items():
                target = bin_dir / name
                if target.exists():
                    continue
                print('Installing ' + name + ' ' + tool['version'], file=sys.stderr, flush=True)
                asset = tool['assets'][arch]
                archive = scratch / name
                download(asset, archive)
                staged = scratch / (name + '.bin')
                if asset['format'] == 'tar':
                    with tarfile.open(archive) as bundle:
                        member = next(m for m in bundle.getmembers() if m.name == name and m.isfile())
                        with bundle.extractfile(member) as source, staged.open('wb') as output:
                            shutil.copyfileobj(source, output)
                elif asset['format'] == 'zip':
                    with zipfile.ZipFile(archive) as bundle, bundle.open(name) as source, staged.open('wb') as output:
                        shutil.copyfileobj(source, output)
                else:
                    shutil.copyfile(archive, staged)
                staged.chmod(0o755)
                staged.replace(target)
            if not (bin_dir / 'semgrep').is_file():
                print('Installing Semgrep ' + lock['semgrep'], file=sys.stderr, flush=True)
                env = {**os.environ, 'UV_TOOL_DIR': str(root / 'uv-tools'), 'UV_TOOL_BIN_DIR': str(bin_dir)}
                subprocess.run(['uv', 'tool', 'install', '--python', '3.12', 'semgrep==' + lock['semgrep']], env=env, check=True, stdout=sys.stderr)
            if not templates.is_dir():
                print('Installing pinned Nuclei templates', file=sys.stderr, flush=True)
                archive = scratch / 'templates.tar.gz'
                download(lock['templates'], archive)
                staged_templates = scratch / 'templates'
                staged_templates.mkdir()
                with tarfile.open(archive) as bundle:
                    for member in bundle:
                        parts = pathlib.PurePosixPath(member.name).parts[1:]
                        if not parts or not member.isfile():
                            continue
                        if '..' in parts or pathlib.PurePosixPath(*parts).is_absolute():
                            raise RuntimeError('Invalid templates archive path')
                        target = staged_templates.joinpath(*parts)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with bundle.extractfile(member) as source, target.open('wb') as output:
                            shutil.copyfileobj(source, output)
                staged_templates.replace(templates)
        # A stamp is published only after every tool starts successfully.
        for name in lock['tools']:
            subprocess.run([str(bin_dir / name), '-version' if name == 'nuclei' else '--version'], check=True, stdout=sys.stderr, stderr=sys.stderr, timeout=30)
        subprocess.run([str(bin_dir / 'semgrep'), '--version'], check=True, stdout=sys.stderr, stderr=sys.stderr, timeout=30,
                       env={**os.environ, 'SEMGREP_SEND_METRICS': 'off', 'SEMGREP_ENABLE_VERSION_CHECK': '0'})
        ready.write_text(revision + '\n')
# Keep this recipe's exported paths bound to its pinned cache revision.
for name, target in [('bin', bin_dir), ('templates', templates)]:
    link = recipe_dir / name
    if link.exists() and not link.is_symlink():
        raise RuntimeError('Refusing to replace existing recipe path: ' + str(link))
    staged_link = recipe_dir / (name + '-' + str(os.getpid()))
    try:
        staged_link.symlink_to(target, target_is_directory=True)
        staged_link.replace(link)
    finally:
        staged_link.unlink(missing_ok=True)
print(json.dumps({'binDir': str(bin_dir), 'templatesDir': str(templates), 'path': str(bin_dir) + ':' + os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}))
