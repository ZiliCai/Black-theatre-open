"""Start the managed ComfyUI on loopback and return without keeping SSH open."""
import fcntl
import os
import socket
import subprocess
import sys
from pathlib import Path


def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def start(root, port):
    with (root / 'service.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if listening(port):
            return
        pidfile = root / 'service.pid'
        if pidfile.exists():
            proc = Path('/proc') / pidfile.read_text().strip()
            if (proc / 'cwd').resolve() == (root / 'ComfyUI').resolve():
                return
        with (root / 'comfy.log').open('ab') as log:
            proc = subprocess.Popen([str(root / 'venv/bin/python'), 'main.py', '--listen', '127.0.0.1',
                                     '--port', str(port)], cwd=root / 'ComfyUI', stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=log, start_new_session=True)
        pidfile.write_text(str(proc.pid))


if __name__ == '__main__':
    start(Path(__file__).resolve().parent, int(sys.argv[1]))
