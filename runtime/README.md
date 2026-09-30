# Pinned local runtime

This directory contains metadata and the dependency lock only. No model weights,
Python environment, voice recordings, account data, or user profile is included.

The lock targets native Apple Silicon **macOS26 or newer with Python3.13**.
In particular, the locked MLX0.32.3 and mlx-metal0.32.3 wheels require macOS26.
The bootstrap installs the listed wheels with `--require-hashes --no-deps`;
it deliberately uses the tested direct inference dependencies rather than the
full set of optional mlx-audio packages.

From the repository root:

```sh
python3.13 setup_runtime.py
```

The new runtime lives at
`~/Library/Application Support/ChatGPT Read Aloud/kokoro` with a private parent
directory, a separate `.venv`, the fixed `worker-sentences-v1.py` worker, MLX
float32 inference, and `selectedVoice:null`. Choose a voice with previews in the
app after installing it. Existing runtimes and saved voice settings are never
overwritten. This command is for a fresh setup, not a worker migration.

`assets.json` pins the model and configuration to one Hugging Face commit and
the complete voice bank to one upstream kokoro-onnx release. Each asset is checked
against both its exact byte count and SHA256. The three files total approximately
355MB; the Python wheels require additional downloads and disk space. The pinned
model file contains float32 weights despite the upstream repository's bf16 name.

Sources:

- [Pinned MLX model repository](https://huggingface.co/mlx-community/Kokoro-82M-bf16/tree/a71e4d38b236d968966a2002c4c895dbd12b1c3c)
- [Kokoro-ONNX model-files-v1.1 release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1)
- [MLX0.32.3 published wheels](https://pypi.org/project/mlx/0.32.3/#files)
- [mlx-metal0.32.3 published wheels](https://pypi.org/project/mlx-metal/0.32.3/#files)

For an existing read-only model cache, use:

```sh
python3.13 setup_runtime.py --asset-cache /absolute/path/to/cache
```

That directory must contain all three exact, regular files named
`kokoro-v1_0.safetensors`, `config.json`, and `voices-v1.0.bin`. A missing,
symlinked, or mismatched asset fails instead of silently downloading a replacement.
The cache is read without modifications. Python package installation still uses
PyPI; this flag only avoids model-asset downloads.

After setup, inference uses those local files. The installed app starts the
worker with a network-denying sandbox. Setup itself needs network access unless
you supply the asset cache and have the locked wheels available to pip.
