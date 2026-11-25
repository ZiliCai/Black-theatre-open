"""模型放在数据盘。只有通过清单校验的文件才会出现在 ComfyUI 的模型目录。"""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import ranges

GIB = 1024 ** 3
FP4 = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
INT8 = 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors'


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def inventory(catalog, workflows, fp4):
    paths = {path for name in workflows for path in catalog['workflows'][name]}
    return {path: catalog['files'][path] for path in sorted(
        {p if fp4 else p.replace(FP4, INT8) for p in paths})}


def matches(path, spec):
    return path.is_file() and path.stat().st_size == spec['bytes'] and digest(path) == spec['sha256']


def _stamp(path):
    return path.with_name('.' + path.name + '.verified')


def remember(path, spec):
    """Record a verified file so a later run (often on a paid GPU) need not hash 60+ GiB again."""
    info = path.stat()
    _stamp(path).write_text(json.dumps([info.st_size, info.st_mtime_ns, spec['sha256']]))


def known_good(path, spec):
    try:
        info = path.stat()
        if json.loads(_stamp(path).read_text()) == [info.st_size, info.st_mtime_ns, spec['sha256']]:
            return True
    except (OSError, ValueError):
        pass
    if matches(path, spec):
        remember(path, spec)
        return True
    return False


def prefer_fp4(root, capable):
    """A GPU-less download run stages the INT8 encoder. Use it instead of fetching FP4 on the paid GPU."""
    folder = root / 'text_encoders'
    staged = (folder / INT8).is_file() and not (folder / FP4).exists() and not (folder / (FP4 + '.part')).exists()
    return capable and not staged


def plan(root, models, external, notify):
    needed = 0
    pending = []
    for name, spec in models.items():
        dest = root / name
        notify('核对 ' + dest.name)
        if dest.exists() or dest.is_symlink():
            if not known_good(dest, spec):
                raise RuntimeError(f'已有文件校验失败，请移开后重试：{dest}')
            continue
        other = external / name
        if matches(other, spec):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.symlink_to(other)
            remember(dest, spec)
            continue
        part = dest.with_suffix(dest.suffix + '.part')
        partial = ranges.saved_size(part, spec)
        needed += spec['bytes'] - (partial if partial <= spec['bytes'] else 0)
        pending.append((dest, spec))
    return needed, pending


def ensure_space(directory, needed, reserve):
    free = shutil.disk_usage(directory).free
    if needed + reserve > free:
        raise RuntimeError(f'数据盘空间不足，还需增加 {(needed+reserve-free)/GIB:.1f} GiB。'
                           f'模型待下载 {needed/GIB:.1f} GiB，环境及临时空间预留 {reserve/GIB:.1f} GiB，'
                           f'当前可用 {free/GIB:.1f} GiB。可扩容或改选较小的工作流。')


def download(dest, spec, notify):
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + '.part')
    if spec['bytes'] >= 2 * ranges.CHUNK:
        for url in spec['urls']:
            try:
                ranges.transfer(part, spec, url, notify)
            except (OSError, ValueError) as exc:
                print(f'分段下载换源：{type(exc).__name__}: {str(exc)[:300]}', flush=True)
                continue
            if matches(part, spec):
                notify(spec['bytes'])
                os.replace(part, dest)
                ranges.journal(part).unlink(missing_ok=True)
                remember(dest, spec)
                return
            part.unlink(missing_ok=True)
            notify(0)
            ranges.journal(part).unlink(missing_ok=True)
        ranges.contiguous(part, spec)
    for url in spec['urls']:
        # A truncated transfer is resumable even from another mirror of this digest.
        for attempt in range(2):
            size = part.stat().st_size if part.exists() else 0
            if size > spec['bytes']:
                part.unlink()
                size = 0
            notify(size)
            if size < spec['bytes']:
                result = subprocess.Popen(['curl', '-fsSL', '--connect-timeout', '15', '--speed-time', '45',
                                         '--speed-limit', '8192', '--retry', '2', '-C', '-', '-o', str(part), url])
                while True:
                    try:
                        result.wait(timeout=2)
                        break
                    except subprocess.TimeoutExpired:
                        notify(part.stat().st_size if part.is_file() else 0)
                if result.returncode:
                    if result.returncode in (33, 36) and size and attempt == 0:
                        part.unlink(missing_ok=True)
                        continue
                    break
            if matches(part, spec):
                notify(spec['bytes'])
                os.replace(part, dest)
                remember(dest, spec)
                return
            if part.is_file() and part.stat().st_size >= spec['bytes']:
                part.unlink()
                notify(0)
            else:
                break
    raise RuntimeError('模型下载或 SHA-256 校验失败：' + dest.name + '。检查云端网络后可继续。')
