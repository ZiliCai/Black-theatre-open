"""H3 Motion Context.

Clip chaining for MiniMax H3: pin the tail of the previous clip, picture
and sound, so the next clip genuinely continues it.

This registers the nodes and nothing else. Keyframe anchors at any frame
index and keyframe/ref coexistence are native to ComfyUI now. The one
remaining ComfyUI patch

  patch_layout   moves pinned audio onto the clip's own timeline

installs itself the first time a Motion Context node pins audio, not at
import. ComfyUI imports every folder in custom_nodes at startup, and
patching there would put this pack's wrapper in the path of every H3
graph on the machine. Installing on first use means having the pack
installed changes nothing until you actually chain a clip.

The patch is also gated on this pack's own marker, so even once installed
it leaves unrelated H3 graphs bit-identical to stock.

It self-tests against the live ComfyUI code before it commits. If a test
fails the node refuses to run and says why, so an upstream change
produces a clear error rather than a silently wrong render.
"""

import logging

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .probe_node import (
    NODE_CLASS_MAPPINGS as _PROBE_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _PROBE_NAMES,
)

from .video_pick import (
    NODE_CLASS_MAPPINGS as _VIDEO_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _VIDEO_NAMES,
)

NODE_CLASS_MAPPINGS.update(_PROBE_CLASSES)
NODE_DISPLAY_NAME_MAPPINGS.update(_PROBE_NAMES)
NODE_CLASS_MAPPINGS.update(_VIDEO_CLASSES)
NODE_DISPLAY_NAME_MAPPINGS.update(_VIDEO_NAMES)

logging.getLogger("h3_motion_context").info(
    "h3_motion_context: nodes registered. ComfyUI patches install on the "
    "first run of a Motion Context node.")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
