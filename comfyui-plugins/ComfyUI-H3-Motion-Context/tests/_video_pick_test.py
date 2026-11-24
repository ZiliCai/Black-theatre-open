r"""The video picker lists output videos newest first, cuts first frames, and returns full paths.

Run from the ComfyUI folder:
  ..\python_embeded\python.exe -I custom_nodes\ComfyUI-H3-Motion-Context\tests\_video_pick_test.py
"""
import importlib
import os
import sys
import tempfile
import time

sys.path.insert(0, os.getcwd())
import av
import folder_paths
import numpy as np
from PIL import Image

out = tempfile.mkdtemp()
tmp = tempfile.mkdtemp()
folder_paths.set_output_directory(out)
folder_paths.set_temp_directory(tmp)
sys.path.insert(0, os.path.join(os.getcwd(), "custom_nodes"))
vp = importlib.import_module("ComfyUI-H3-Motion-Context.video_pick")


def make_video(path, first_rgb, n=6, size=(128, 96)):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with av.open(path, "w") as c:
        s = c.add_stream("libx264", rate=24)
        s.width, s.height, s.pix_fmt = size[0], size[1], "yuv420p"
        for i in range(n):
            arr = np.zeros((size[1], size[0], 3), np.uint8)
            arr[:] = first_rgb if i == 0 else (0, 0, 255)
            for p in s.encode(av.VideoFrame.from_ndarray(arr, format="rgb24")):
                c.mux(p)
        for p in s.encode():
            c.mux(p)


# nothing yet
assert vp._video_thumbs() == [vp._NO_VIDEO]

old = os.path.join(out, "video", "minimax-h3-demo_00001_.mp4")
new = os.path.join(out, "video", "minimax-h3-demo_00002_.mp4")
up = os.path.join(out, "video", "seedvr2", "up_00001_.mp4")
make_video(old, (255, 0, 0))
time.sleep(0.05)
make_video(new, (0, 255, 0))
time.sleep(0.05)
make_video(up, (255, 255, 0))
open(os.path.join(out, "video", "notes.txt"), "w").close()
broken = os.path.join(out, "video", "broken.mp4")
open(broken, "wb").write(b"not a video")

entries = vp._video_thumbs()
assert entries == [
    "h3vid/seedvr2__up_00001_.jpg [temp]",
    "h3vid/minimax-h3-demo_00002_.jpg [temp]",
    "h3vid/minimax-h3-demo_00001_.jpg [temp]",
], entries  # newest first, the broken file and the txt are left out

# the thumbnail is the FIRST frame (green), not a later one (blue)
thumb = os.path.join(tmp, "h3vid", "minimax-h3-demo_00002_.jpg")
r, g, b = Image.open(thumb).convert("RGB").getpixel((60, 40))
assert g > 200 and r < 60 and b < 60, (r, g, b)

# picking gives the real full path, with or without the [temp] tag
node = vp.H3PickVideo()
(path,) = node.pick(entries[1])
assert os.path.samefile(path, new), path
(path,) = node.pick("h3vid/seedvr2__up_00001_.jpg")
assert os.path.samefile(path, up), path

# a stale entry is refused with a clear message
try:
    node.pick("h3vid/gone.jpg [temp]")
    raise AssertionError("expected ValueError")
except ValueError as e:
    assert "R" in str(e)
assert vp.H3PickVideo.VALIDATE_INPUTS("h3vid/gone.jpg [temp]") is True

# IS_CHANGED follows the video file, not the thumbnail
before = vp.H3PickVideo.IS_CHANGED(entries[1])
os.utime(new, (before + 10, before + 10))
assert vp.H3PickVideo.IS_CHANGED(entries[1]) == before + 10
assert vp.H3PickVideo.IS_CHANGED("h3vid/gone.jpg") == ""

# a re-listed video whose file was replaced gets a fresh thumbnail
make_video(new, (255, 0, 255))
os.utime(new, (before + 20, before + 20))
vp._video_thumbs()
r, g, b = Image.open(thumb).convert("RGB").getpixel((60, 40))
assert r > 200 and b > 200 and g < 60, (r, g, b)

# the input spec is the image combo with a temp folder
spec = vp.H3PickVideo.INPUT_TYPES()["required"]["video"]
assert spec[1] == {"image_upload": True, "image_folder": "temp"}
print("video picker tests OK")
