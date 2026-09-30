# Third-party components

This repository publishes custom glue/UI/build code. It imports speech libraries
and downloads model assets during local setup; it does not vendor their source,
virtual environments, weights, or the official desktop app.

- **Kokoro-82M:** [original model and model card](https://huggingface.co/hexgrad/Kokoro-82M),
  which identifies the weights as Apache 2.0. Review upstream model/voice notices.
- **MLX model conversion:** [pinned revision](https://huggingface.co/mlx-community/Kokoro-82M-bf16/tree/a71e4d38b236d968966a2002c4c895dbd12b1c3c).
  The exact download metadata and hashes are in `runtime/assets.json`.
- **Voice bank and tokenizer:** [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx).
  The installed package's license is MIT, copyright 2025 github.com/thewh1teagle.
- **MLX Audio:** [mlx-audio](https://github.com/Blaizzy/mlx-audio).
  The installed package's license is MIT, copyright 2024 Prince Canuma.
- **MLX:** [Apple MLX](https://github.com/ml-explore/mlx).
  The installed package's license is MIT, copyright 2023 Apple Inc.
- **Phonemization:** the installed dependency chain includes
  [phonemizer](https://github.com/bootphon/phonemizer) and eSpeak NG components.
  Phonemizer carries GPLv3 licensing; not every dependency is MIT.
- **Development screenshots/tests:** [Playwright](https://github.com/microsoft/playwright).
- **Desktop build input:** a user's own official ChatGPT installation. OpenAI's
  app and generated renderer assets are not part of this source distribution.

`runtime/requirements.lock` records the exact tested macOS arm64/Python 3.13
package versions and hashes. Installed packages retain their LICENSE files and
notices in the private environment. Consult each upstream project for the full
license terms rather than applying this repository's MIT license to dependencies
or model assets. If a future change vendors upstream files, include their exact
notices with those files.
