# Scanner Lab 0.4

This build stays isolated on `scanner-sdk-lab-v040` and does not modify Road Ready production or the Scanner Lab 0.3 branch.

## Import and curved-page workflow

- Photo import uses `createImageBitmap` first, then falls back to `HTMLImageElement` for iOS/HEIC compatibility.
- Imported photos are capped at 2200 px on the long side before detection to reduce memory and wait time.
- The review editor exposes 16 unique boundary handles: four corners plus three intermediate controls on every edge.
- Shared corner handles keep adjacent edge curves connected.
- The page is flattened with four piecewise boundary curves and a Coons-style mesh, so bowed and bent page edges can be corrected beyond a rigid four-corner crop.
- The boundary is refined against image gradients before review.

## Quality bot

- `Auto fix` is the default filter.
- The local quality bot estimates illumination, shadows, contrast, paper white balance, glare, color content, and red handwriting/stamps.
- Auto mode preserves useful color when handwriting or stamps are detected; neutral paperwork uses clean-document mode.
- Processing includes local illumination normalization, white balance, contrast stretch, edge sharpening, and adaptive monochrome output.
- The final review action is labeled `Auto-fix & save`.

## Interface and safety

- Boundary lines and handles are thinner than Scanner Lab 0.3.
- Photo-library import no longer carries the camera-only `capture` attribute.
- The engine remains local-only with no OpenCV/CDN runtime and no service-worker cache.

## Verification

The Vercel build runs 16 scanner tests, including the 16-point model, shared corners, bowed-edge mapping, rotated-page detection, shadow handling, background rejection, jitter smoothing, and automatic quality-mode selection.
