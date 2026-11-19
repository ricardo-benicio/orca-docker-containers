# Docker Containers for Orca

See and control your Docker containers without leaving [Orca](https://onorca.dev). A panel in the
right sidebar lists every container, grouped by Docker Compose project, and updates the moment
something starts or stops.

![Every container state at a glance](assets/screenshots/grouped.png)

## Features

- **Grouped by project.** Containers are grouped by their Docker Compose project; the rest go under
  "Standalone". Projects with running containers come first.
- **Live.** Listens to `docker events`, so the list updates instantly, even when you start or stop
  something from a terminal. A 30-second refresh is kept as a safety net.
- **Status at a glance.** Two compact lines per container: a coloured dot (filled when running, hollow when stopped), the image, a short uptime like `3h` and the published ports. A state word appears only when it matters (`unhealthy`, `restarting`, `paused`, `exited (3)`), and containers that need attention get a tinted row.
- **Actions.** Start, stop and restart a container, or a whole Compose project at once, with the project buttons in the group header. Click the project name to collapse it.
- **Logs.** The last 200 lines of any container, right in the panel, or follow them live in an Orca terminal.
- **Shell.** Open a shell inside a running container in a new Orca terminal (bash if the image has it, otherwise sh).
- **Details.** Image, command, restart policy, networks and volumes (never environment variables or labels).
- **Status bar.** A `running/total` counter you can click to toggle the sidebar, plus a `Docker: Show running containers summary` command in the palette and the `Mod+Alt+D` shortcut.
- **Notifications.** A desktop notification when a container crashes (non-zero exit), runs out of memory or turns unhealthy. Normal stops are ignored and repeats are throttled.
- **Open a port.** One click opens `http://localhost:<port>` in your browser.
- **Filter.** Search by name, image, project or port, or show running containers only.
- **Settings.** Docker binary, Docker context (for example Colima or a remote host), refresh interval, notifications and status bar can all be changed in Settings → Plugins.
- **Helpful errors.** Tells you when Docker is missing, stopped, or you lack permission, and how to fix it.
- **English and Portuguese**, following Orca's language.

![A healthy stack with a stopped container](assets/screenshots/live-status.png)

## Requirements

- Orca with plugins enabled (Settings → Plugins).
- The `docker` CLI on the `PATH` of the user running Orca, able to reach the Docker daemon.

## Install

In Orca: Settings → Plugins → Add plugin → From a Git URL, then paste:

```
https://github.com/ricardo-benicio/orca-docker-containers
```

Or from the terminal:

```sh
orca plugin install ricardo-benicio/orca-docker-containers
```

Orca shows what the plugin can access and asks you to approve it before it runs. Open the **Docker**
icon in the right sidebar tabs.

## Security

This plugin runs a Node worker with your user's access (`trusted-worker`), which is why Orca asks for
explicit approval. Version 0.3.0 asked for more than 0.2.0; 0.4.0 asks for nothing new. Here
is what each permission is used for, and nothing else:

| Permission | Used for |
| --- | --- |
| Run its own code | Talking to the `docker` CLI and watching `docker events` |
| `terminal:send` | Opening one terminal in your focused workspace when you press **Open shell** or **Follow logs**. Orca describes this permission broadly (it also covers typing into terminals); the plugin only calls `terminal.create`. |
| `workspace:read` | Reading the id of the focused workspace, to know where to open that terminal. Nothing else about your workspaces is read. |
| `notifications:show` | The crash, out-of-memory and unhealthy notifications |
| `settings:own` | Reading this plugin's own settings |
| `storage:own` | Remembering the panel's filter and collapsed groups |

What the worker runs:

- `docker ps`, `docker inspect`, `docker logs`, `docker events` and `docker start|stop|restart <id…>`,
  through `execFile` (no shell).
- In a terminal, only `docker exec -it <id> sh -c '…bash or sh…'` and `docker logs -f --tail 200 <id>`.
  The id is checked to be hexadecimal, and the docker command and context you configure are checked
  to contain only letters, digits and `./_+@-`, so nothing can be injected into the terminal line.
- It rejects invalid ids, project names and actions before calling Docker.
- It never deletes containers, images or volumes, and never sends environment variables or labels
  to the panel.
- It makes no network requests. The only link it opens is `http://localhost:<port>` for a port you
  click, in your browser.

## Development

```sh
orca plugin validate .
orca plugin test .          # parsers, worker and panel tests
orca plugin check .         # renders the panel in four states
orca plugin dev watch . --check
node --test src/docker.test.ts src/i18n.test.ts src/config.test.ts src/alerts.test.ts   # the pure tests, no Orca needed (what CI runs)
```

## Releasing

Bump `version` in `orca-plugin.json`, commit, then `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
Users get it with `orca plugin update`.

## Português

Painel na barra lateral direita do Orca que lista os containers do Docker, agrupados por projeto do
Compose, e atualiza na hora em que algo inicia ou para. Permite iniciar, parar e reiniciar um
container ou o projeto inteiro, ver os logs, abrir uma porta no navegador e filtrar por nome, imagem,
projeto ou porta. A interface segue o idioma do Orca (inglês ou português).

Requer o comando `docker` no `PATH` do usuário que roda o Orca. O worker roda com o acesso do seu
usuário, por isso o Orca pede aprovação; ele só executa os comandos listados em "Security" acima.

## License

MIT
