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
        if label == 1 and score >= min_score and (x2 - x1) * (y2 - y1) / (w * h) >= min_area and (y2 - y1) >= min_aspect * (x2 - x1):
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


def track(frames, boxes, say=None):
    """Follow each box through the clip → uint8 label map [T, H, W] (0 = nobody, i + 1 = boxes[i])."""
    import torch
    say = say or (lambda f, m: None)
    n, h, w = frames.shape[:3]
    pred = tracker(say)
    tmp = tempfile.mkdtemp(prefix="dm-people-")
    try:
        for i, f in enumerate(frames):  # SAM 2 reads a folder of numbered JPEGs
            cv2.imwrite(os.path.join(tmp, f"{i:05d}.jpg"), cv2.cvtColor(f, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        labels = np.zeros((n, h, w), np.uint8)
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            state = pred.init_state(tmp, offload_video_to_cpu=True)
            for i, b in enumerate(boxes):
                pred.add_new_points_or_box(state, frame_idx=0, obj_id=i + 1, box=np.array([b[0] * w, b[1] * h, b[2] * w, b[3] * h], np.float32))
            for t, ids, logits in pred.propagate_in_video(state):
                lg = logits[:, 0].float()
                if lg.shape[-2:] != (h, w):
                    lg = torch.nn.functional.interpolate(lg[:, None], (h, w), mode="bilinear", align_corners=False)[:, 0]
                best, who = lg.max(0)  # where two people overlap, the more certain one wins
                lab = torch.where(best > 0, torch.as_tensor(ids, device=lg.device)[who], 0)
                labels[t] = lab.to(torch.uint8).cpu().numpy()
                if t % 6 == 0:
                    say(t / n, f"Following {len(boxes)} {'person' if len(boxes) == 1 else 'people'} · frame {t} of {n}")
            pred.reset_state(state)
        return labels
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        torch.cuda.empty_cache()
