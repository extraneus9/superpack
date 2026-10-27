"""Our own camera tracker: how the real camera moved, frame by frame. No outside model.

1  thousands of corner points on the BACKGROUND (people masked out, so the fight doesn't fool it)
2  followed through the clip with optical flow (forward + backward check, so drifting points are dropped)
3  lifted to 3D with the clip's depth (made metric by the same rule the set uses)
4  each frame's camera = the pose that projects those 3D points onto where they were seen (PnP + RANSAC)
5  re-seeded with fresh points when too many are lost (push-ins and pans run out of points)
Result: per frame, camera → world (= the first frame's camera space, OpenCV axes, metres): rotation R and centre c.
"""
import cv2
import numpy as np


def metric_depth(disp, a, b, near=0.3, far=80.0):
    """The clip's relative depth → metres, with 1/z = a·disp + b (a, b fitted on the people)."""
    return 1.0 / np.clip(a * np.asarray(disp, np.float32) + b, 1 / far, 1 / near)  # full precision per frame


def _smooth(x, sigma):
    if sigma <= 0 or len(x) < 3:
        return x
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    pad = np.concatenate([np.repeat(x[:1], r, 0), x, np.repeat(x[-1:], r, 0)])
    return np.tensordot(k, np.stack([pad[i:i + len(x)] for i in range(2 * r + 1)]), axes=(0, 0))


def solve(frames, people_masks, disp, a, b, focal, say=None, min_points=400, max_dist=20.0, max_step=0.35, max_turn=6.0):
    """frames [T, H, W, 3] RGB · people_masks [T, H, W] bool · disp [T, h', w'] clip-normalised depth (near = 1).
    → R [T, 3, 3] and c [T, 3] (camera → world), and the share of points that agreed on each frame."""
    say = say or (lambda f, m: None)
    t_, h, w = frames.shape[:3]
    K = np.array([[focal, 0, w / 2], [0, focal, h / 2], [0, 0, 1]], np.float64)
    grey = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in frames]
    bg = [(cv2.dilate(m.astype(np.uint8), np.ones((31, 31), np.uint8)) == 0).astype(np.uint8) * 255 for m in people_masks]
    R = np.zeros((t_, 3, 3)); C = np.zeros((t_, 3)); agree = np.zeros(t_)
    R[0], C[0], agree[0] = np.eye(3), 0, 1

    def seed(t):
        """Fresh background points on frame t, lifted to world 3D with that frame's depth and camera."""
        pts = cv2.goodFeaturesToTrack(grey[t], 2500, 0.01, 8, mask=bg[t], blockSize=7)
        if pts is None:
            return np.zeros((0, 2), np.float32), np.zeros((0, 3))
        pts = pts.reshape(-1, 2)
        dh, dw = disp[t].shape
        d = disp[t][np.clip((pts[:, 1] * dh / h).astype(int), 0, dh - 1), np.clip((pts[:, 0] * dw / w).astype(int), 0, dw - 1)]
        z = metric_depth(d, a, b)
        keep = (z < max_dist) & (z > 0.4)  # near things pin the camera's position; far crowd and sky don't
        cam = np.stack([(pts[:, 0] - w / 2) * z / focal, (pts[:, 1] - h / 2) * z / focal, z], 1)
        world = cam @ R[t].T + C[t]
        return pts[keep].astype(np.float32), world[keep]

    p2, p3 = seed(0)
    rvec = np.zeros(3); tvec = np.zeros(3)
    for t in range(1, t_):
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(grey[t - 1], grey[t], p2, None, winSize=(21, 21), maxLevel=4)
        back, st2, _ = cv2.calcOpticalFlowPyrLK(grey[t], grey[t - 1], nxt, None, winSize=(21, 21), maxLevel=4)
        ok = (st.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm(back - p2, axis=1) < 1.0)
        inside = (nxt[:, 0] > 0) & (nxt[:, 0] < w) & (nxt[:, 1] > 0) & (nxt[:, 1] < h)
        mi = np.clip(nxt[:, 1].astype(int), 0, h - 1), np.clip(nxt[:, 0].astype(int), 0, w - 1)
        ok &= inside & (bg[t][mi] > 0)  # a point a fighter walked in front of is gone
        p2, p3 = nxt[ok], p3[ok]
        good, rv, tv, inl = False, rvec, tvec, None
        if len(p2) >= 12:
            good, rv, tv, inl = cv2.solvePnPRansac(p3, p2, K, None, rvec.copy(), tvec.copy(), useExtrinsicGuess=True,
                                                   reprojectionError=2.5, iterationsCount=200, flags=cv2.SOLVEPNP_ITERATIVE)
        if good and inl is not None and len(inl) >= 8:
            # a real camera can't teleport: reject a pose that jumps too far or turns too much in one frame
            Rn, _ = cv2.Rodrigues(rv.ravel()); Rp, _ = cv2.Rodrigues(rvec)
            cn, cp = -Rn.T @ tv.ravel(), -Rp.T @ tvec
            turn = np.degrees(np.arccos(np.clip((np.trace(Rn @ Rp.T) - 1) / 2, -1, 1)))
            if np.linalg.norm(cn - cp) <= max_step and turn <= max_turn:
                rvec, tvec = rv.ravel(), tv.ravel()
                agree[t] = len(inl) / len(p2)
                sel = inl.ravel()
                p2, p3 = p2[sel], p3[sel]
        Rw, _ = cv2.Rodrigues(rvec)               # world → camera
        R[t] = Rw.T; C[t] = -Rw.T @ tvec          # camera → world
        if len(p2) < min_points:                  # running out: add fresh ones from this frame
            n2, n3 = seed(t)
            p2, p3 = np.concatenate([p2, n2]), np.concatenate([p3, n3])
        if t % 5 == 0:
            say(t / t_, f"Tracking the camera · frame {t} of {t_}")

    # a real camera moves smoothly: smooth its path (and its turning, via the rotation vectors)
    rv = np.array([cv2.Rodrigues(r)[0].ravel() for r in R])
    rv = _smooth(rv, 1.5); C = _smooth(C, 1.5)
    R = np.array([cv2.Rodrigues(v)[0] for v in rv])
    return R, C, agree
