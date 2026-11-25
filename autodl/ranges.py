"""Parallel HTTP ranges with a durable chunk map; the caller verifies the whole file."""
import concurrent.futures
import json
import os
import threading
import time
import urllib.request
import urllib.parse
from contextlib import closing

try:
    import requests
except ImportError:  # minimal Linux images can use the standard library
    requests = None

CHUNK = 16 * 1024 * 1024
# Connections per file; setup.py fetches three files at once. On an AutoDL instance (~100 Mbit/s)
# 3 x 4 connections fill the link, while 3 x 8 or 3 x 16 stalled with no chunk finishing for minutes.
WORKERS = 4
ATTEMPTS = 6


def journal(part):
    return part.with_suffix(part.suffix + '.json')


def completed(part, spec):
    meta = journal(part)
    if not part.exists():
        return set()
    if meta.exists():
        saved = json.loads(meta.read_text())
        if saved['sha256'] != spec['sha256']:
            return set()
        return {i for i in saved['chunks'] if min((i + 1) * CHUNK, spec['bytes']) <= part.stat().st_size}
    return set(range(min(part.stat().st_size, spec['bytes']) // CHUNK))


def saved_size(part, spec):
    if not journal(part).exists():
        return min(part.stat().st_size, spec['bytes']) if part.exists() else 0
    return sum(min(CHUNK, spec['bytes'] - i * CHUNK) for i in completed(part, spec))


def resolved_source(url):
    # ModelScope's signed CDN link supports multiple ranges. Resolve it once per file.
    if urllib.parse.urlsplit(url).hostname not in ('modelscope.cn', 'www.modelscope.cn'):
        return url
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=0-0'}), timeout=12) as r:
            if r.status == 206:
                return r.geturl()
    except OSError:
        pass
    return url


def transfer(part, spec, url, notify):
    total = spec['bytes']
    direct = resolved_source(url)
    count = (total + CHUNK - 1) // CHUNK
    done = completed(part, spec)
    indices = iter(i for i in range(count) if i not in done)
    stop = threading.Event()
    lock = threading.Lock()
    last_notice = 0.0
    meta = journal(part)

    def save():
        temp = meta.with_suffix('.tmp')
        temp.write_text(json.dumps({'sha256': spec['sha256'], 'chunks': sorted(done)}))
        os.replace(temp, meta)

    part.touch(exist_ok=True)
    save()

    def worker(session):
        nonlocal last_notice
        while not stop.is_set():
            with lock:
                index = next(indices, None)
            if index is None:
                return
            start, end = index * CHUNK, min(total, (index + 1) * CHUNK) - 1
            for attempt in range(ATTEMPTS):
                if stop.is_set():
                    return
                try:
                    # Later attempts go through the original URL again to refresh a signed CDN link.
                    source = direct if attempt < ATTEMPTS // 2 else url
                    headers = {'Range': f'bytes={start}-{end}', 'Accept-Encoding': 'identity'}
                    if session:
                        response = session.get(source, headers=headers, timeout=(10, 30), stream=True)
                        code = response.status_code
                        read = response.raw.read
                    else:
                        response = urllib.request.urlopen(urllib.request.Request(source, headers=headers), timeout=30)
                        code = response.status
                        read = response.read
                    with closing(response):
                        if code >= 400:
                            raise OSError(f'HTTP {code}')
                        if code != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{total}':
                            raise ValueError('源不支持精确的分段下载')
                        with part.open('r+b') as out:
                            out.seek(start)
                            remaining = end - start + 1
                            while remaining:
                                if stop.is_set():
                                    return
                                data = read(min(1024 * 1024, remaining))
                                if not data:
                                    raise OSError('下载提前中断')
                                out.write(data)
                                remaining -= len(data)
                    break
                except Exception as exc:
                    if attempt == ATTEMPTS - 1 or isinstance(exc, ValueError):
                        stop.set()
                        raise OSError(f'该源未能提供完整分段：{type(exc).__name__}: {str(exc)[:200]}') from exc
                    time.sleep(min(2 ** attempt, 15))
            with lock:
                done.add(index)
                save()
                if time.monotonic() - last_notice > 2 or len(done) == count:
                    notify(sum(min(CHUNK, total - n * CHUNK) for n in done))
                    last_notice = time.monotonic()

    def fetch_chunks():
        if requests:
            with requests.Session() as session:
                worker(session)
        else:
            worker(None)

    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        jobs = [pool.submit(fetch_chunks) for _ in range(min(WORKERS, count - len(done)))]
        for job in concurrent.futures.as_completed(jobs):
            job.result()


def contiguous(part, spec):
    """Convert the partial file to a prefix for servers that only support curl resume."""
    if journal(part).exists():
        chunks = completed(part, spec)
        first = 0
        while first in chunks:
            first += 1
        if len(chunks) > first:
            raise RuntimeError('下载源暂时无法继续。已保留完成的分段，稍后重试：' + part.name)
        with part.open('r+b') as out:
            out.truncate(min(first * CHUNK, spec['bytes']))
        journal(part).unlink()
