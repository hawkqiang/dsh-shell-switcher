# Shell switcher

DeepSeek Harness plugin: pick the shell backend from **Settings → General** — Windows PowerShell, Linux bash, Android's unconfined bash, or macOS bash — one profile-wide choice instead of per-host composition guessing.

A four-button segmented control in **Settings → General** decides which shell backend this DSH profile mounts. The choice is profile-wide: it belongs to the machine, not to one conversation, so it lives beside the other profile preferences rather than in the composer.

## Install

```bash
gh repo clone hawkqiang/dsh-shell-switcher
```

Then install that directory as a bundle: **Settings → Plugins → Add plugin** (local directory), or, when the Plugin Manager tool is available to the agent, one `plugin_manager` `install_bundle` call with the checkout path. Any tarball produced by `npm pack` works too. The package resolves the shipped `@deepseek-ai/*` executors from the DSH installation, so it declares no dependencies.

## What each button mounts

| Button | Executor (`ctx.shell`) | Tool | Confinement |
|---|---|---|---|
| Windows | `@deepseek-ai/dsh-pwsh-sandbox` | `pwsh` | Windows ACL backend (partial) |
| Linux | `@deepseek-ai/dsh-bash-sandbox` | `bash` | bubblewrap or Landlock; fails closed with `SANDBOX_UNAVAILABLE` when neither runs |
| Android | this bundle's `AndroidBashExecutor` (unconfined bash) | `bash` | none — commands run unconfined |
| macOS | `@deepseek-ai/dsh-bash-sandbox` | `bash` | Seatbelt |

The bundle disables the shipped `bash-sandbox`, `pwsh-sandbox`, `tool-bash`, and `tool-pwsh` rows and re-mounts one executor + one tool pair from its `platform` config field. Changing the field restarts the plugin, which disposes the old pair and mounts the new one; the tool registry and the model-visible system prompt follow immediately.

## Why Android is a separate channel

Android kernels give ordinary apps no usable sandbox backend: unprivileged user namespaces are refused (`unshare -U` returns `EINVAL`), so bubblewrap cannot start, and Landlock is not enforced for app processes (the shipped `landlock-run` launcher probes `125: landlock is not enforced by this kernel`). The confined executor therefore fails every call with `SANDBOX_UNAVAILABLE`.

Selecting Android runs bash unconfined instead of having no shell at all. The model's system prompt says so explicitly, and writes made by commands are not contained by `workspace-write`.

`AndroidBashExecutor` extends the shipped local executor for one reason: `@deepseek-ai/dsh-permission-presets` refuses to compose over an executor whose `sandboxMode` is `undefined`, which a bare `dsh-bash-local` is. The subclass reports the deployment default mode, so the permission presets, the approval policy, and the file tools' in-process fence keep working normally while commands themselves stay unconfined.

## Detection

`platform: auto` picks the channel from the host:

- `win32` → Windows, `darwin` → macOS.
- Android → Android. Termux usually runs a glibc Node under a compatibility loader, so `process.platform` reports `linux`; the check therefore also looks at `TERMUX_VERSION`, `PREFIX`, and Android host markers.
- Anything else → Linux.

## Configuration

`platform` accepts `auto`, `windows`, `linux`, `android`, or `macos`. A button press persists the concrete value through the config editor and survives restart.

## Known limitations

- The selection is global to the profile; it is not per conversation and does not follow a workspace.
- Selecting a platform whose backend is missing from the host (for example Linux on Android) is allowed: it restores the fail-closed sandboxed executor, and every command then reports `SANDBOX_UNAVAILABLE`.
- On the Android channel the permission presets still report a sandbox mode, because the presets require one. The mode drives the file tools' fence and approval policy; it does not confine commands.
- Only the Android and Linux-on-Android paths were exercised on this host. The Windows PowerShell and macOS Seatbelt paths mount the shipped executors unchanged but were not run here.
- Reloading a changed plugin package can require a DSH restart before new code runs; the buttons act on the module generation that is loaded.
