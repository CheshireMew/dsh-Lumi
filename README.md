# Lumi

English | [中文](README.zh.md)

Lumi is a Windows desktop experience built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds a persistent character, scene and work layouts, local character packs, speech, and bond progression while retaining the Harness session, plugin, settings, and tool model.

The extension remains additive: Lumi is composed as plugins over the official Web application, while Electron owns the desktop window, local process lifecycle, diagnostics, signed Windows delivery, and update checks. The underlying architecture keeps **everything as a plugin** and is powered by [Cordis](https://github.com/cordiverse/cordis).

## Developer preview

Lumi is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from source

Install Node 22.23.2, enable the repository-pinned pnpm through Corepack, and run from a checkout:

```sh
git clone https://github.com/CheshireMew/dsh-Lumi.git
cd dsh-Lumi
corepack enable
pnpm install
pnpm run dev:lumi
```

Lumi opens its Electron window after building the complete Harness and Lumi application. Existing sessions, settings, credentials, plugins, character packs, and logs remain under the normal `$DSH_HOME`. See the [Lumi desktop guide](docs/user/guide/lumi-desktop.md).

Signed Windows installers are staged through the protected, exact-tag release workflow. The workflow requires Windows code-signing credentials and creates a draft release for operator review; it does not silently publish from an ordinary branch build.

## Run the Harness Web UI

The unmodified Harness Web entry remains available from the same checkout:

```sh
pnpm run build
pnpm dsh web
```

## Community and support

- Submit Lumi feedback and bug reports through [this repository's Issues](https://github.com/CheshireMew/dsh-Lumi/issues).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
