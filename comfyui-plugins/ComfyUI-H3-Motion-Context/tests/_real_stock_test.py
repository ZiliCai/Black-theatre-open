"""Layout patch against the REAL comfy.ldm.minimax.model, no mocks.

Run with ComfyUI's own interpreter from the ComfyUI folder:

    ..\\python_embeded\\python.exe -I tests\\_real_stock_test.py

The mock harness fakes stock, so it can only prove the patch matches the
stock its author remembered. This one fails the day ComfyUI moves again.
"""

import importlib.util
import os
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
COMFY = os.path.dirname(os.path.dirname(PLUGIN))
sys.path.insert(0, COMFY)

import comfy.ldm.minimax.model as mm  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "patch_layout", os.path.join(PLUGIN, "patch_layout.py"))
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)

TEXT_LEN, LATENT_T, LH, LW, AUDIO_T = 7, 7, 22, 38, 16
FRAME_COUNT = sum(mm.FRAME_PER_TOKEN[k % 5] for k in range(LATENT_T))
stock_init = mm.PackedLayout.__init__


def cond_ts(lay):
    return [float(lay.position_ids[a, 0]) for a, _, k in lay.segments if k == "cond"]


def kf(index):
    return {"resolved_frame_index": index,
            "latent": torch.zeros(1, 24, 1, LH, LW)}


assert pl.apply_patch(), "layout patch refused against the live ComfyUI"
assert mm.PackedLayout.__init__ is not stock_init
print("1. patch applies against live stock")

# 2. interior anchors are native: sent as real indices, they land on
# text_len + FRAME_RESCALE * index with nothing rewritten
idx = [0, 10, 15, FRAME_COUNT - 1]
lay = mm.PackedLayout(TEXT_LEN, LATENT_T, LH, LW, AUDIO_T, keyframes=[kf(i) for i in idx])
for t, i in zip(cond_ts(lay), idx):
    assert abs(t - (TEXT_LEN + mm.FRAME_RESCALE * i)) < 1e-9, (t, i)
print("2. interior anchors at real indices:", [round(t, 3) for t in cond_ts(lay)])

# 3. unmarked graphs are bit-identical to stock
ref_plain = [{"kind": "audio", "ref_audio_t": 8}]
a = mm.PackedLayout(TEXT_LEN, LATENT_T, LH, LW, AUDIO_T, keyframes=[kf(3)], refs=ref_plain)
b = mm.PackedLayout.__new__(mm.PackedLayout)
stock_init(b, TEXT_LEN, LATENT_T, LH, LW, AUDIO_T, keyframes=[kf(3)], refs=ref_plain)
assert torch.equal(a.position_ids, b.position_ids)
print("3. unmarked layout identical to stock")

# 4. a marked audio ref ends at the requested target frame, and only its rows move
rt, end_frame = 8, 4
marked = [{"kind": "audio", "ref_audio_t": rt, pl.MC_AUDIO_KEY: end_frame}]
c = mm.PackedLayout(TEXT_LEN, LATENT_T, LH, LW, AUDIO_T, keyframes=[kf(3)], refs=marked)
s, e = pl._ref_segment_map(c, marked)[0]["ref_audio"]
origin = pl._target_origin(c)
assert abs(float(c.position_ids[s, 0]) + rt - (origin + mm.FRAME_RESCALE * end_frame)) < 1e-9
moved = (c.position_ids[:, 0] != a.position_ids[:, 0]).nonzero().flatten().tolist()
assert moved == list(range(s, e)), moved[:8]
print("4. audio window ends at target frame %d, rows %d..%d moved" % (end_frame, s, e - 1))
print("real-stock test passed")
