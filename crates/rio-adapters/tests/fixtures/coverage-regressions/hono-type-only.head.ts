export const createMiddleware = <E extends Env = any, P extends string = any, I extends Input = {}>(
  middleware: MiddlewareHandler<E, P, I>
) => createFactory<E, P>().createMiddleware<I>(middleware)
