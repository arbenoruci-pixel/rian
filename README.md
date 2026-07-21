# Road Ready Scanner Lab

A standalone document-scanner research build. This branch has no imports, shared storage keys, service workers, build scripts, APIs, or runtime dependencies from the Road Ready production application.

## Demo 0.1

- Rear-camera and Photos capture
- OpenCV contour detection through a replaceable `jscanify` adapter
- Normalized four-corner geometry
- Stability-based auto capture
- Blur, exposure, glare, coverage, and rectangle quality scoring
- Manual four-corner correction
- Perspective extraction
- Original, Color+, Clean, and B&W filters
- Multi-page local session
- JPEG and PDF export
- PWA shell and local-only processing

## Architecture

```text
CaptureAdapter
  -> DetectionEngine
  -> QualityGate
  -> CornerReview
  -> PerspectivePipeline
  -> FilterPipeline
  -> DocumentSession
  -> ExportAdapter
```

The interfaces are intentionally separated so the contour detector can later be replaced with a custom OpenCV build, a WebGPU model, or a native iOS adapter without rewriting the UI/session layer.

## Run

```bash
npm install
npm test
npm run dev
```

Camera access requires HTTPS outside localhost. OpenCV.js is loaded from the official OpenCV CDN in this first lab build; all document pixels stay in the browser.
