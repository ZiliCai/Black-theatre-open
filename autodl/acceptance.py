"""在远端执行真实验收，即使桌面程序关闭也能生成结果。"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import PurePosixPath

from models import FP4, INT8


class Comfy:
    def __init__(self, port):
        self.base = 'http://127.0.0.1:' + str(port)
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, route, body=None):
        req = urllib.request.Request(self.base + route, headers={'Content-Type': 'application/json'},
                                     data=None if body is None else json.dumps(body).encode())
        try:
            with self.http.open(req, timeout=30) as res:
                return json.load(res)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'{route} HTTP {exc.code}: {exc.read(2500).decode(errors="replace")}') from exc

    def inspect(self, recipe, files):
        nodes = self.request('/object_info')
        absent = sorted(set(recipe['nodes']) - nodes.keys())
        if absent:
            raise RuntimeError('缺少工作流节点：' + '、'.join(absent))
        all_names = {}
        folders = {f.lower(): f for f in self.request('/models')}
        for folder in sorted({key.split('/')[0] for key in files}):
            names = self.request('/models/' + folders.get(folder.lower(), folder))
            for item in names:
                name = item.replace('\\', '/')
                all_names.setdefault(PurePosixPath(name).name, name)
                all_names[name] = name
        missing = [name for name in files if PurePosixPath(name).name not in all_names]
        if missing:
            raise RuntimeError('ComfyUI 未识别模型：' + '、'.join(missing))
        return all_names

    def render(self, graph, suffix, prefix, checkpoint, persist):
        # Persist the prompt id before polling. A retry can collect a completed cloud job.
        pid = checkpoint.get('prompt')
        history = None
        if pid:
            history = self.request('/history/' + pid).get(pid)
            queue = self.request('/queue') if not history else {}
            queued = any(row[1] == pid for k in ('queue_running', 'queue_pending') for row in queue.get(k, []))
            if not queued and (not history or history.get('status', {}).get('status_str') != 'success'):
                pid = None
                history = None
        if not pid:
            pid = self.request('/prompt', {'prompt': graph, 'client_id': prefix})['prompt_id']
            checkpoint['prompt'] = pid
            persist()
        until = time.monotonic() + 3600
        while time.monotonic() < until:
            history = history or self.request('/history/' + pid).get(pid)
            if not history:
                time.sleep(3)
                continue
            status = history.get('status', {})
            if status.get('status_str') != 'success':
                errors = [f'{v.get("node_type", "")} {v.get("exception_message", "")}'
                          for k, v in status.get('messages', []) if k == 'execution_error']
                raise RuntimeError('生成失败：' + (' '.join(errors) or str(status.get('status_str'))))
            for node in history.get('outputs', {}).values():
                for items in node.values():
                    if not isinstance(items, list):
                        continue
                    for item in items:
                        if not isinstance(item, dict) or item.get('type') != 'output':
                            continue
                        path = PurePosixPath(item.get('subfolder', '')) / item.get('filename', '')
                        if str(path).startswith(prefix + '_') and path.suffix.lower() == suffix:
                            return str(path)
            raise RuntimeError('工作流已结束，但没有生成验收文件。')
        raise RuntimeError('等待验收镜头超过一小时，请检查 ComfyUI 队列和日志。')


def prepare_graph(graph, names, fp4, run, image=None):
    graph = json.loads(json.dumps(graph))
    for node in graph.values():
        for key, value in list(node['inputs'].items()):
            if not isinstance(value, str):
                continue
            if value.endswith(('.safetensors', '.gguf')):
                name = value.replace('\\', '/')
                if not fp4:
                    name = name.replace(FP4, INT8)
                node['inputs'][key] = names[PurePosixPath(name).name]
            elif value == 'ref/bbt_acceptance.png [output]' and image:
                node['inputs'][key] = image + ' [output]'
            elif value.endswith('/bbt_acceptance'):
                node['inputs'][key] = value + '_' + run
    return graph
