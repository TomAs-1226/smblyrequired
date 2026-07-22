// =============================================================================
// visionDetector — a pluggable object detector for the vision pipeline.
//
// 0011 hard-wired COCO-SSD, a GENERIC detector that finds everyday objects and
// knows nothing about robots or game pieces. This module makes the model a
// choice behind ONE interface, so the capture screen does not care which is
// running:
//
//   loadDetector(null)            -> the built-in generic model (honest fallback)
//   loadDetector({ url, labels }) -> a real FRC-trained YOLO model exported to
//                                    TensorFlow.js — the format Ultralytics,
//                                    Roboflow and PhotonVision all produce, i.e.
//                                    what other teams actually train and deploy.
//
// EVERYTHING here is behind dynamic import()s of @tensorflow/* so the whole stack
// stays in its own lazy chunk and never touches the public bundle — the exact
// discipline RobotCapture.jsx documents. Do not add a static tf import anywhere.
//
// Unified detector shape returned by both backends:
//   {
//     id, name, note, generic: boolean, labels: string[],
//     detect(videoOrCanvas) -> Promise<[{ class, score, bbox:[x,y,w,h] }]>,  // bbox in SOURCE pixels
//     dispose()
//   }
// bbox is [x, y, w, h] in the SOURCE element's own pixels — the same convention
// COCO-SSD uses — so the overlay code draws boxes identically for either model.
// =============================================================================

const MIN_SCORE = 0.35 // below this a detection is more noise than signal
const MAX_DETECTIONS = 30 // a field can hold a lot of robots + pieces at once
const IOU_THRESHOLD = 0.45 // NMS overlap above which two boxes are "the same thing"

// Focus stand-ins for the generic model — the closest COCO classes to FRC things,
// surfaced so a demo shows a meaningful number before a trained model exists.
const GENERIC_STANDINS = ['sports ball', 'person']

// -----------------------------------------------------------------------------
// Generic backend: COCO-SSD, lite_mobilenet_v2. Its detect() already returns
// [{ class, score, bbox:[x,y,w,h] }] in source pixels, so the wrapper is thin.
// -----------------------------------------------------------------------------
async function loadGenericDetector() {
  const [tf, cocoSsd] = await Promise.all([
    import('@tensorflow/tfjs'),
    import('@tensorflow-models/coco-ssd'),
  ])
  await tf.ready()
  const net = await cocoSsd.load({ base: 'lite_mobilenet_v2' })
  return {
    id: 'coco-ssd@lite_mobilenet_v2',
    name: 'Built-in generic detector',
    note: 'Generic COCO detector — counts everyday objects, not FRC game pieces or robots. A pipeline/data-collection stand-in until a trained model is loaded.',
    generic: true,
    labels: GENERIC_STANDINS,
    async detect(source) {
      const preds = await net.detect(source, MAX_DETECTIONS, MIN_SCORE)
      return preds.map((p) => ({ class: p.class, score: p.score, bbox: p.bbox }))
    },
    dispose() {
      net.dispose?.()
    },
  }
}

// -----------------------------------------------------------------------------
// Custom backend: a YOLO detection model exported to TF.js (a Graph model).
//
// This is standard Ultralytics/Roboflow-export inference: letterbox the frame to
// the model's square input, run it, decode the single output grid, non-max
// suppress, and map boxes back to source pixels. Written to the documented
// YOLOv8/YOLO11 export contract; validate against your actual exported model,
// since the built-in generic model is always the safe fallback if this misfires.
// -----------------------------------------------------------------------------
async function loadYoloDetector({ url, name, labels, size }) {
  const tf = await import('@tensorflow/tfjs')
  await tf.ready()
  const model = await tf.loadGraphModel(url)
  const inputSize = Number(size) > 0 ? Number(size) : 640
  const classNames = Array.isArray(labels) ? labels.map(String) : []

  // A single warm-up pass so the first real frame is not the one that pays for
  // shader compilation (seconds of jank right when capture starts).
  tf.tidy(() => {
    const warm = model.execute(tf.zeros([1, inputSize, inputSize, 3]))
    if (Array.isArray(warm)) warm.forEach((t) => t.dispose?.())
    else warm.dispose?.()
  })

  const pickOutput = (out) => {
    // Some exports return an array of tensors; the detection grid is the one
    // whose rank-3 shape carries the ~8400 anchors. Pick the largest.
    if (!Array.isArray(out)) return out
    return out.reduce((a, b) => (b.size > a.size ? b : a))
  }

  return {
    id: `yolo-tfjs:${name || url}`,
    name: name || 'Custom TF.js model',
    note: `Custom on-device model (${classNames.length || '?'} classes) at ${inputSize}px input.`,
    generic: false,
    labels: classNames,
    async detect(source) {
      const sw = source.videoWidth ?? source.width
      const sh = source.videoHeight ?? source.height
      if (!sw || !sh) return []

      // Letterbox: preserve aspect on a black square so the model never sees a
      // stretched robot. The pad/scale are kept to invert boxes afterward.
      const scale = Math.min(inputSize / sw, inputSize / sh)
      const nw = sw * scale
      const nh = sh * scale
      const padX = (inputSize - nw) / 2
      const padY = (inputSize - nh) / 2

      const canvas = document.createElement('canvas')
      canvas.width = inputSize
      canvas.height = inputSize
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, inputSize, inputSize)
      ctx.drawImage(source, padX, padY, nw, nh)

      // Decode the grid to a flat [N, C] Float32Array, disposing every tensor.
      const { data, N, C } = await tf.tidy(() => {
        const input = tf.browser.fromPixels(canvas).toFloat().div(255).expandDims(0)
        let out = pickOutput(model.execute(input)).squeeze() // [C, N] or [N, C]
        const [d0, d1] = out.shape
        // C (= 4 + numClasses) is the small dim; N (anchors, ~8400) is the large.
        if (d0 < d1) out = out.transpose([1, 0]) // -> [N, C]
        return { data: out.dataSync(), N: out.shape[0], C: out.shape[1] }
      })

      const numClasses = C - 4
      const boxes = [] // [y1, x1, y2, x2] in input px, for NMS
      const scores = []
      const classIds = []
      for (let i = 0; i < N; i += 1) {
        const off = i * C
        let best = 0
        let bestId = 0
        for (let c = 0; c < numClasses; c += 1) {
          const v = data[off + 4 + c]
          if (v > best) {
            best = v
            bestId = c
          }
        }
        if (best < MIN_SCORE) continue
        const cx = data[off]
        const cy = data[off + 1]
        const w = data[off + 2]
        const h = data[off + 3]
        boxes.push([cy - h / 2, cx - w / 2, cy + h / 2, cx + w / 2])
        scores.push(best)
        classIds.push(bestId)
      }
      if (boxes.length === 0) return []

      // Explicit tensors so the shapes are unambiguous and disposal is ours.
      const boxesT = tf.tensor2d(boxes, [boxes.length, 4])
      const scoresT = tf.tensor1d(scores)
      const keep = await tf.image.nonMaxSuppressionAsync(
        boxesT,
        scoresT,
        MAX_DETECTIONS,
        IOU_THRESHOLD,
        MIN_SCORE
      )
      const keepIdx = await keep.data()
      boxesT.dispose()
      scoresT.dispose()
      keep.dispose()

      // Invert the letterbox back to SOURCE pixels, returning [x, y, w, h].
      const results = []
      for (const k of keepIdx) {
        const [y1, x1, y2, x2] = boxes[k]
        const vx1 = (x1 - padX) / scale
        const vy1 = (y1 - padY) / scale
        const vw = (x2 - x1) / scale
        const vh = (y2 - y1) / scale
        results.push({
          class: classNames[classIds[k]] ?? `class ${classIds[k]}`,
          score: scores[k],
          bbox: [vx1, vy1, vw, vh],
        })
      }
      return results
    },
    dispose() {
      model.dispose?.()
    },
  }
}

// Load whichever model the settings ask for. A custom URL wins; anything missing
// or malformed falls back to the generic model rather than failing the capture —
// a scout at a competition needs a working camera far more than a perfect model.
export async function loadDetector(config) {
  if (config?.url) {
    try {
      return await loadYoloDetector(config)
    } catch (err) {
      console.warn('[vision] custom model failed, falling back to generic:', err?.message ?? err)
      const generic = await loadGenericDetector()
      return {
        ...generic,
        note: `Custom model failed to load — using the generic detector instead. ${generic.note}`,
      }
    }
  }
  return loadGenericDetector()
}
