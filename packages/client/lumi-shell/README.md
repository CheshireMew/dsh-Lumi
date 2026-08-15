# @dsh-lumi/client-shell

English | [中文](README.zh.md)

Immersive scene/work presentation registered into `layout.frame` at priority `-100`. It arranges the official sidebar, conversation, details, and overlay render callbacks without owning their business state. Unloading this package reveals the upstream `AppFrame` at priority `0` with the same mounted layout and session state.

The frame mirrors the official narrow-layout state into the shared layout store, renders a 56-pixel sidebar rail and work layout below 1100 pixels, respects system and user reduced-motion preferences, and uses pack-declared Web Animations. The 44-pixel custom title bar appears only when the Electron preload API is present; an ordinary browser keeps scene/work controls without rendering desktop window buttons.

## Model Experience

None, as the package derives character presentation from browser session snapshots but does not add, alter, or persist model-visible content.

#### KV Cache effect

None; no model request changes.

## Known Limitations and Deferred Work

- The shell uses static image states and CSS motion rather than Live2D, skeletal animation, video, or 3D rendering.
- The title bar is Windows-verified; platform-specific window affordances remain unverified elsewhere.
