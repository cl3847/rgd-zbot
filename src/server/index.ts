#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
import {createServer, getServerPort} from '@devvit/web/server'
import {onReq} from './server.ts'

const server = createServer(onReq)
const port: number = getServerPort()

server.on('error', () =>
  console.error(
    JSON.stringify({
      event: 'server_error',
      stage: 'bootstrap',
      outcome: 'error',
      category: 'internal_error',
      summary: 'Server runtime failure',
    }),
  ),
)
server.listen(port, () => console.log(`http://localhost:${port}`))
