"""AutoDL installation worker. A per-installation flock survives the SSH disconnect."""
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.error
import urllib.request

from acceptance import Comfy, prepare_graph
from models import GIB, FP4, INT8, digest, download, ensure_space, inventory, plan
from service import listening, start
from progress import DownloadProgress

BUNDLE = Path(__file__).resolve().parent.parent
CORE = '73c9bad4d21e7addbe1d13bc92eee0f1431b017d'
CORE_SHA = 'a0804bec55fe4e82e88c048a671084e01eb2f71971bed6d884319e17b12bcf97'


def write_json(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    os.replace(tmp, path)


def install_core(root):
    core = root / 'ComfyUI'
    if (core / '.blackbox-revision').is_file() and (core / '.blackbox-revision').read_text() == CORE:
        return
    if core.exists():
        raise RuntimeError('安装目录中已有其他 ComfyUI，请使用另一端口或移开旧目录。')
    archive = root / 'comfy.tar.gz'
    if not archive.is_file() or digest(archive) != CORE_SHA:
        source = 'https://codeload.github.com/Comfy-Org/ComfyUI/tar.gz/' + CORE
        subprocess.run(['curl', '-fsSL', '--retry', '2', '--connect-timeout', '15', '--max-time', '300',
                        '-o', str(archive), source], check=True)
        if digest(archive) != CORE_SHA:
            raise RuntimeError('ComfyUI 源码包校验失败')
    with tempfile.TemporaryDirectory(dir=root) as temp:
        subprocess.run(['tar', '-xzf', str(archive), '-C', temp], check=True)
        extracted = Path(temp) / ('ComfyUI-' + CORE)
        (extracted / '.blackbox-revision').write_text(CORE)
        extracted.rename(core)


def run(args):
    subprocess.run([str(a) for a in args], check=True)


def environment(root, plugins):
    py = root / 'venv/bin/python'
    core = root / 'ComfyUI'
    requirements = [core / 'requirements.txt']
    for name in plugins:
        source = BUNDLE / 'comfyui-plugins' / name
        target = core / 'custom_nodes' / name
        if not target.exists():
            target.symlink_to(source, target_is_directory=True)
        elif not target.is_symlink() or target.resolve() != source.resolve():
            # The installer exclusively owns symlinks into its own immutable recipe bundles.
            if not target.is_symlink() or root / 'bundles' not in target.resolve().parents:
                raise RuntimeError('插件目录已被其他安装占用：' + name)
            target.unlink()
            target.symlink_to(source, target_is_directory=True)
        req = source / 'requirements.txt'
        if req.is_file():
            requirements.append(req)
    stamp = root / 'environment.json'
    version = {'core': CORE, 'bundle': BUNDLE.name, 'plugins': plugins}
    if py.is_file() and stamp.is_file() and json.loads(stamp.read_text()) == version:
        return
    if not py.exists() or subprocess.run([str(py), '-m', 'pip', '--version']).returncode:
        if (3, 10) <= sys.version_info[:2] <= (3, 13):
            run([sys.executable, '-m', 'venv', '--system-site-packages', root / 'venv'])
        else:
            conda = Path('/root/miniconda3/bin/conda')
            if not conda.is_file():
                raise RuntimeError('未找到可用的 Python 3.10–3.13 或 AutoDL Miniconda')
            os.environ['CONDA_PKGS_DIRS'] = str(root / 'conda-cache')
            run([conda, 'create', '-y', '-p', root / 'venv', 'python=3.12', 'pip'])
    pip = [py, '-m', 'pip', '--disable-pip-version-check', 'install', '--no-cache-dir']
    # Reuse the CUDA torch shipped with the cloud image if it can actually run kernels.
    probe = ('import torch,torchvision; assert tuple(map(int,torch.__version__.split("+")[0].split(".")[:2])) >= (2,11); '
             'assert torch.ones(1,device="cuda").item() == 1; print(torch.__version__,torchvision.__version__)')
    check = subprocess.run([str(py), '-c', probe], stdout=subprocess.PIPE, text=True)
    if check.returncode:
        run(pip + ['--index-url', 'https://download.pytorch.org/whl/cu128', 'torch==2.11.0',
                   'torchvision==0.26.0', 'torchaudio==2.11.0'])
        check = subprocess.run([str(py), '-c', probe], capture_output=True, text=True, check=True)
    torch, vision = check.stdout.strip().splitlines()[-1].split()
    constraints = root / 'torch-constraints.txt'
    constraints.write_text(f'torch=={torch}\ntorchvision=={vision}\ntorchaudio==2.11.0\n')
    if subprocess.run([str(py), '-c', 'import torchaudio']).returncode:
        cuda = torch.split('+')[-1]
        index = 'https://download.pytorch.org/whl/' + (cuda if cuda.startswith('cu') else 'cu128')
        run(pip + ['--index-url', index, '--no-deps', 'torchaudio==2.11.0'])
    reqs = [arg for req in requirements for arg in ('-r', req)]
    # Keep reusable dependency wheels on the data disk when a network failure interrupts pip.
    run([py, '-m', 'pip', 'install', '--cache-dir', root / 'pip-cache', '-c', constraints, *reqs])
    run([py, '-c', 'import torch,torchaudio; assert torch.cuda.is_available()'])
    write_json(stamp, version)


def wait_ready(api, root):
    for _ in range(150):
        try:
            if api.request('/system_stats').get('devices'):
                return
        except OSError:
            pass
        time.sleep(2)
    raise RuntimeError('ComfyUI 五分钟内未就绪，详见 ' + str(root / 'comfy.log'))


def execute(root, port, state):
    import threading
    state_lock = threading.Lock()
    def step(phase, text):
        with state_lock:
            state.update(status='running', phase=phase, message=text)
            write_json(root / 'state.json', state)
            print(text, flush=True)
    recipe = json.loads((BUNDLE / 'recipe.json').read_text())
    catalog = json.loads((BUNDLE / 'autodl/models.json').read_text())
    state['video'] = bool(recipe.get('video'))
    step('check', '正在检查 GPU、驱动和数据盘')
    gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=name,memory.total,driver_version,compute_cap',
                                   '--format=csv,noheader,nounits', '--id=0'], text=True).strip()
    fp4 = float(gpu.split(',')[-1]) >= 10
    files = inventory(catalog, recipe['workflows'], fp4)
    card, memory, driver, _ = (field.strip() for field in gpu.split(','))
    state.update(gpu=f'{card} · {int(memory) / 1024:.0f} GiB 显存 · 驱动 {driver}', swaps={} if fp4 or not any(FP4 in x for w in recipe['workflows']
                 for x in catalog['workflows'][w]) else {FP4: INT8})
    api = Comfy(port)
    external_service = listening(port) and not owned_service(root)
    if external_service:
        step('check', '检测到该端口已有服务，正在检查它的工作流和模型')
        try:
            names = api.inspect(recipe, files)
        except Exception as exc:
            raise RuntimeError(f'端口 {port} 已有其他服务。请在远程设置中选择空闲的 ComfyUI 端口。{exc}') from exc
    else:
        # Stage the models independently of the source checkout so disk preflight happens first.
        modelroot = root / 'models'
        needed, pending = plan(modelroot, files, root.parents[1] / 'ComfyUI/models', lambda msg: step('check', msg))
        reserve = (3 if (root / 'environment.json').is_file() else 14) * GIB
        state['space'] = (f'数据盘可用 {shutil.disk_usage(root).free/GIB:.1f} GiB，'
                          f'模型待下载 {needed/GIB:.1f} GiB，运行环境预留 {reserve/GIB:.0f} GiB')
        ensure_space(root, needed, reserve)
        def install_runtime():
            install_core(root)
            environment(root, recipe['plugins'])
            shutil.copyfile(BUNDLE / 'autodl/service.py', root / 'service.py')

        progress = DownloadProgress(files, pending)
        state['download'] = progress.snapshot()
        last_write = 0
        def report(dest, size):
            nonlocal last_write
            with state_lock:
                progress.record(dest, size)
                now = time.monotonic()
                if now - last_write >= 1 or size == progress.sizes[dest]:
                    last_write = now
                    state.update(phase='models', message='正在下载并校验模型 · ' + dest.name, download=progress.snapshot())
                    write_json(root / 'state.json', state)
        step('environment', '正在安装 ComfyUI、GPU 运行库和插件')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            runtime = pool.submit(install_runtime)
            remaining = len(pending)
            def get_model(entry):
                dest, spec = entry
                download(dest, spec, lambda size: report(dest, size))
            downloads = [pool.submit(get_model, entry) for entry in pending]
            try:
                for work in concurrent.futures.as_completed([runtime, *downloads]):
                    work.result()
                    if work is not runtime:
                        remaining -= 1
                        if not remaining and not runtime.done():
                            step('environment', '模型已校验，正在等待运行环境和插件安装完成')
            except Exception:
                for work in downloads:
                    work.cancel()
                raise
        step('environment', '模型、运行环境及插件已就绪')
        for folder in {p.split('/')[0] for p in files}:
            target = root / 'ComfyUI/models' / folder
            target.mkdir(parents=True, exist_ok=True)
            for name in files:
                if name.split('/')[0] != folder:
                    continue
                link = root / 'ComfyUI/models' / name
                link.parent.mkdir(parents=True, exist_ok=True)
                if not link.exists():
                    link.symlink_to(modelroot / name)
                elif link.resolve() != (modelroot / name).resolve():
                    raise RuntimeError('模型位置已被占用：' + name)
        step('nodes', '正在启动 ComfyUI，检查工作流节点及模型')
        start(root, port)
        wait_ready(api, root)
        try:
            names = api.inspect(recipe, files)
        except RuntimeError:
            # Newly added plugin modules only appear after a managed, idle server restarts.
            if not owned_service(root) or any(api.request('/queue').get(k) for k in ('queue_running', 'queue_pending')):
                raise
            import signal
            os.kill(int((root / 'service.pid').read_text()), signal.SIGTERM)
            for _ in range(100):
                if not owned_service(root) and not listening(port):
                    break
                time.sleep(.2)
            if listening(port) or owned_service(root):
                raise RuntimeError('请等待本工具启动的 ComfyUI 退出后重试')
            start(root, port)
            wait_ready(api, root)
            names = api.inspect(recipe, files)
    step('image', '正在生成验收素材图')
    key = state['run']
    def persist():
        write_json(root / 'state.json', state)
    image_info = state.setdefault('imageCheck', {})
    image = image_info.get('file')
    if image:
        from urllib.parse import urlencode
        check = urllib.request.Request(api.base + '/view?' + urlencode({
            'type': 'output', 'filename': Path(image).name, 'subfolder': str(Path(image).parent)}), method='HEAD')
        try:
            with api.http.open(check, timeout=10):
                pass
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            image_info.clear()
            state.pop('videoCheck', None)
            image = None
    if not image:
        graph = prepare_graph(recipe['image'], names, fp4, key)
        image = api.render(graph, '.png', 'ref/bbt_acceptance_' + key, image_info, persist)
        image_info['file'] = image
        persist()
    if recipe.get('video'):
        step('video', '正在用验收图生成约 4 秒的镜头')
        graph = prepare_graph(recipe['video'], names, fp4, key, image)
        result = api.render(graph, '.mp4', 'video/bbt_acceptance_' + key, state.setdefault('videoCheck', {}), persist)
    else:
        result = image
    # Capture byte identity through ComfyUI's HTTP interface, including pre-existing services.
    from urllib.parse import urlencode
    url = api.base + '/view?' + urlencode({'type': 'output', 'filename': Path(result).name, 'subfolder': str(Path(result).parent)})
    sha = hashlib.sha256()
    size = 0
    with api.http.open(url, timeout=60) as response:
        for block in iter(lambda: response.read(1024 * 1024), b''):
            sha.update(block)
            size += len(block)
    if not size:
        raise RuntimeError('验收文件为空')
    state.update(status='ready', phase='transfer', message='云端已生成，等待取回本机', file=result,
                 bytes=size, sha256=sha.hexdigest(), managed=not external_service)
    write_json(root / 'state.json', state)


def owned_service(root):
    pid = root / 'service.pid'
    return pid.is_file() and (Path('/proc') / pid.read_text().strip() / 'cwd').resolve() == root / 'ComfyUI'


def main():
    mode, raw_port = sys.argv[1:3]
    port = int(raw_port)
    if not 1 <= port <= 65535:
        raise ValueError('无效的端口')
    root = BUNDLE.parent.parent
    statefile = root / 'state.json'
    if mode == 'launch':
        lock = (root / 'setup.lock').open('a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            active = json.loads(statefile.read_text()) if statefile.is_file() else {}
            if active.get('bundle') != BUNDLE.name:
                raise SystemExit('这台实例正在运行另一项安装配置，请等待它结束后重试。')
            print('running')
            return
        previous = json.loads(statefile.read_text()) if statefile.exists() else {}
        reuse = previous.get('bundle') == BUNDLE.name and previous.get('status') in ('failed', 'running')
        state = previous if reuse else {'run': uuid.uuid4().hex}
        state.pop('download', None)
        state.update(bundle=BUNDLE.name, status='running', phase='check', message='正在检查云机器')
        write_json(statefile, state)
        with (root / 'setup.log').open('w') as log:
            subprocess.Popen([sys.executable, __file__, 'worker', raw_port, str(lock.fileno())],
                             pass_fds=(lock.fileno(),), stdin=subprocess.DEVNULL, stdout=log,
                             stderr=log, start_new_session=True)
        print('started')
        return
    state = json.loads(statefile.read_text())
    try:
        tmp = root / 'tmp'
        tmp.mkdir(exist_ok=True)
        os.environ['TMPDIR'] = str(tmp)
        execute(root, port, state)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        state.update(status='failed', message=f'{exc}。日志：{root}/setup.log')
        write_json(statefile, state)
        sys.exit(1)


if __name__ == '__main__':
    main()
