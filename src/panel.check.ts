// `orca plugin check` desenha o painel uma vez por cenário, sem tocar no Docker real.
import { defineCheck } from 'orca/testing'

const web = { id: 'a'.repeat(12), name: 'meu-app-web-1', image: 'nginx:1.27', state: 'running', status: 'Up 3 hours (healthy)', ports: [{ host: 8080, container: 80 }], project: 'meu-app' }
const db = { id: 'b'.repeat(12), name: 'meu-app-db-1', image: 'postgres:16', state: 'running', status: 'Up 3 hours', ports: [{ host: 5432, container: 5432 }], project: 'meu-app' }
const sick = { id: 'd'.repeat(12), name: 'meu-app-api-1', image: 'caddy:2', state: 'running', status: 'Up 2 minutes (unhealthy)', ports: [], project: 'meu-app' }
const loop = { id: 'e'.repeat(12), name: 'meu-app-cron-1', image: 'busybox', state: 'restarting', status: 'Restarting (1) 4 seconds ago', ports: [], project: 'meu-app' }
const old = { id: 'c'.repeat(12), name: 'redis-antigo', image: 'redis:7', state: 'exited', status: 'Exited (0) 2 weeks ago', ports: [], project: null }

export default defineCheck({
  projects: { requests: { 'containers.list': () => ({ ok: true, containers: [web, db, old], at: Date.now() }) } },
  projectsLight: { theme: 'light', requests: { 'containers.list': () => ({ ok: true, containers: [web, db, old], at: Date.now() }) } },
  attention: { requests: { 'containers.list': () => ({ ok: true, containers: [web, sick, loop, db, old], at: Date.now() }) } },
  empty: { requests: { 'containers.list': () => ({ ok: true, containers: [], at: Date.now() }) } },
  daemonDown: { requests: { 'containers.list': () => ({ ok: false, code: 'daemon_down', error: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' }) } }
})
