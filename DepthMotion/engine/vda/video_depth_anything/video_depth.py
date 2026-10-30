# Copyright (2025) Bytedance Ltd. and/or its affiliates

# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at

#     http://www.apache.org/licenses/LICENSE-2.0

# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
import torch
import torch.nn.functional as F
import torch.nn as nn
from torchvision.transforms import Compose
import cv2
from tqdm import tqdm
import numpy as np
import gc

from .dinov2 import DINOv2
from .dpt_temporal import DPTHeadTemporal
from .util.transform import Resize, NormalizeImage, PrepareForNet

from utils.util import compute_scale_and_shift, get_interpolate_frames

# infer settings, do not change
INFER_LEN = 32
OVERLAP = 10
KEYFRAMES = [0,12,24,25,26,27,28,29,30,31]
INTERP_LEN = 8

class VideoDepthAnything(nn.Module):
    def __init__(
        self,
        encoder='vitl',
        features=256,
        out_channels=[256, 512, 1024, 1024],
        use_bn=False,
        use_clstoken=False,
        num_frames=32,
        pe='ape',
        metric=False,
    ):
        super(VideoDepthAnything, self).__init__()

        self.intermediate_layer_idx = {
            'vits': [2, 5, 8, 11],
            "vitb": [2, 5, 8, 11],
            'vitl': [4, 11, 17, 23]
        }

        self.encoder = encoder
        self.pretrained = DINOv2(model_name=encoder)

        self.head = DPTHeadTemporal(self.pretrained.embed_dim, features, use_bn, out_channels=out_channels, use_clstoken=use_clstoken, num_frames=num_frames, pe=pe)
        self.metric = metric

    def forward(self, x):
        B, T, C, H, W = x.shape
        patch_h, patch_w = H // 14, W // 14
        features = self.pretrained.get_intermediate_layers(x.flatten(0,1), self.intermediate_layer_idx[self.encoder], return_class_token=True)
        depth = self.head(features, patch_h, patch_w, T)[0]
        depth = F.interpolate(depth, size=(H, W), mode="bilinear", align_corners=True)
        depth = F.relu(depth)
        return depth.squeeze(1).unflatten(0, (B, T)) # return shape [B, T, H, W]

    def infer_video_depth(self, frames, target_fps, input_size=518, device='cuda', fp32=False, keep_size=True, as_tensor=False):
        # DepthMotion: everything stays on the graphics card. Frames go up 8-bit (straight from VRAM when the caller
        # already holds them there: `frames.t`), are resized + normalised on the card, and every frame's depth is kept
        # and aligned (the same scale/shift maths as utils.util) on the card too — RAM only ever sees the final result,
        # or nothing at all with as_tensor=True. keep_size=False keeps depth at the model's own size.
        n = frames.shape[0]
        frame_height, frame_width = frames.shape[1:3]
        ratio = max(frame_height, frame_width) / min(frame_height, frame_width)
        if ratio > 1.78:  # we recommend to process video with ratio smaller than 16:9 due to memory limitation
            input_size = int(input_size * 1.777 / ratio)
            input_size = round(input_size / 14) * 14
        net_h, net_w = Resize(width=input_size, height=input_size, resize_target=False, keep_aspect_ratio=True,
                              ensure_multiple_of=14, resize_method='lower_bound',
                              image_interpolation_method=cv2.INTER_CUBIC).get_size(frame_width, frame_height)[::-1]
        mean = torch.tensor([0.485, 0.456, 0.406], device=device).view(1, 3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225], device=device).view(1, 3, 1, 1)
        on_card = getattr(frames, 't', None)

        frame_step = INFER_LEN - OVERLAP
        append_frame_len = (frame_step - (n % frame_step)) % frame_step + (INFER_LEN - frame_step)
        idx = list(range(n)) + [n - 1] * append_frame_len

        depth_list = []
        pre_input = None
        for frame_id in tqdm(range(0, n, frame_step)):
            ids = idx[frame_id:frame_id + INFER_LEN]
            if on_card is not None:
                x = on_card[torch.as_tensor(ids, device=on_card.device)]
            else:
                x = torch.from_numpy(np.ascontiguousarray(np.stack([frames[i] for i in ids]))).to(device)
            x = x.permute(0, 3, 1, 2).float().div_(255)
            x = F.interpolate(x, size=(net_h, net_w), mode='bicubic', align_corners=False).clamp_(0, 1)
            cur_input = ((x - mean) / std).unsqueeze(0)
            del x
            if pre_input is not None:
                cur_input[:, :OVERLAP, ...] = pre_input[:, KEYFRAMES, ...]

            with torch.no_grad():
                with torch.autocast(device_type=device, enabled=(not fp32)):
                    depth = self.forward(cur_input) # depth shape: [1, T, H, W]

            depth = depth.float().flatten(0, 1)
            if keep_size:
                depth = F.interpolate(depth.unsqueeze(1), size=(frame_height, frame_width), mode='bilinear', align_corners=True)[:, 0]
            depth_list += list(depth.half())
            pre_input = cur_input

        # align each window to the one before (scale + shift on the overlapping keyframes), blend the overlap
        def fit(pred, target):  # least squares pred·s + t ≈ target (utils.util.compute_scale_and_shift_full, all-ones mask)
            p, q = pred.double(), target.double()
            a00, a01, a11 = (p * p).sum(), p.sum(), float(p.numel())
            b0, b1 = (p * q).sum(), q.sum()
            det = a00 * a11 - a01 * a01
            if det == 0:
                return 1.0, 0.0
            return float((a11 * b0 - a01 * b1) / det), float((-a01 * b0 + a00 * b1) / det)

        lift = lambda d, sc, sh: torch.clamp(d.float() * sc + sh, min=0).half()
        aligned, ref = [], []
        align_len = OVERLAP - INTERP_LEN
        kf_align_list = KEYFRAMES[:align_len]
        for frame_id in range(0, len(depth_list), INFER_LEN):
            if not aligned:
                aligned += depth_list[:INFER_LEN]
                ref = [depth_list[frame_id + k] for k in kf_align_list]
                continue
            curr = [depth_list[frame_id + i] for i in range(len(kf_align_list))]
            scale, shift = (1.0, 0.0) if self.metric else fit(torch.cat([c.flatten() for c in curr]), torch.cat([r.flatten() for r in ref]))
            pre = aligned[-INTERP_LEN:]
            post = [lift(d, scale, shift) for d in depth_list[frame_id + align_len:frame_id + OVERLAP]]
            w = [i / (INTERP_LEN - 1) for i in range(INTERP_LEN)]  # utils.util.get_interpolate_frames weights
            aligned[-INTERP_LEN:] = [(pre[i].float() * (1 - w[i]) + post[i].float() * w[i]).half() for i in range(INTERP_LEN)]
            aligned += [lift(depth_list[frame_id + i], scale, shift) for i in range(OVERLAP, INFER_LEN)]
            ref = ref[:1] + [lift(depth_list[frame_id + k], scale, shift) for k in kf_align_list[1:]]

        out = torch.stack(aligned[:n])
        del depth_list, aligned, ref, pre_input
        if as_tensor:
            return out, target_fps
        res = out.cpu().numpy()
        del out
        torch.cuda.empty_cache()
        return res, target_fps
