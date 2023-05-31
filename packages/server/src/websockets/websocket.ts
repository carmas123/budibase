import { Server } from "socket.io"
import http from "http"
import Koa from "koa"
import Cookies from "cookies"
import { userAgent } from "koa-useragent"
import { auth, redis } from "@budibase/backend-core"
import currentApp from "../middleware/currentapp"
import { createAdapter } from "@socket.io/redis-adapter"
import { Socket } from "socket.io"
import { getSocketPubSubClients } from "../utilities/redis"
import { SocketEvent, SocketSessionTTL } from "@budibase/shared-core"
import { SocketSession } from "@budibase/types"

export class BaseSocket {
  io: Server
  path: string
  redisClient?: redis.Client

  constructor(
    app: Koa,
    server: http.Server,
    path: string = "/",
    additionalMiddlewares?: any[]
  ) {
    this.path = path
    this.io = new Server(server, {
      path,
    })

    // Attach default middlewares
    const authenticate = auth.buildAuthMiddleware([], {
      publicAllowed: true,
    })
    const middlewares = [
      userAgent,
      authenticate,
      currentApp,
      ...(additionalMiddlewares || []),
    ]

    // Apply middlewares
    this.io.use(async (socket, next) => {
      // Build fake koa context
      const res = new http.ServerResponse(socket.request)
      const ctx: any = {
        ...app.createContext(socket.request, res),

        // Additional overrides needed to make our middlewares work with this
        // fake koa context
        cookies: new Cookies(socket.request, res),
        get: (field: string) => socket.request.headers[field],
        throw: (code: number, message: string) => {
          throw new Error(message)
        },

        // Needed for koa-useragent middleware
        headers: socket.request.headers,
        header: socket.request.headers,

        // We don't really care about the path since it will never contain
        // an app ID
        path: "/socket",
      }

      // Run all koa middlewares
      try {
        for (let [idx, middleware] of middlewares.entries()) {
          await middleware(ctx, () => {
            if (idx === middlewares.length - 1) {
              // Middlewares are finished
              // Extract some data from our enriched koa context to persist
              // as metadata for the socket
              const { _id, email, firstName, lastName } = ctx.user
              socket.data = {
                _id,
                email,
                firstName,
                lastName,
                sessionId: socket.id,
              }
              next()
            }
          })
        }
      } catch (error: any) {
        next(error)
      }
    })

    // Initialise redis before handling connections
    this.initialise().then(() => {
      this.io.on("connection", async socket => {
        // Add built in handler for heartbeats
        socket.on(SocketEvent.Heartbeat, async () => {
          console.log(socket.data.email, "heartbeat received")
          await this.extendSessionTTL(socket.data.sessionId)
        })

        // Add early disconnection handler to clean up and leave room
        socket.on("disconnect", async () => {
          // Run any custom disconnection logic before we leave the room,
          // so that we have access to their room etc before disconnection
          await this.onDisconnect(socket)

          // Leave the current room when the user disconnects if we're in one
          await this.leaveRoom(socket)
        })

        // Add handlers for this socket
        await this.onConnect(socket)
      })
    })
  }

  async initialise() {
    // Instantiate redis adapter.
    // We use a fully qualified key name here as this bypasses the normal
    // redis client#s key prefixing.
    const { pub, sub } = getSocketPubSubClients()
    const opts = {
      key: `${redis.utils.Databases.SOCKET_IO}-${this.path}-pubsub`,
    }
    this.io.adapter(createAdapter(pub, sub, opts))

    // Fetch redis client
    this.redisClient = await redis.clients.getSocketClient()
  }

  // Gets the redis key for a certain session ID
  getSessionKey(sessionId: string) {
    return `${this.path}-session:${sessionId}`
  }

  // Gets the redis key for certain room name
  getRoomKey(room: string) {
    return `${this.path}-room:${room}`
  }

  async extendSessionTTL(sessionId: string) {
    const key = this.getSessionKey(sessionId)
    await this.redisClient?.setExpiry(key, SocketSessionTTL)
  }

  // Gets an array of all redis keys of users inside a certain room
  async getRoomSessionIds(room: string): Promise<string[]> {
    const keys = await this.redisClient?.get(this.getRoomKey(room))
    return keys || []
  }

  // Sets the list of redis keys for users inside a certain room.
  // There is no TTL on the actual room key map itself.
  async setRoomSessionIds(room: string, ids: string[]) {
    await this.redisClient?.store(this.getRoomKey(room), ids)
  }

  // Gets a list of all users inside a certain room
  async getRoomSessions(room?: string): Promise<SocketSession[]> {
    if (room) {
      const sessionIds = await this.getRoomSessionIds(room)
      const keys = sessionIds.map(this.getSessionKey.bind(this))
      const sessions = await this.redisClient?.bulkGet(keys)
      return Object.values(sessions || {})
    } else {
      return []
    }
  }

  // Detects keys which have been pruned from redis due to TTL expiry in a certain
  // room and broadcasts disconnection messages to ensure clients are aware
  async pruneRoom(room: string) {
    const sessionIds = await this.getRoomSessionIds(room)
    const sessionsExist = await Promise.all(
      sessionIds.map(id => this.redisClient?.exists(this.getSessionKey(id)))
    )
    const prunedSessionIds = sessionIds.filter((id, idx) => {
      if (!sessionsExist[idx]) {
        this.io.to(room).emit(SocketEvent.UserDisconnect, sessionIds[idx])
        return false
      }
      return true
    })

    // Store new pruned keys
    await this.setRoomSessionIds(room, prunedSessionIds)
  }

  // Adds a user to a certain room
  async joinRoom(socket: Socket, room: string) {
    if (!room) {
      return
    }
    // Prune room before joining
    await this.pruneRoom(room)

    // Check if we're already in a room, as we'll need to leave if we are before we
    // can join a different room
    const oldRoom = socket.data.room
    if (oldRoom && oldRoom !== room) {
      await this.leaveRoom(socket)
    }

    // Join new room
    if (!oldRoom || oldRoom !== room) {
      socket.join(room)
      socket.data.room = room
    }

    // Store in redis
    // @ts-ignore
    let user: SocketSession = socket.data
    const { sessionId } = user
    const key = this.getSessionKey(sessionId)
    await this.redisClient?.store(key, user, SocketSessionTTL)
    const sessionIds = await this.getRoomSessionIds(room)
    if (!sessionIds.includes(sessionId)) {
      await this.setRoomSessionIds(room, [...sessionIds, sessionId])
    }

    // Notify other users
    socket.to(room).emit(SocketEvent.UserUpdate, user)
  }

  // Disconnects a socket from its current room
  async leaveRoom(socket: Socket) {
    // @ts-ignore
    let user: SocketSession = socket.data
    const { room, sessionId } = user
    if (!room) {
      return
    }

    // Leave room
    socket.leave(room)
    socket.data.room = undefined

    // Delete from redis
    const key = this.getSessionKey(sessionId)
    await this.redisClient?.delete(key)
    const sessionIds = await this.getRoomSessionIds(room)
    await this.setRoomSessionIds(
      room,
      sessionIds.filter(id => id !== sessionId)
    )

    // Notify other users
    socket.to(room).emit(SocketEvent.UserDisconnect, sessionId)
  }

  // Updates a connected user's metadata, assuming a room change is not required.
  async updateUser(socket: Socket, patch: Object) {
    socket.data = {
      ...socket.data,
      ...patch,
    }

    // If we're in a room, notify others of this change and update redis
    if (socket.data.room) {
      await this.joinRoom(socket, socket.data.room)
    }
  }

  async onConnect(socket: Socket) {
    // Override
  }

  async onDisconnect(socket: Socket) {
    // Override
  }

  // Emit an event to all sockets
  emit(event: string, payload: any) {
    this.io.sockets.emit(event, payload)
  }
}