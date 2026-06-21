declare module 'next/server' {
  export class NextRequest extends Request {
    nextUrl: URL
    cookies: {
      get(name: string): { name: string; value: string } | undefined
      getAll(name?: string): Array<{ name: string; value: string }>
    }
  }

  export class NextResponse extends Response {
    static json(data?: any, init?: ResponseInit): NextResponse
    static redirect(url: string | URL, status?: number): NextResponse
    static next(init?: ResponseInit): NextResponse
  }
}
