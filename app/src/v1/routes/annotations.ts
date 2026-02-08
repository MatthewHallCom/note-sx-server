import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import db from '../Database'

export const router = new Hono()

// SSE subscribers: filename -> set of streams
const subscribers = new Map<string, Set<any>>()

function broadcastEvent(filename: string, event: string, data: any) {
  const subs = subscribers.get(filename)
  if (!subs) return
  for (const stream of subs) {
    stream.writeSSE({
      data: JSON.stringify(data),
      event: event,
      id: String(Date.now())
    }).catch(() => {
      // Stream may be closed, will be cleaned up on abort
    })
  }
}

const FILENAME_RE = /^[a-z0-9]{1,32}$/

function sanitize(str: string, maxLen: number): string {
  if (typeof str !== 'string') return ''
  return str.replace(/<[^>]*>/g, '').slice(0, maxLen)
}

router
  // SSE endpoint - MUST be before the GET /:filename route
  .get('/:filename/events', (c) => {
    const filename = c.req.param('filename')

    if (!FILENAME_RE.test(filename)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }

    return streamSSE(c, async (stream) => {
      // Register this stream as a subscriber
      if (!subscribers.has(filename)) {
        subscribers.set(filename, new Set())
      }
      subscribers.get(filename)!.add(stream)

      // Clean up on abort
      c.req.raw.signal.addEventListener('abort', () => {
        const subs = subscribers.get(filename)
        if (subs) {
          subs.delete(stream)
          if (subs.size === 0) {
            subscribers.delete(filename)
          }
        }
      })

      // Keepalive loop
      while (true) {
        await stream.sleep(30000)
      }
    })
  })

  .get('/:filename', (c) => {
    const filename = c.req.param('filename')

    if (!FILENAME_RE.test(filename)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }

    const annotations = db
      .prepare('SELECT * FROM annotations WHERE note_filename = ? ORDER BY created ASC')
      .all(filename)

    // Attach replies to each annotation
    const withReplies = annotations.map((a: any) => {
      const replies = db
        .prepare('SELECT * FROM annotation_replies WHERE annotation_id = ? ORDER BY created ASC')
        .all(a.id)
      return { ...a, replies }
    })

    return c.json({ annotations: withReplies })
  })

  .post('/:filename', async (c) => {
    const filename = c.req.param('filename')

    if (!FILENAME_RE.test(filename)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }

    // Read JSON body manually
    const text = await c.req.text()
    let body
    try {
      body = JSON.parse(text)
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    // Validate required fields
    if (!body.type || !['comment', 'suggestion', 'deletion'].includes(body.type)) {
      return c.json({ error: 'Invalid or missing type' }, 400)
    }

    if (!body.quote || typeof body.quote !== 'string' || body.quote.trim() === '') {
      return c.json({ error: 'Invalid or missing quote' }, 400)
    }

    // Sanitize and validate fields
    const quote = sanitize(body.quote, 1000)
    const prefix = sanitize(body.prefix || '', 1000)
    const suffix = sanitize(body.suffix || '', 1000)
    const annotationBody = body.body ? sanitize(body.body, 5000) : null
    const authorName = sanitize(body.author_name || 'Anonymous', 50)
    const quoteOffset = typeof body.quote_offset === 'number' ? body.quote_offset : null

    // Insert into database
    const result = db
      .prepare(
        `INSERT INTO annotations (note_filename, type, quote, prefix, suffix, body, author_name, quote_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(filename, body.type, quote, prefix, suffix, annotationBody, authorName, quoteOffset)

    // Fetch the created annotation
    const annotation = db
      .prepare('SELECT * FROM annotations WHERE id = ?')
      .get(result.lastInsertRowid)

    // Broadcast to SSE subscribers
    broadcastEvent(filename, 'new-annotation', annotation)

    return c.json({ annotation }, 201)
  })

  .post('/:filename/:id/replies', async (c) => {
    const filename = c.req.param('filename')
    const id = c.req.param('id')

    if (!FILENAME_RE.test(filename)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }

    const annotationId = parseInt(id, 10)
    if (isNaN(annotationId)) {
      return c.json({ error: 'Invalid annotation ID' }, 400)
    }

    // Check annotation exists and belongs to this note
    const annotation = db
      .prepare('SELECT * FROM annotations WHERE id = ? AND note_filename = ?')
      .get(annotationId, filename)

    if (!annotation) {
      return c.json({ error: 'Annotation not found' }, 404)
    }

    const text = await c.req.text()
    let body
    try {
      body = JSON.parse(text)
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    if (!body.body || typeof body.body !== 'string' || body.body.trim() === '') {
      return c.json({ error: 'Reply body is required' }, 400)
    }

    const replyBody = sanitize(body.body, 5000)
    const authorName = sanitize(body.author_name || 'Anonymous', 50)

    const result = db
      .prepare('INSERT INTO annotation_replies (annotation_id, body, author_name) VALUES (?, ?, ?)')
      .run(annotationId, replyBody, authorName)

    const reply = db
      .prepare('SELECT * FROM annotation_replies WHERE id = ?')
      .get(result.lastInsertRowid)

    // Broadcast reply via SSE
    broadcastEvent(filename, 'new-reply', { annotation_id: annotationId, reply })

    return c.json({ reply }, 201)
  })

  .delete('/:filename/:id', (c) => {
    const filename = c.req.param('filename')
    const id = c.req.param('id')

    if (!FILENAME_RE.test(filename)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }

    const annotationId = parseInt(id, 10)
    if (isNaN(annotationId)) {
      return c.json({ error: 'Invalid annotation ID' }, 400)
    }

    // Check if annotation exists
    const annotation = db
      .prepare('SELECT * FROM annotations WHERE id = ? AND note_filename = ?')
      .get(annotationId, filename)

    if (!annotation) {
      return c.json({ error: 'Annotation not found' }, 404)
    }

    // Delete the annotation
    db.prepare('DELETE FROM annotations WHERE id = ?').run(annotationId)

    // Broadcast deletion to SSE subscribers
    broadcastEvent(filename, 'delete-annotation', { id: annotationId })

    return c.json({ success: true })
  })
