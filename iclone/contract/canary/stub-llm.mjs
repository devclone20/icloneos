// OpenAI-compatible stub LLM for the canary (contract decision 13). It replays one scripted tool call per scenario:
// the first completion that offers the scenario's tool and carries no tool result yet gets the call, every other
// completion (titles, the follow-up turn) gets a short text. Loopback only; nothing leaves the machine.
import http from 'node:http'

const MODEL = 'iclone-canary-stub'

function chunk(id, created, delta, finish) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }]
  }
}

function reply(body, script) {
  const tools = (body.tools ?? []).map(t => t?.function?.name).filter(Boolean)
  const answered = (body.messages ?? []).some(m => m?.role === 'tool')
  const step = !answered ? script.find(s => tools.includes(s.toolCall.name)) : undefined

  if (!step) {
    return { kind: 'text', tools, message: { role: 'assistant', content: 'canary: done' }, finish: 'stop' }
  }

  const call = {
    id: `call_canary_${step.id}`,
    type: 'function',
    function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.arguments) }
  }

  return {
    kind: 'tool',
    scenario: step.id,
    tools,
    message: { role: 'assistant', content: null, tool_calls: [call] },
    finish: 'tool_calls'
  }
}

function send(res, body, out) {
  const id = 'chatcmpl-canary'
  const created = Math.floor(Date.now() / 1000)
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }

  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model: MODEL,
        choices: [{ index: 0, message: out.message, finish_reason: out.finish }],
        usage
      })
    )

    return
  }

  const delta = out.message.tool_calls
    ? { role: 'assistant', content: null, tool_calls: out.message.tool_calls.map((c, index) => ({ index, ...c })) }
    : { role: 'assistant', content: out.message.content }

  const frames = [chunk(id, created, delta, null), chunk(id, created, {}, out.finish)]

  if (body.stream_options?.include_usage) {
    frames.push({ id, object: 'chat.completion.chunk', created, model: MODEL, choices: [], usage })
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.end(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n')
}

export async function startStubLlm(script) {
  const calls = []

  const server = http.createServer((req, res) => {
    const parts = []
    req.on('data', d => parts.push(d))
    req.on('end', () => {
      const route = (req.url ?? '').split('?')[0]

      if (req.method === 'GET' && route.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'iclone' }] }))

        return
      }

      if (req.method !== 'POST' || !route.endsWith('/chat/completions')) {
        calls.push({ route, kind: 'unhandled' })
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `canary stub serves chat completions only (${route})` } }))

        return
      }

      let body

      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
      } catch {
        res.writeHead(400).end()

        return
      }

      const out = reply(body, script)
      calls.push({
        route,
        kind: out.kind,
        scenario: out.scenario ?? null,
        stream: !!body.stream,
        tools: out.tools.length
      })
      send(res, body, out)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address()

  return {
    model: MODEL,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
