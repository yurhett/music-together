declare global {
  namespace Express {
    interface Request {
      identityUserId?: string
    }
  }
}

export {}
