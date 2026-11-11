# Virtual Fitting Mirror

An in-store "magic mirror": the customer stands in front of a camera and picks a
dress, and the dress follows their body live. The skirt swings and settles like
fabric, switches to the back view when they turn around, and narrows when they
turn sideways. **Everything runs locally**: the camera image never leaves the
computer, and it works offline after setup.

## Run

```sh
./setup.sh      # first time only (add --rembg for AI background removal)
./start.sh      # opens http://localhost:8790
```

| Page | What it is |
|---|---|
| `/` | The mirror (put it full-screen on a TV / portrait monitor, press **F**) |
| `/admin` | Add dresses, adjust fit calibration, size charts, store name/currency |
| `/?demo` | Mannequin demo, no camera needed: sways, turns around, steps |

## Using the mirror

- **Raise right hand** above your head → next dress · **left hand** → previous
- **Raise both hands** → capture look (front, side, back photos with countdown)
- Keyboard: ← → change dress · Space capture · B front/back/auto · D skeleton · F full screen
- Settings (gear): customer height (for the size tip), camera choice, new customer

## Adding your dresses

1. Photograph the dress **straight on, full length**, flat or on a hanger, against a
   **plain wall**. Take a back photo too if you can (used when the customer turns around).
2. `/admin` → Add a dress. The background is removed automatically.
3. Check the **Fit calibration**: drag the gold dots to where the wearer's shoulder joints
   would be, and the blue line to hip level. Save.

## How it works

- **Body tracking**: MediaPipe Pose (in the browser, on the GPU) gives 33 body points per frame
  plus a person mask.
- **Fit**: the dress photo becomes a 12×30 mesh. The bodice is pinned between the shoulders
  and hips; below the hips a Verlet cloth simulation pulls it toward the body with
  softer springs toward the hem, so the skirt lags, swings and settles (`static/js/cloth.js`).
- **Turning**: shoulder left/right order, nose depth and face visibility decide front/back;
  shoulder width decides side view. The front and back photos cross-fade.
- **Arms**: forearms and hands are redrawn over the dress using the person mask.
- **Size tip**: with the customer's height, shoulder and hip widths are converted to an
  approximate bust/hip and matched to each dress's size chart. It's a rough guide.

## Limits (honest)

- This is a 2D garment warped onto the body, not a 3D garment. It looks best with
  sleeveless or short-sleeve dresses; long sleeves don't follow the arms.
- The side view is a narrowed front view (there's no side photo).
- Customers' own clothes can show at the edges (e.g. jeans below a short dress).

## Next step: photo-realistic AI rendering (optional)

`server.py` has an `/api/tryon` hook and `tryon_engine.py` loads a model from `./ai/`.
A diffusion try-on model (e.g. CatVTON, IDM-VTON, Leffa) can plug in there to turn
captured looks into realistic photos (~20–60 s per image on Apple Silicon).
**Check the model license first**: several are non-commercial only.
