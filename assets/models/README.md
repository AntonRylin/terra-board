# Background removal

Terra Board bundles the general-purpose **U²-Net** model by Xuebin Qin et al.
The original project and model are distributed under Apache-2.0; the license is
included in `U-2-Net-LICENSE.txt`.

- Original project: https://github.com/xuebinqin/U-2-Net
- ONNX conversion distributed by rembg: https://github.com/danielgatis/rembg/releases/tag/v0.0.0
- File: `u2net.onnx`, downloaded by `scripts/prepare-background-model.mjs`
- SHA-256: `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491`

The model is git-ignored, verified/downloaded during `npm run build`, and unpacked
beside the packaged application. Network access is needed only for a build that
does not already have the model. Runtime inference uses Microsoft's MIT-licensed
ONNX Runtime on the CPU, with no account, remote service, or image uploads.

Input is normalized RGB at 320 × 320. The inferred soft mask is resized to the
original oriented dimensions and multiplied with existing alpha, then stored as
a new PNG. Original assets remain untouched and board edits use normal undo.
Inference runs in a disposable worker with bounded concurrency, CPU threads,
pixel count and duration. It does not hold up SQLite edits or image decoding.

For icons, existing PNG transparency is preserved. Uniform edge-connected
backgrounds are removed directly so enclosed logo details remain intact. Other
opaque icons use the same model. Click Remove background after uploading or on
an existing icon; the original preview can be restored before saving.

Automatic segmentation is approximate: fine hair, shadows, busy scenes and
multiple subjects may need a different source image or manual editing elsewhere.
