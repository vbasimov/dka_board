import { createServer as httpCreateServer } from 'node:http'

function send(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  response.end(payload)
}

export function createApp({ store }) {
  return (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method !== 'GET') {
      send(response, 405, { error: 'метод не поддерживается' })
      return
    }
    if (url.pathname === '/api/tasks') {
      const query = url.searchParams.get('q') ?? ''
      send(response, 200, { items: store.search(query), total: store.count() })
      return
    }
    if (url.pathname === '/api/health') {
      send(response, 200, { ok: true, tasks: store.count() })
      return
    }
    send(response, 404, { error: 'не найдено' })
  }
}

export function createServer({ store, host = '127.0.0.1' }) {
  const server = httpCreateServer(createApp({ store }))
  server.host = host
  return server
}
