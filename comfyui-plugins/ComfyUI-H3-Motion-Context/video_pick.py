"""Pick a rendered video from the output folder, with its first frame as the preview.

The picker is the frontend's image combo, so choosing an entry shows its picture
at once. The pictures are first frames cut from each video into the temp folder.
The node outputs the video's full path, ready for a path-based loader.
"""

import logging
import os
import re

import av

import folder_paths

log = logging.getLogger("h3_motion_context")

_NO_VIDEO = "(没有找到视频)"
_EXTS = (".mp4", ".mov", ".mkv", ".webm")
_THUMB_DIR = "h3vid"
_THUMB_WIDTH = 640
_MAX_LISTED = 200


def _videos():
    """(relative posix path, full path, mtime) of the videos under output, newest first."""
    root = folder_paths.get_output_directory()
    found = []
    for folder, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(_EXTS):
                full = os.path.join(folder, name)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                found.append((rel, full, os.path.getmtime(full)))
    found.sort(key=lambda v: v[2], reverse=True)
    return found[:_MAX_LISTED]


def _thumb_name(rel):
    stem = os.path.splitext(rel)[0]
    if stem.startswith("video/"):
        stem = stem[len("video/"):]
    return stem.replace("/", "__") + ".jpg"


def _first_frame(path):
    with av.open(path) as container:
        for frame in container.decode(video=0):
            return frame.to_image()
    return None


def _make_thumb(full, mtime, thumb_path):
    if os.path.exists(thumb_path) and os.path.getmtime(thumb_path) >= mtime:
        return True
    try:
        image = _first_frame(full)
        if image is None:
            return False
        if image.width > _THUMB_WIDTH:
            image = image.resize((_THUMB_WIDTH, round(image.height * _THUMB_WIDTH / image.width)))
        os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
        image.convert("RGB").save(thumb_path, quality=88)
        return True
    except Exception as e:  # a half-written or odd video must not break the whole list
        log.debug("h3_motion_context: no first frame for %s (%s)", full, e)
        return False


def _video_thumbs():
    """Combo entries for videos whose first frame could be cut, newest first."""
    thumb_root = os.path.join(folder_paths.get_temp_directory(), _THUMB_DIR)
    entries = []
    for rel, full, mtime in _videos():
        name = _thumb_name(rel)
        if _make_thumb(full, mtime, os.path.join(thumb_root, name)):
            entries.append("%s/%s [temp]" % (_THUMB_DIR, name))
    return entries or [_NO_VIDEO]


def _picked_video(value):
    """Full path of the video behind a combo value, or None."""
    name = re.sub(r"\s*\[\w+\]\s*$", "", str(value)).replace("\\", "/").split("/")[-1]
    for rel, full, _mtime in _videos():
        if _thumb_name(rel) == name:
            return full
    return None


class H3PickVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"video": (_video_thumbs(), {"image_upload": True, "image_folder": "temp"})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("video_path",)
    FUNCTION = "pick"
    CATEGORY = "MiniMax H3"
    DESCRIPTION = ("从输出文件夹里选一个已生成的视频,选中即预览它的第一帧。"
                   "输出完整路径,接到「视频路径」加载节点。新生成视频后按 R 刷新列表。")

    @classmethod
    def VALIDATE_INPUTS(cls, video):
        return True

    @classmethod
    def IS_CHANGED(cls, video):
        path = _picked_video(video)
        return os.path.getmtime(path) if path else ""

    def pick(self, video):
        path = _picked_video(video)
        if path is None:
            raise ValueError("没有找到所选的视频。新生成的视频请按 R 刷新列表,再重新选择。")
        return (path,)


NODE_CLASS_MAPPINGS = {"H3PickVideo": H3PickVideo}
NODE_DISPLAY_NAME_MAPPINGS = {"H3PickVideo": "H3 Pick Video (选视频并预览首帧)"}
