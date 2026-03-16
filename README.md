# NVIDIA NemoClaw: OpenClaw Plugin for OpenShell

[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](LICENSE)
[![Security Policy](https://img.shields.io/badge/Security-Report%20a%20Vulnerability-red)](SECURITY.md)
[![Project Status](https://img.shields.io/badge/status-alpha-orange)](docs/about/release-notes.md)

NemoClaw is the [OpenClaw](https://openclaw.ai) plugin for [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell). It moves OpenClaw into a sandboxed environment where every network request, file access, and inference call is governed by declarative policy with NVIDIA inference routing through Nemotron models through [build.nvidia.com](https://build.nvidia.com), a local NIM service, or vLLM.

> **Alpha software**
> 
> NemoClaw is early-stage. Expect rough edges. We are building toward production-ready sandbox orchestration, but the starting point is getting your own environment up and running.
> Interfaces, APIs, and behavior may change without notice as we iterate on the design.
> The project is shared to gather feedback and enable early experimentation, but it
> should not yet be considered production-ready.
> We welcome issues and discussion from the community while the project evolves.

---

## Quick Start

Follow these steps to get started with NemoClaw and your first sandboxed OpenClaw agent.

### Prerequisites

Check the prerequisites before you start to ensure you have the necessary software and hardware to run NemoClaw.

#### Software

- Linux Ubuntu 22.04 LTS releases and later
- Docker installed and running
- [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) installed

### Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

```console
$ git clone https://github.com/NVIDIA/openshell-openclaw-plugin.git
$ cd openshell-openclaw-plugin
$ ./install.sh
```

The installer detects available VRAM and pulls the appropriate model:

| Available VRAM                   | Model pulled             |
|----------------------------------|--------------------------|
| >= 120 GB (such as 2 H100 80 GB) | `nemotron-3-super:120b`  |
| < 120 GB                         | `nemotron-3-nano:30b`    |

The installer handles all other dependencies, including Node.js, Docker, the OpenShell CLI, and Ollama.

When the install completes, a summary confirms the running environment:

```
──────────────────────────────────────────────────
Dashboard    http://localhost:18789/
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Cloud API)
──────────────────────────────────────────────────
Run:         nemoclaw my-assistant connect
Status:      nemoclaw my-assistant status
Logs:        nemoclaw my-assistant logs --follow
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

### Chat with the Agent

Connect to the sandbox, then chat with the agent through the TUI or the CLI.

```console
$ nemoclaw my-assistant connect
```

#### OpenClaw TUI

The OpenClaw TUI opens an interactive chat interface. Type a message and press Enter to send it to the agent:

```console
sandbox@my-assistant:~$ openclaw tui
```

Send a test message to the agent and verify you receive a response.

#### OpenClaw CLI

Use the OpenClaw CLI to send a single message and print the response:

```console
sandbox@my-assistant:~$ openclaw agent --agent main --local -m "hello" --session-id test
```

---

## How It Works

NemoClaw combines a lightweight TypeScript plugin with a versioned Python blueprint to move OpenClaw into a controlled sandbox. The plugin registers commands under the `openclaw nemoclaw` namespace and delegates orchestration to the blueprint, which drives all interactions with the OpenShell CLI.

| Component        | Role                                                                                      |
|------------------|-------------------------------------------------------------------------------------------|
| **Plugin**       | TypeScript CLI commands for launch, migrate, connect, status, logs, and eject.            |
| **Blueprint**    | Versioned Python artifact that orchestrates sandbox creation, policy, and inference setup. |
| **Sandbox**      | Isolated OpenShell container running OpenClaw with policy-enforced egress and filesystem.  |
| **Inference**    | NVIDIA-routed model calls (cloud, local NIM, or vLLM), transparent to the agent.          |

The blueprint lifecycle follows five stages: resolve the artifact, verify its digest, plan the resources, apply through the OpenShell CLI, and report status or rollback from a snapshot.

## Inference Profiles

Inference requests from the agent never leave the sandbox directly. OpenShell intercepts every call and routes it to the configured provider. NemoClaw ships with three profiles:

| Profile     | Provider     | Model                               | Use Case                                       |
|-------------|--------------|--------------------------------------|-------------------------------------------------|
| `default`   | NVIDIA cloud | `nvidia/nemotron-3-super-120b-a12b` | Production. Requires an NVIDIA API key.         |
| `nim-local` | Local NIM    | `nvidia/nemotron-3-super-120b-a12b` | On-premises. NIM deployed as a local container. |
| `vllm`      | vLLM         | `nvidia/nemotron-3-nano-30b-a3b`    | Local development. vLLM on the host.            |

Select a profile at launch with `--profile`, or switch at runtime without restarting the sandbox:

```console
$ openclaw nemoclaw launch --profile vllm
$ openshell inference set --provider vllm-local --model nvidia/nemotron-3-nano-30b-a3b
```

## Protection Layers

The sandbox starts with a strict baseline policy that controls network egress and filesystem access:

| Layer      | What it protects                                    | When it applies             |
|------------|-----------------------------------------------------|-----------------------------|
| Network    | Blocks unauthorized outbound connections.           | Hot-reloadable at runtime.  |
| Filesystem | Prevents reads/writes outside `/sandbox` and `/tmp`.| Locked at sandbox creation. |
| Process    | Blocks privilege escalation and dangerous syscalls. | Locked at sandbox creation. |
| Inference  | Reroutes model API calls to controlled backends.    | Hot-reloadable at runtime.  |

When the agent tries to reach an unlisted host, OpenShell blocks the request and surfaces it in the TUI for operator approval.

## Key Commands

| Command                                    | Description                                              |
|--------------------------------------------|----------------------------------------------------------|
| `nemoclaw setup`                           | Full host-side setup: gateway, providers, sandbox.       |
| `nemoclaw deploy <instance>`               | Deploy to a remote GPU instance through Brev.            |
| `nemoclaw <name> connect`                  | Open an interactive shell inside the sandbox.            |
| `nemoclaw term`                            | Launch the OpenShell TUI for monitoring and approvals.   |
| `nemoclaw start` / `stop` / `status`       | Manage auxiliary services (Telegram bridge, tunnel).     |
| `openclaw nemoclaw launch [--profile ...]` | Bootstrap OpenClaw inside an OpenShell sandbox.          |
| `openclaw nemoclaw migrate [--dry-run]`    | Migrate a host OpenClaw installation into a sandbox.     |
| `openclaw nemoclaw status`                 | Show sandbox health, blueprint state, and inference.     |
| `openclaw nemoclaw logs [-f]`              | Stream blueprint execution and sandbox logs.             |
| `openclaw nemoclaw eject`                  | Roll back to the host installation from a snapshot.      |

See the full [CLI reference](docs/reference/commands.md) for all commands, flags, and options.

## Learn More

- [Quickstart](docs/get-started/quickstart.md): detailed install and first sandbox walkthrough
- [Overview](docs/about/overview.md): what NemoClaw does and how it fits together
- [How It Works](docs/about/how-it-works.md): plugin, blueprint, and sandbox lifecycle
- [Architecture](docs/reference/architecture.md): plugin structure, blueprint lifecycle, and sandbox environment
- [Inference Profiles](docs/reference/inference-profiles.md): NVIDIA cloud, NIM, and vLLM configuration
- [Network Policies](docs/reference/network-policies.md): egress control and policy customization
- [CLI Commands](docs/reference/commands.md): full command reference

## License

This project is licensed under the [Apache License 2.0](LICENSE).
