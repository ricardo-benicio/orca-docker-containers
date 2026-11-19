# Docker Containers for Orca

Painel na barra lateral direita do [Orca](https://onorca.dev) que lista os containers do Docker.
A right-sidebar panel for Orca that lists your Docker containers.

## Recursos / Features

- Containers agrupados por projeto do Docker Compose (os demais ficam em "Avulsos").
- Estado, imagem, portas publicadas e status de cada container.
- Logs (últimas 200 linhas), reiniciar, parar e iniciar direto no painel.
- Filtro por nome, imagem, projeto ou porta, e opção "Somente em execução".
- Atualiza a cada 5 segundos, apenas enquanto o painel está visível.

## Requisitos / Requirements

- Orca com plugins habilitados (Settings → Plugins).
- Docker CLI (`docker`) no PATH do usuário que roda o Orca, com acesso ao daemon.

## Instalação / Install

```sh
orca plugin install ricardo-benicio/orca-docker-containers
```

## Segurança / Security

O plugin roda um worker Node com o acesso do seu usuário (perfil `trusted-worker`), por isso o Orca
pede aprovação explícita na instalação. O worker só executa `docker ps`, `docker logs` e
`docker start|stop|restart <id>` via `execFile` (sem shell), e recusa ids que não sejam hexadecimais
e ações fora dessa lista. Não usa rede e não lê nada além da saída do Docker.

The worker runs as your user (`trusted-worker`), so Orca asks for explicit approval. It only runs
`docker ps`, `docker logs` and `docker start|stop|restart <id>` through `execFile` (no shell) and
rejects any id that is not hexadecimal. It makes no network requests.

## Desenvolvimento / Development

```sh
orca plugin validate .
orca plugin test .
orca plugin dev watch . --check
```

Licença / License: MIT
