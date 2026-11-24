"""Put a pinned audio reference on the clip's own timeline.

Keyframe anchors at any frame index are native to ComfyUI now: stock
builds cond rows at text-origin + FRAME_RESCALE * resolved_frame_index and
places them after any reference blocks, so the old first/last-only
restriction, and the rewrite that lifted it, are gone.

What stock still lacks is a way to say "this audio reference ends at
target frame N". It lays an audio ref out from the reference cursor, which
reads to the model as a separate clip to imitate rather than this clip
continued. After the stock constructor returns we translate the marked
block's time coordinates so its window ends at the requested frame. RoPE is
built at forward time from position_ids, so this lands before anything
reads it.

We do NOT rewrite the source of PackedLayout.__init__: that would be a copy
of a long constructor that rots on the next ComfyUI change.
"""

import logging

import torch

import comfy.ldm.minimax.model as mm

MC_AUDIO_KEY = "motion_context_audio_end_frame"

# Marker set on our wrapper so a second copy of this file, vendored into
# another pack, can recognise it and stand down instead of wrapping it.
# Shared ABI across every pack that vendors this patch, exactly like
# MC_AUDIO_KEY: rename it in all of them or in none.
PATCH_MARKER = "_h3_motion_context_layout_patch"
_LOG = logging.getLogger("h3_motion_context")

_orig_init = None
_applied = False


REF_SEGMENT_KINDS = ("ref_img", "ref_audio")


def _target_origin(layout):
    """The coordinate the target clip starts at, read off the built layout.

    Stock lays reference blocks out from a cursor that starts at text_len,
    and the target rows take the cursor's final value as their origin.
    Reading it back out of the layout instead of recomputing the cursor
    means there is nothing to keep in sync: if upstream changes how a
    reference kind advances the cursor, the number here changes with it.
    The target video segment is always last and always has at least one
    latent step, and _video_grid puts its first row exactly on the cursor.
    """
    a, b, kind = layout.segments[-1]
    if kind != "video" or b <= a:
        raise RuntimeError(
            "h3_motion_context: expected the target video rows to be the "
            "last layout segment, found %r spanning %d rows. Upstream "
            "layout change; refusing to rewrite positions." % (kind, b - a))
    return float(layout.position_ids[a, 0])


def _expected_ref_segments(blk):
    """The segment kinds one reference block emits, in emission order.

    Mirrors the branches of the stock constructor:
      image         one ref_img
      audio         one ref_audio, or nothing at all when the window is
                    empty (stock skips the segment but still advances)
      video         the block's audio rows pack immediately before its
      video_audio   video rows, so ref_audio then ref_img
    """
    kind = blk.get("kind")
    if kind == "image":
        return ("ref_img",)
    if kind == "audio":
        return ("ref_audio",) if int(blk.get("ref_audio_t", 0)) > 0 else ()
    if kind in ("video", "video_audio"):
        if int(blk.get("ref_audio_t", 0)) > 0:
            return ("ref_audio", "ref_img")
        return ("ref_img",)
    raise RuntimeError(
        "h3_motion_context: unknown reference kind %r; cannot tell which "
        "layout rows belong to it." % (kind,))


def _ref_segment_map(layout, refs):
    """Which rows each reference block actually produced.

    Returns {block_index: {segment_kind: (start, stop)}}.

    This is the whole point of the multi-reference support. The rows of
    one reference block could be found by working out the coordinate span
    it ought to occupy and selecting everything inside it, but that means
    duplicating stock's cursor arithmetic and then hoping nothing else
    shares the range. Stock keyframe rows genuinely do land inside it,
    which is why the coordinate approach needed an explicit exclusion for
    them, and a second reference of the same kind would need another.

    The layout already publishes a segment table, and reference blocks
    emit their segments in list order, so the mapping is exact. Nothing
    is inferred from coordinates and nothing has to be excluded.
    """
    ref_segs = [(a, b, k) for a, b, k in layout.segments
                if k in REF_SEGMENT_KINDS]
    want = [(i, k) for i, blk in enumerate(refs or [])
            for k in _expected_ref_segments(blk)]
    if len(want) != len(ref_segs):
        raise RuntimeError(
            "h3_motion_context: %d reference blocks should have produced %d "
            "layout segments, the layout has %d. Upstream layout change; "
            "refusing to move rows." % (len(refs or []), len(want),
                                        len(ref_segs)))
    out = {}
    for (i, kind), (a, b, got) in zip(want, ref_segs):
        if got != kind:
            raise RuntimeError(
                "h3_motion_context: reference block %d (%r) should have "
                "emitted a %s segment, the layout has %s. Upstream layout "
                "change; refusing to move rows."
                % (i, refs[i].get("kind"), kind, got))
        out.setdefault(i, {})[kind] = (a, b)
    return out


def _fixup_audio(layout, text_len, refs):
    """Move the marked audio ref's rows onto the target timeline.

    References and keyframes carry identical row machinery; what makes the
    model read a reference as "a separate clip to imitate" rather than
    "this clip, continued" is that its coordinates sit in a span before
    the target. That distinction decided continuation vs reproduction for
    video, and seam analysis showed the audio reference producing
    phase-unlocked imitation. So: keep the audio on the reference path for
    construction and payload (rows built, latents filled, all stock code
    untouched) and TRANSLATE its time coordinates so the window END lands
    at target frame MC_AUDIO_KEY, the same instant the pinned video ends.

    Translation, not per-row assignment: new = old + shift preserves
    whatever intra-block structure stock built. Stock lays an audio
    reference out channel-major, the same rt coordinates once per stereo
    channel, and a uniform shift keeps that intact without this code
    having to know about it.

    The block keeps its place in the cursor, so the coordinates it vacates
    are left empty. An audio window longer than the video window therefore
    spills backwards into empty space rather than onto the text rows, so
    the collision that made `before` mode fail for video does not arise.

    Other reference blocks are untouched. A Ref2VA graph can carry its own
    image, video and audio references and this moves only the one block
    the node marked, wherever in the list it sits.
    """
    marked = [i for i, r in enumerate(refs or [])
              if r.get(MC_AUDIO_KEY) is not None]
    if len(marked) != 1:
        raise RuntimeError(
            "h3_motion_context: audio timeline placement needs exactly one "
            "reference marked with %s; the layout has %d references and %d "
            "marked. If this appeared during startup, check for more than "
            "one H3 Motion Context folder in custom_nodes."
            % (MC_AUDIO_KEY, len(refs or []), len(marked)))
    idx = marked[0]
    blk = refs[idx]
    if blk.get("kind") != "audio":
        raise RuntimeError(
            "h3_motion_context: %s set on a %r ref; only audio refs can be "
            "moved onto the timeline." % (MC_AUDIO_KEY, blk.get("kind")))
    rt = int(blk.get("ref_audio_t", 0))
    if rt <= 0:
        return

    seg = _ref_segment_map(layout, refs).get(idx, {}).get("ref_audio")
    if seg is None:
        raise RuntimeError(
            "h3_motion_context: the marked audio reference produced no "
            "ref_audio segment. Upstream layout change; refusing to move "
            "rows.")
    a, b = seg
    if b - a != 2 * rt:
        # stock emits exactly rt rows per stereo channel. An exact count
        # rather than a tolerance: if this ever changes, the intra-block
        # structure a translation is preserving has changed with it.
        raise RuntimeError(
            "h3_motion_context: the marked audio reference has %d rows for "
            "%d latent steps, expected %d (stereo, channel-major). Upstream "
            "layout change; refusing to move rows." % (b - a, rt, 2 * rt))

    target_origin = _target_origin(layout)
    slot_start = float(layout.position_ids[a, 0])
    end_frame = float(blk[MC_AUDIO_KEY])
    # window end at target time FRAME_RESCALE * end_frame, width rt steps
    desired_start = target_origin + mm.FRAME_RESCALE * end_frame - float(rt)
    layout.position_ids[a:b, 0] = (layout.position_ids[a:b, 0]
                                   + (desired_start - slot_start))


def _patched_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
                  keyframes=None, refs=None):
    _orig_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
               keyframes=keyframes, refs=refs)
    if bool(refs) and any(r.get(MC_AUDIO_KEY) is not None for r in refs):
        _fixup_audio(self, text_len, refs)
    # not marked: stock graph, leave it exactly as built


def _self_test():
    """Check the layout still behaves the way the audio move assumes.

    Interior anchors and the reference offset are stock behaviour now, but
    the move reads the target origin back out of the layout and locates the
    marked block through the segment table, so both are verified here along
    with the move itself, alone and inside a multi-reference Ref2VA layout.
    If ComfyUI changes the position maths or the segment table underneath
    us this fails and the patch is not applied.
    """
    text_len, latent_t, lh, lw, audio_t = 7, 7, 22, 38, 16

    def kf(index):
        return {"resolved_frame_index": index,
                "latent": torch.zeros(1, 24, 1, lh, lw)}

    def build(keyframes=None, refs=None, move=False):
        lay = mm.PackedLayout.__new__(mm.PackedLayout)
        _orig_init(lay, text_len, latent_t, lh, lw, audio_t,
                   keyframes=keyframes, refs=refs)
        if move:
            _fixup_audio(lay, text_len, refs)
        return lay

    def cond_ts(lay):
        return [float(lay.position_ids[a, 0])
                for a, _, k in lay.segments if k == "cond"]

    # 1. a run of anchors lands on strictly increasing coordinates, each at
    # text_len + FRAME_RESCALE * its frame index
    run = [kf(i) for i in range(4)]
    c = build(keyframes=run)
    ts = cond_ts(c)
    if len(ts) != len(run):
        raise RuntimeError("expected %d cond segments, got %d" % (len(run), len(ts)))
    for t, i in zip(ts, range(len(run))):
        if abs(t - (float(text_len) + mm.FRAME_RESCALE * i)) > 1e-9:
            raise RuntimeError("anchor %d at %.6f, expected %.6f"
                               % (i, t, text_len + mm.FRAME_RESCALE * i))

    # 2. adding a reference must not move the anchors relative to the
    # target: the anchor-to-end gap must be identical with and without it.
    # The move below places audio from the target origin, so that origin
    # has to be where the target rows actually start.
    ref = [{"kind": "audio", "ref_audio_t": 8}]
    d = build(keyframes=run, refs=ref)
    ts_ref = cond_ts(d)
    if len(ts_ref) != len(ts):
        raise RuntimeError("cond segment count changed when a ref was added")
    tol = 1e-3
    gap = float(c.position_ids[:, 0].max()) - ts[0]
    gap_ref = float(d.position_ids[:, 0].max()) - ts_ref[0]
    if abs(gap - gap_ref) > tol:
        raise RuntimeError(
            "ref compensation off by %.6f: anchor-to-target gap %.6f without "
            "ref, %.6f with. Upstream layout change." % (gap_ref - gap, gap, gap_ref))

    # 3. the audio move: exactly the marked block's rows shift, all by one
    # uniform amount, every other row bit-identical
    end_frame, rt = 4, 8
    ref_mc = [{"kind": "audio", "ref_audio_t": rt, MC_AUDIO_KEY: end_frame}]
    e = build(keyframes=run, refs=ref_mc, move=True)
    _check_move(d, e, ref_mc, 0, "single-ref")

    # 4. the same move inside a Ref2VA layout: image, video and audio
    # references of the graph's own must come through untouched. The
    # marked block sits in the MIDDLE of the list, not at the end, because
    # nothing about locating it by segment depends on its position.
    r_lh, r_lw, r_vt = 8, 12, 3
    others = [
        {"kind": "image", "latent_h": r_lh, "latent_w": r_lw},
        {"kind": "video_audio", "latent_h": r_lh, "latent_w": r_lw,
         "latent_t": r_vt, "ref_audio_t": 5},
        {"kind": "audio", "ref_audio_t": 3},
    ]
    marked = {"kind": "audio", "ref_audio_t": rt, MC_AUDIO_KEY: end_frame}
    plain = {"kind": "audio", "ref_audio_t": rt}
    multi_plain = others[:2] + [plain] + others[2:]
    multi_marked = others[:2] + [marked] + others[2:]
    f = build(keyframes=run, refs=multi_plain)
    g = build(keyframes=run, refs=multi_marked, move=True)
    _check_move(f, g, multi_marked, 2, "multi-ref")

    # 5. the segment map must agree with how the layout is actually laid
    # out. Not by recomputing the cursor, which is the duplication this
    # rewrite exists to remove, but by checking the structural properties
    # the move depends on: reference blocks appear in list order, their
    # rows sit before the target, and no block's rows overlap another's.
    smap = _ref_segment_map(f, multi_plain)
    prev_hi = float(text_len) - 1e-9
    origin = _target_origin(f)
    for i in range(len(multi_plain)):
        spans = smap.get(i)
        if not spans:
            continue
        rows = [r for a0, b0 in spans.values() for r in range(a0, b0)]
        lo = min(float(f.position_ids[r, 0]) for r in rows)
        hi = max(float(f.position_ids[r, 0]) for r in rows)
        if lo < prev_hi - 1e-9:
            raise RuntimeError(
                "reference block %d starts at %.6f, before block %d ended "
                "at %.6f. Reference blocks are not laid out in list order."
                % (i, lo, i - 1, prev_hi))
        if hi >= origin - 1e-9:
            raise RuntimeError(
                "reference block %d reaches %.6f, at or past the target "
                "origin %.6f. Reference rows should sit before the target."
                % (i, hi, origin))
        prev_hi = hi


def _check_move(before, after, refs, idx, label):
    """Only the marked block's rows moved, uniformly, on the time axis."""
    if after.position_ids.shape != before.position_ids.shape:
        raise RuntimeError("%s: audio move changed the layout shape" % label)
    if not torch.equal(before.position_ids[:, 1:], after.position_ids[:, 1:]):
        raise RuntimeError(
            "%s: audio move touched a non-time coordinate column" % label)
    a, b = _ref_segment_map(before, refs)[idx]["ref_audio"]
    expect_moved = set(range(a, b))
    tb, ta = before.position_ids[:, 0], after.position_ids[:, 0]
    moved = set(i for i in range(len(tb)) if float(tb[i]) != float(ta[i]))
    if not moved:
        raise RuntimeError("%s: audio move moved no rows" % label)
    if moved != expect_moved:
        raise RuntimeError(
            "%s: audio move touched the wrong rows: %d moved, %d expected, "
            "e.g. %s" % (label, len(moved), len(expect_moved),
                         sorted(moved ^ expect_moved)[:8]))
    deltas = [float(ta[i]) - float(tb[i]) for i in sorted(moved)]
    if any(abs(dd - deltas[0]) > 1e-9 for dd in deltas):
        raise RuntimeError("%s: audio rows shifted non-uniformly: %s"
                           % (label, deltas[:4]))
    # The size of the shift is deliberately NOT asserted. It depends on
    # how far the reference cursor advanced, which is stock's business,
    # and pinning it here would put a copy of that arithmetic back in.
    # What must hold is where the window ENDS: on the target timeline,
    # FRAME_RESCALE * end_frame past the target origin.
    blk = refs[idx]
    rt = int(blk["ref_audio_t"])
    want_end = (_target_origin(after)
                + mm.FRAME_RESCALE * float(blk[MC_AUDIO_KEY]))
    got_end = float(after.position_ids[a, 0]) + float(rt)
    if abs(got_end - want_end) > 1e-9:
        raise RuntimeError(
            "%s: audio window ends at %.6f, should end at %.6f"
            % (label, got_end, want_end))


setattr(_patched_init, PATCH_MARKER, True)


def _already_patched():
    """Has another copy of this file already wrapped the constructor?

    Returns None, "same" or "other".

    Two copies of this patch in one ComfyUI is normal enough: several
    packs vendor it, and forks of this repo carry their own. Whichever
    loads second would otherwise capture the first's wrapper as its
    original and wrap a wrapper. That is worse than it sounds, because
    each copy self-tests through whatever is already installed, so a copy
    with newer tests gets checked against older behaviour and refuses
    over a limitation that no longer exists.

    Three checks, in decreasing confidence.

    The marker is set by copies new enough to set it. That is a matching
    version and we stand down quietly.

    A wrapper merely NAMED like ours is an older copy of this code, or a
    fork. We stand down and say so, because whichever one loaded first is
    the one deciding what the patch supports.

    Anything else sitting where the stock constructor should be is a
    DIFFERENT pack patching the same thing. Several H3 packs lift the
    same layout independently, and they cannot both own
    the constructor. Detected by comparing where the function was defined
    against where the class was: stock's __init__ comes from the same
    module as PackedLayout itself, a wrapper comes from somewhere else.
    functools.wraps copies __module__ across, so __wrapped__ is checked
    too. A wrapper that hides both is indistinguishable from stock and
    nothing can be done about that.
    """
    cls = getattr(mm, "PackedLayout", None)
    init = getattr(cls, "__init__", None)
    if init is None:
        return None
    if getattr(init, PATCH_MARKER, False):
        return "same"
    if getattr(init, "__name__", "") == "_patched_init":
        return "other"
    if hasattr(init, "__wrapped__"):
        return "foreign"
    home = getattr(cls, "__module__", None)
    where = getattr(init, "__module__", None)
    if home and where and where != home:
        return "foreign"
    return None


def apply_patch():
    global _orig_init, _applied
    if _applied:
        return True
    who = _already_patched()
    if who == "foreign":
        _LOG.warning(
            "h3_motion_context: another pack has already patched H3's "
            "layout (PackedLayout.__init__ now comes from %r). Several "
            "ComfyUI packs patch the same layout independently and they "
            "cannot both own it, so this one is "
            "refusing rather than wrapping a wrapper and producing joins "
            "neither pack intended. Disable one of them and restart.",
            getattr(getattr(getattr(mm, "PackedLayout", None), "__init__",
                            None), "__module__", "?"))
        return False
    if who:
        # report success: the patch IS active, just not ours, and the
        # calling pack's nodes check is_applied() before they will run
        _applied = True
        if who == "same":
            _LOG.info("h3_motion_context: layout patch already "
                      "installed by another pack, standing down")
        else:
            _LOG.warning(
                "h3_motion_context: the H3 layout patch is already installed "
                "by a DIFFERENT copy of this code (another version, or a "
                "fork). Standing down; that copy decides what the patch "
                "supports, so features added since it may be unavailable. "
                "If you have more than one H3 Motion Context folder in "
                "custom_nodes, keep one and remove the rest. Renaming a "
                "folder does not stop ComfyUI loading it.")
        return True
    if not hasattr(mm, "PackedLayout") or not hasattr(mm, "FRAME_RESCALE"):
        _LOG.warning("h3_motion_context: MiniMax H3 model module missing expected "
                     "attributes, patch not applied")
        return False
    _orig_init = mm.PackedLayout.__init__
    try:
        _self_test()
    except Exception as exc:
        _orig_init = None
        _LOG.warning("h3_motion_context: self-test failed (%s), patch not "
                     "applied. Pinned audio cannot be placed on the timeline.", exc)
        _LOG.warning(
            "h3_motion_context: if you have more than one H3 Motion Context "
            "folder in custom_nodes (a fork, a backup, a manual clone "
            "alongside a Manager install), that is the usual cause: each "
            "copy self-tests against whichever one loaded first. Keep one "
            "and remove the rest. Renaming a folder does not stop ComfyUI "
            "loading it. Otherwise this is an upstream ComfyUI change and "
            "the message above says what moved.")
        return False
    mm.PackedLayout.__init__ = _patched_init
    _applied = True
    _LOG.info("h3_motion_context: audio timeline placement enabled")
    return True


def is_applied():
    return _applied
