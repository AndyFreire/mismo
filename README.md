# Mismo

**On-device visual product search.** *Mismo* is Spanish for "the same."

Point your phone at an everyday product and see the closest matching products from a catalog, in about a second, with nothing uploaded. When it isn't sure, it tells you what it thinks the item is and offers a one-tap shopping search instead.

Built entirely on Google's on-device AI stack (MediaPipe) and runs in the browser on phone or desktop.

**Live demo:** https://YOUR-GITHUB-USERNAME.github.io/mismo/ (step 1 device check)

> Status: Weekend 1, step 1. The live page is a device check that proves the MediaPipe Image Embedder runs on a phone and records load time, speed and device support. The product case study below will be filled in as the build progresses.

## Run it locally

```bash
bash scripts/fetch_models.sh      # once: downloads the model files into web/models/
cd web
python3 -m http.server 8000       # then open http://localhost:8000
```

## Project structure

```
web/                 the static site GitHub Pages serves
  index.html         step 1 device check (moves to lab/ when the app lands)
  js/config.js       versions and model paths
  js/embedder.js     shared engine code: load, crop, embed, compare
  js/probe.js        device check page logic
  models/            MediaPipe model files (committed)
scripts/             one-time build and data scripts
.github/workflows/   deploys web/ to GitHub Pages on every push
```

## Case study

_Coming in Weekend 2: problem and user, key decisions and trade-offs, evaluation results, and what I'd do next with a team._

## Privacy

Photos are processed on the device and never uploaded. There is no backend. The MediaPipe library sends anonymous performance and usage metrics (no image data) to Google, as described in the [MediaPipe Tasks privacy notice](https://www.npmjs.com/package/@mediapipe/tasks-vision).

## Attribution

- **MediaPipe Tasks Vision** by Google, Apache License 2.0. Models: MobileNet-V3 Image Embedder and EfficientNet-Lite0 Image Classifier from the MediaPipe model collection.
- **Amazon Berkeley Objects (ABO)** product data and images, credit Amazon.com, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Collins et al., "ABO: Dataset and Benchmarks for Real-World 3D Object Understanding," CVPR 2022.

## License

Code: MIT (see LICENSE). Models and data keep their own licenses, listed above.
