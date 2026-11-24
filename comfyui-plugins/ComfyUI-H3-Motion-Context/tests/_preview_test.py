r"""Save keeps the last frame beside the latent; Load shows it with a caption.

Run from the ComfyUI folder:
  ..\python_embeded\python.exe -I custom_nodes\ComfyUI-H3-Motion-Context\tests\_preview_test.py
"""
import importlib
import os
import sys
import tempfile

sys.path.insert(0, os.getcwd())
import folder_paths
import torch
from PIL import Image

out = tempfile.mkdtemp()
folder_paths.set_output_directory(out)
folder_paths.set_temp_directory(tempfile.mkdtemp())
sys.path.insert(0, os.path.join(os.getcwd(), "custom_nodes"))
nodes = importlib.import_module("ComfyUI-H3-Motion-Context.nodes")

video = torch.zeros(1, 24, 7, 42, 76)          # 1216x672, 7 latent steps -> 22 frames
audio = torch.zeros(1, 32, 2, 37)
latent = {"samples": [video, audio]}
frames = torch.rand(22, 672, 1216, 3)
frames[-1] = torch.tensor([1.0, 0.0, 0.0])      # the last frame is pure red

saver = nodes.MiniMaxH3MotionContextSaveLatent()
loader = nodes.MiniMaxH3MotionContextLoadLatent()

(p,) = saver.save(latent, "h3_context/clip", clip_index=2, images=frames)
thumb = os.path.splitext(p)[0] + ".jpg"
assert os.path.isfile(thumb), thumb
r, g, b = Image.open(thumb).convert("RGB").getpixel((600, 300))
assert r > 230 and g < 30 and b < 30, (r, g, b)   # last frame, not the first

(q,) = saver.save(latent, "h3_context/clip", clip_index=0)   # no images wired
import re
assert re.search(r"clip_\d{4}-\d{6}_\.safetensors$", q), q  # named by save time
assert q.endswith("_.safetensors") and not os.path.exists(os.path.splitext(q)[0] + ".jpg")

shown = loader.load("h3_context", clip_index=2)["ui"]["images"][0]
assert shown["type"] == "temp", shown
img = Image.open(os.path.join(folder_paths.get_temp_directory(), shown["filename"]))
assert img.height > 100 and img.width >= 460, img.size
img.save(os.environ["PREVIEW_OUT"]) if os.environ.get("PREVIEW_OUT") else None

# a slot with no thumbnail (older save) still previews, with a note instead of a picture
os.remove(thumb)
shown2 = loader.load("h3_context", clip_index=2)["ui"]["images"][0]
assert os.path.isfile(os.path.join(folder_paths.get_temp_directory(), shown2["filename"]))
# the Load list shows the time-named saves, newest first, and picking one loads it
options = loader.INPUT_TYPES()["optional"]["clip_file"][0]
assert options[0] == nodes._PICK_BY_INDEX and os.path.basename(q) in options, options
assert options[1] == os.path.basename(q), options  # q was saved last
picked = loader.load("h3_context", clip_index=0, clip_file=os.path.basename(q))
assert picked["result"][0]["samples"][0].shape == video.shape
assert os.path.basename(q) in loader.IS_CHANGED("h3_context", 0, os.path.basename(q))
assert loader.VALIDATE_INPUTS(clip_file="gone.safetensors") is True
try:
    loader.load("h3_context", clip_index=0, clip_file="gone.safetensors")
except FileNotFoundError as e:
    assert "gone" in str(e)
else:
    raise AssertionError("a deleted pick did not say so")
# the Pick node lists clips that have a picture, newest first, and loads the chosen one
picker = nodes.MiniMaxH3MotionContextPickLatent()
assert picker.INPUT_TYPES()["required"]["clip"][0] == [nodes._NO_CLIP]  # no picture, nothing to pick
(r3,) = saver.save(latent, "h3_context/clip", clip_index=3, images=frames)
q = r3
thumbs = picker.INPUT_TYPES()["required"]["clip"][0]
assert thumbs[0] == "h3_context/" + os.path.splitext(os.path.basename(q))[0] + ".jpg [output]", thumbs
assert picker.INPUT_TYPES()["required"]["clip"][1] == {"image_upload": True, "image_folder": "output"}
got = picker.load(thumbs[0])
assert got["result"][0]["samples"][0].shape == video.shape and got["ui"]["images"]
assert os.path.basename(q) in picker.IS_CHANGED(thumbs[0])
try:
    picker.load("h3_context/nothing.jpg")
except FileNotFoundError as e:
    assert "R" in str(e)
else:
    raise AssertionError("a missing pick did not say so")
print("preview: last frame saved beside the latent, shown with caption, missing thumbnail handled")
