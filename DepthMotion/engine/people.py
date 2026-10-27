"""People: find them, follow them, give each one a colour — so a video model can tell who is who.

Find:   torchvision Faster R-CNN (COCO "person") on one frame — the biggest people, not the crowd.
Follow: SAM 2.1 (Meta, Apache-2.0) video predictor, seeded with those boxes; it tracks through crossings and occlusion.
Result: a label map per frame (0 = nobody, 1..N = person N) that the passes paint with each person's colour.
"""
import os
import shutil
import tempfile
import urllib.request

import cv2
import numpy as np

import depthmotion as dm

COLORS = ["#e3262d", "#22c55e", "#3b82f6", "#facc15", "#d946ef", "#06b6d4"]  # red, green, blue, yellow, magenta, cyan
SAM_URL = "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt"
SAM_SIZE = 323606802
os.environ.setdefault("TORCH_HOME", os.path.join(dm.HOME, "torch"))  # detector weights land in the app's own folder
_detector = None
_tracker = None


def rgb(hex_color):
    h = hex_color.lstrip("#")
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32) / 255


def detector():
    global _detector
    if _detector is None:
        import torchvision
        w = torchvision.models.detection.FasterRCNN_ResNet50_FPN_V2_Weights.COCO_V1
        _detector = torchvision.models.detection.fasterrcnn_resnet50_fpn_v2(weights=w).to("cuda").eval()
    return _detector


def find(frame, max_people=6, min_score=0.75, min_area=0.012, min_aspect=0.0):
    """Boxes of the main people in one RGB frame, left to right, as fractions of the frame: [[x1, y1, x2, y2], ...]."""
    import torch
    h, w = frame.shape[:2]
    with torch.no_grad():
        t = torch.from_numpy(frame).permute(2, 0, 1).float().div(255).to("cuda")
        out = detector()([t])[0]
    keep = []
    for box, label, score in zip(out["boxes"].cpu().numpy(), out["labels"].cpu().numpy(), out["scores"].cpu().numpy()):
        x1, y1, x2, y2 = box
        area = (x2 - x1) * (y2 - y1) / (w * h)
        # someone close to the lens and cut by the frame is wider than tall — still a person, not a rope
        cropped = (x1 <= 2 or y1 <= 2 or x2 >= w - 2 or y2 >= h - 2) and area >= 0.08
        if label == 1 and score >= min_score and area >= min_area and ((y2 - y1) >= min_aspect * (x2 - x1) or cropped):
            keep.append((float((x2 - x1) * (y2 - y1)), [float(x1 / w), float(y1 / h), float(x2 / w), float(y2 / h)]))
    keep = [b for _, b in sorted(keep, reverse=True)[:max_people]]  # the biggest = the people the shot is about
    return sorted(keep, key=lambda b: b[0] + b[2])  # left to right, so "left fighter = first colour" holds


def fetch_tracker(say=None):
    p = os.path.join(dm.MODELS, "sam2.1_hiera_base_plus.pt")
    if os.path.exists(p) and os.path.getsize(p) == SAM_SIZE:
        return p
    os.makedirs(dm.MODELS, exist_ok=True)
    with urllib.request.urlopen(SAM_URL) as r, open(p + ".part", "wb") as f:
        got = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            got += len(chunk)
            if say:
                say(got / SAM_SIZE, f"Downloading the people tracker · {got / 1e6:.0f} of {SAM_SIZE / 1e6:.0f} MB")
    os.replace(p + ".part", p)
    return p


def tracker(say=None):
    global _tracker
    if _tracker is None:
        from sam2.build_sam import build_sam2_video_predictor
        _tracker = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_b+.yaml", fetch_tracker(say), device="cuda")
    return _tracker


def _box_of(lab, k):
    ys, xs = np.nonzero(lab == k)
    return (xs.min(), ys.min(), xs.max(), ys.max()) if len(xs) > 30 else None


def _iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / max(1, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def _newcomers(frames, labels, c0, c1, ids, step=6, cover=0.2, find_kw=None):
    """The first frame in [c0, c1) where someone shows up that nobody is following → (local frame, [new boxes],
    [(id, box) to pick back up]). Someone whose track slipped is not a newcomer: if a person appears where one we were
    following was last seen (and that one is missing now), it's them again — same id, same colour."""
    h, w = labels.shape[1:3]
    for t in range(c0, c1, step):
        missing = [k for k in ids if (labels[t] == k).sum() < 80]
        # where the people being followed are right now (someone still followed elsewhere can't be this newcomer)
        recent = [b for k in ids if k not in missing and (b := _box_of(labels[t], k))]
        last = {}
        for k in missing:  # where each missing person was last properly seen (up to ~4 s back)
            for s in range(t - 1, max(-1, t - 96), -2):
                if (labels[s] == k).sum() >= 400 and (b := _box_of(labels[s], k)):
                    last[k] = b; break
        new, back = [], []
        for f in find(frames[t], **(find_kw or {})):
            px = (int(f[0] * w), int(f[1] * h), int(f[2] * w), int(f[3] * h))
            region = labels[t][px[1]:px[3], px[0]:px[2]]
            if not (region.size and (region > 0).mean() < cover and all(_iou(px, b) < 0.3 for b in recent)):
                continue
            near = [(_iou(px, b) + (abs((px[0] + px[2]) - (b[0] + b[2])) < (b[2] - b[0])), k) for k, b in last.items()
                    if k not in [x for x, _ in back]]
            score, k = max(near) if near else (0, None)
            if len(near) == 1:  # only one person is missing: someone stepping back into frame is them
                score = 1.0
            if k is not None and score > 0.1:
                back.append((k, f))
            else:
                new.append(f)
        if new or back:
            return t - c0, new, back
    return None, [], []


def track(frames, boxes, say=None, chunk=None, newcomers=None, find_kw=None):
    """Follow each box through the clip → uint8 label map [T, H, W] (0 = nobody, i + 1 = boxes[i]).
    Works in chunks of `chunk` frames: SAM 2 holds every frame it's given as a large float image (~12 MB each), so a
    whole clip at once can eat many GB. Each chunk starts from the previous chunk's last masks, so identities and
    tracking carry straight through, and memory stays around half a gigabyte for any clip length.
    newcomers: a list → people who walk in after the first frame are picked up too, given the next ids, and listed
    there as {"box", "frame"} (fight scenes: people come and go)."""
    import torch
    import guard
    say = say or (lambda f, m: None)
    n, h, w = frames.shape[:3]
    pred = tracker(say)
    labels = np.zeros((n, h, w), np.uint8)
    # VRAM first: with room on the card the tracker keeps its frames THERE (not in RAM) and takes bigger chunks
    on_gpu = guard.gpu_room() > 6
    chunk = chunk or (120 if on_gpu else 40)
    ids = list(range(1, len(boxes) + 1))
    c0 = 0
    while c0 < n:
        c1 = min(n, c0 + chunk)
        tmp = tempfile.mkdtemp(prefix="dm-people-")
        try:
            for i, f in enumerate(frames[c0:c1]):  # SAM 2 reads a folder of numbered JPEGs
                cv2.imwrite(os.path.join(tmp, f"{i:05d}.jpg"), cv2.cvtColor(f, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
            with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                state = pred.init_state(tmp, offload_video_to_cpu=not on_gpu)
                prompts = []  # (local frame, id, box or mask)
                for k in ids:
                    if c0 == 0 and k <= len(boxes):
                        b = boxes[k - 1]
                        prompts.append((0, k, np.array([b[0] * w, b[1] * h, b[2] * w, b[3] * h], np.float32)))
                    elif c0 > 0 and (labels[c0] == k).sum() > 30:  # carried on from the last frame of the previous chunk
                        prompts.append((0, k, labels[c0] == k))
                def label_map(oids, logits):
                    lg = logits[:, 0].float()
                    if lg.shape[-2:] != (h, w):
                        lg = torch.nn.functional.interpolate(lg[:, None], (h, w), mode="bilinear", align_corners=False)[:, 0]
                    best, who = lg.max(0)  # where two people overlap, the more certain one wins
                    return torch.where(best > 0, torch.as_tensor(oids, device=lg.device)[who], 0).to(torch.uint8).cpu().numpy()
                late = {}  # people first prompted after the chunk's first frame: id → that frame
                for _ in range(4):  # follow everyone; then look for anyone new, and follow again with them added
                    for fi, k, p in prompts:
                        if p.dtype == bool:
                            pred.add_new_mask(state, frame_idx=fi, obj_id=k, mask=p)
                        else:
                            pred.add_new_points_or_box(state, frame_idx=fi, obj_id=k, box=p)
                    if prompts:
                        for t, oids, logits in pred.propagate_in_video(state):
                            labels[c0 + t] = label_map(oids, logits)
                    if newcomers is None or len(ids) >= len(COLORS):
                        break
                    fi, new, back = _newcomers(frames, labels, c0, c1, ids, find_kw=find_kw)
                    if not new and not back:
                        break
                    pred.reset_state(state)  # SAM 2 takes new people only before it starts following
                    for k, b in back:  # a person whose track slipped: picked back up under their own id
                        prompts.append((fi, k, np.array([b[0] * w, b[1] * h, b[2] * w, b[3] * h], np.float32)))
                    for b in new[:len(COLORS) - len(ids)]:
                        ids.append(len(ids) + 1)
                        prompts.append((fi, ids[-1], np.array([b[0] * w, b[1] * h, b[2] * w, b[3] * h], np.float32)))
                        newcomers.append({"box": b, "frame": c0 + fi})
                        if fi > 0:
                            late[ids[-1]] = fi
                if late:  # someone found only once they stood apart: follow them BACK to where they first appear too
                    pred.reset_state(state)  # fresh, with only them: the forward pass's empty frames must not be reused
                    for fi, k, p in prompts:
                        if k in late and p.dtype != bool:
                            pred.add_new_points_or_box(state, frame_idx=fi, obj_id=k, box=p)
                    f0 = max(late.values())
                    for t, oids, logits in pred.propagate_in_video(state, start_frame_idx=f0, reverse=True):
                        lab = label_map(oids, logits)
                        for k, fk in late.items():
                            if t < fk:
                                sel = (lab == k) & (labels[c0 + t] == 0)
                                labels[c0 + t][sel] = k
                pred.reset_state(state)
                del state
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            torch.cuda.empty_cache()
        guard.check("following the people", lambda msg: say(c1 / n, msg))
        say(c1 / n, f"Following {len(ids)} {'person' if len(ids) == 1 else 'people'} · frame {c1} of {n}")
        if c1 >= n:
            break
        c0 = c1 - 1  # one frame of overlap: the next chunk starts on this chunk's last masks
    return labels
